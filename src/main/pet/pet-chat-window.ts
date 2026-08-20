// 桌宠对话框窗口 —— 无边框透明置顶小窗，加载渲染层 #/petchat（复用 React AssistantChat）。
// 点桌宠开/关，定位到桌宠旁，可获键盘焦点打字；失焦/Esc/再点桌宠 收起。
import { BrowserWindow, ipcMain, screen } from 'electron'
import { anchorWindowNearPet, load, preload } from '../windows'
import { extractPetDropText, submitExternalFiles } from '../capture'

const CHAT_W = 380
const CHAT_H = 520

let chatWin: BrowserWindow | null = null
let lastHiddenAt = 0

function ensureWindow(): BrowserWindow {
  if (chatWin && !chatWin.isDestroyed()) return chatWin
  const win = new BrowserWindow({
    width: CHAT_W,
    height: CHAT_H,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 失焦自动收起（点别处即关）。
  win.on('blur', () => {
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
      chatWin.hide()
      lastHiddenAt = Date.now()
    }
  })
  win.on('closed', () => {
    if (chatWin === win) chatWin = null
  })
  load(win, '/petchat')
  chatWin = win
  return win
}

/** 把对话框定位到桌宠图标旁（与预览卡共用 anchorWindowNearPet）；桌宠不可见时回退右下角。 */
function positionNextToPet(win: BrowserWindow): void {
  if (anchorWindowNearPet(win, CHAT_W, CHAT_H)) return
  const wa = screen.getPrimaryDisplay().workArea
  win.setPosition(wa.x + wa.width - CHAT_W - 24, wa.y + wa.height - CHAT_H - 24, false)
}

/** 启动时预创建对话窗口（隐藏）：避免首次拖文件/点击时还在加载，且开窗更快。 */
export function createPetChatWindow(): void {
  ensureWindow()
}

export function showPetChat(): void {
  const win = ensureWindow()
  positionNextToPet(win)
  win.show()
  win.focus()
}

export function hidePetChat(): void {
  if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
    chatWin.hide()
    lastHiddenAt = Date.now()
  }
}

export function isPetChatVisible(): boolean {
  return !!chatWin && !chatWin.isDestroyed() && chatWin.isVisible()
}

/**
 * 点桌宠开/关。点桌宠会先让对话框失焦→立即 hide，本次点击应视为「关闭」不重开。
 * 桌宠单击经 ~280ms 双击消歧延迟才到（见 pet-preload DBLCLICK_WINDOW_MS），故守卫窗口须 > 该延迟。
 */
export function togglePetChat(): void {
  if (isPetChatVisible()) {
    hidePetChat()
    return
  }
  if (Date.now() - lastHiddenAt < 450) return
  showPetChat()
}

// 拖动桌宠时收起对话框，避免位置漂移（与 pet-window 解耦：独立监听同一信号）。
ipcMain.on('openpets:pet-drag-start', () => hidePetChat())

// 拖文件到桌宠：可抽文本的(txt/md/pdf/docx) → 打开对话框让助手总结+找日程；其余(图片等) → 回退现有捕获管线。
ipcMain.on('openpets:pet-drop-files', (_e, paths: string[]) => {
  if (!Array.isArray(paths) || paths.length === 0) return
  void handlePetDrop(paths)
})

async function handlePetDrop(paths: string[]): Promise<void> {
  const extracted = await extractPetDropText(paths[0])
  if (!extracted) {
    void submitExternalFiles(paths) // 图片/无文本：走现有管线（结果卡会贴在桌宠旁）
    return
  }
  const content = `请先用一句话总结这个文件的内容，然后从中找出可能属于我的日程或待办（如有），按候选列出让我确认；没有就说明没有。\n\n文件名：${extracted.name}\n文件内容：\n${extracted.text}`
  injectPetChat({ display: `📎 拖入文件：${extracted.name}`, content })
}

/** 打开对话框并注入一条用户消息（窗口未加载完则等 load 再送）。 */
function injectPetChat(payload: { display: string; content: string }): void {
  showPetChat()
  const win = ensureWindow()
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => win.webContents.send('guzi-assistant:pet-chat-drop', payload))
  } else {
    win.webContents.send('guzi-assistant:pet-chat-drop', payload)
  }
}
