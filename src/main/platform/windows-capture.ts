import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } from 'electron'
import type { NativeImage, IpcMainEvent, SourcesOptions, DesktopCapturerSource } from 'electron'
import { stat, unlink } from 'fs/promises'
import { join } from 'path'
import { assertContentEpoch, isContentEpochCurrent } from '../content-lifecycle.ts'
import { intersectRect, selectionRect, thumbnailCrop, type CaptureRect } from './capture-geometry.ts'

function captureResource(name: string): string {
  return join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'capture', name)
}

function captureSources(options: SourcesOptions, signal?: AbortSignal): Promise<DesktopCapturerSource[]> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(signal?.reason) }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('读取屏幕截图超时，请重试')) }, 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    void desktopCapturer.getSources(options).then(
      (sources) => { cleanup(); resolve(sources) },
      (error) => { cleanup(); reject(error) }
    )
  })
}

/** PrintWindow receives only the verified HWND; never enumerate background-window thumbnails. */
export async function captureWindowsWindow(windowId: number, file: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('无法确定前台窗口身份，已暂停截图')
  try {
    const { execWindowsHelper } = await import('./windows-helper.ts')
    signal?.throwIfAborted()
    await execWindowsHelper(['capture-window', String(windowId), file], { signal, timeout: 5_000 })
    signal?.throwIfAborted()
    if (!(await stat(file)).size) throw new Error('无法读取已验证的前台窗口截图，已暂停截图')
    return file
  } catch (error) {
    await unlink(file).catch(() => {})
    throw error
  }
}

interface DisplayCapture { id: number; bounds: CaptureRect; image: NativeImage; scaleFactor: number }

function compositeSelection(selected: CaptureRect, captures: DisplayCapture[]): NativeImage {
  const scale = Math.min(Math.max(...captures.map((capture) => capture.scaleFactor)), 1600 / selected.width, 1600 / selected.height)
  const width = Math.max(1, Math.round(selected.width * scale)), height = Math.max(1, Math.round(selected.height * scale))
  const pixels = Buffer.alloc(width * height * 4)
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255
  for (const capture of captures) {
    const overlap = intersectRect(selected, capture.bounds)
    const crop = thumbnailCrop(selected, capture.bounds, capture.image.getSize())
    if (!overlap || !crop || crop.width < 1 || crop.height < 1) continue
    const x = Math.round((overlap.x - selected.x) * scale), y = Math.round((overlap.y - selected.y) * scale)
    const right = Math.round((overlap.x + overlap.width - selected.x) * scale)
    const bottom = Math.round((overlap.y + overlap.height - selected.y) * scale)
    const partWidth = right - x, partHeight = bottom - y
    if (partWidth < 1 || partHeight < 1) continue
    const bitmap = capture.image.crop(crop).resize({ width: partWidth, height: partHeight }).toBitmap()
    for (let row = 0; row < partHeight; row++) {
      bitmap.copy(pixels, ((y + row) * width + x) * 4, row * partWidth * 4, (row + 1) * partWidth * 4)
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 })
}

let selecting = false

export async function takeWindowsScreenshot(epoch: number): Promise<NativeImage | null> {
  if (selecting) return null
  selecting = true
  try {
    const displays = screen.getAllDisplays()
    const sources = await captureSources({ types: ['screen'], fetchWindowIcons: false, thumbnailSize: {
      width: Math.max(...displays.map((display) => Math.ceil(display.bounds.width * display.scaleFactor))),
      height: Math.max(...displays.map((display) => Math.ceil(display.bounds.height * display.scaleFactor)))
    } })
    assertContentEpoch(epoch)
    const captures = displays.map((display): DisplayCapture => {
      const source = sources.find((candidate) => candidate.display_id === String(display.id))
      if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取显示器截图，请重试')
      return { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, image: source.thumbnail }
    })
    return await new Promise<NativeImage | null>((resolve, reject) => {
      const windows = new Map<BrowserWindow, DisplayCapture>()
      const ready = new Set<number>()
      let anchor: { x: number; y: number } | null = null
      let settled = false
      const finish = (selected: CaptureRect | null, error?: unknown): void => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(timeout)
        ipcMain.removeHandler('guzi:capture:init')
        ipcMain.removeListener('guzi:capture:action', action)
        screen.removeListener('display-removed', cancel)
        screen.removeListener('display-metrics-changed', cancel)
        for (const window of windows.keys()) if (!window.isDestroyed()) window.destroy()
        try {
          if (error) reject(error)
          else {
            assertContentEpoch(epoch)
            resolve(selected && selected.width >= 2 && selected.height >= 2 ? compositeSelection(selected, captures) : null)
          }
        } catch (failure) { reject(failure) }
      }
      const cancel = (): void => finish(null)
      const action = (event: IpcMainEvent, value: unknown): void => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window || !windows.has(window) || event.senderFrame !== event.sender.mainFrame) return
        if (value === 'cancel') return cancel()
        if (value === 'ready') {
          ready.add(window.id)
          if (ready.size === captures.length) {
            if (!isContentEpochCurrent(epoch)) return cancel()
            for (const overlay of windows.keys()) overlay.showInactive()
            const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
            ;[...windows].find(([, capture]) => capture.id === display.id)?.[0].focus()
          }
        }
        if (value === 'start' && ready.size === captures.length) anchor = screen.getCursorScreenPoint()
        if (value === 'finish' && anchor) finish(selectionRect(anchor, screen.getCursorScreenPoint()))
      }
      ipcMain.handle('guzi:capture:init', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error('无效截图窗口')
        const capture = windows.get(window)
        if (!capture) throw new Error('无效截图窗口')
        return capture.image.toDataURL()
      })
      ipcMain.on('guzi:capture:action', action)
      screen.on('display-removed', cancel)
      screen.on('display-metrics-changed', cancel)
      const poll = setInterval(() => {
        if (!isContentEpochCurrent(epoch)) return cancel()
        if (!anchor) return
        const selected = selectionRect(anchor, screen.getCursorScreenPoint())
        for (const [window, capture] of windows) {
          if (!window.isDestroyed()) window.webContents.send('guzi:capture:selection', { ...selected, x: selected.x - capture.bounds.x, y: selected.y - capture.bounds.y })
        }
      }, 16)
      const timeout = setTimeout(cancel, 120_000)
      try {
        for (const capture of captures) {
          const window = new BrowserWindow({
            ...capture.bounds, show: false, frame: false, transparent: false, backgroundColor: '#151515',
            resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true,
            hasShadow: false, roundedCorners: false, thickFrame: false, enableLargerThanScreen: true,
            webPreferences: { preload: captureResource('preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
          })
          windows.set(window, capture)
          window.setAlwaysOnTop(true, 'screen-saver')
          window.setMenu(null)
          window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          window.webContents.on('will-navigate', (event) => event.preventDefault())
          window.webContents.on('before-input-event', (_event, input) => { if (input.key === 'Escape') cancel() })
          window.webContents.on('render-process-gone', cancel)
          window.on('closed', cancel)
          void window.loadFile(captureResource('overlay.html')).catch((error) => finish(null, error))
          window.setBounds(capture.bounds)
        }
      } catch (error) { finish(null, error) }
    })
  } finally { selecting = false }
}
