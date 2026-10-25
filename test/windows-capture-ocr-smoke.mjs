import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { selectionRect, thumbnailCrop } from '../src/main/platform/capture-geometry.ts'
import { normalizeOcrResult } from '../src/main/platform/windows-ocr-result.ts'
import { waitForOcrChild } from '../src/main/platform/windows-ocr-process.ts'
import { beginContentReset, captureContentEpoch } from '../src/main/content-lifecycle.ts'

const selected = selectionRect({ x: -100, y: 80 }, { x: 100, y: 280 })
assert.deepEqual(thumbnailCrop(selected, { x: -1280, y: 0, width: 1280, height: 720 }, { width: 1920, height: 1080 }),
  { x: 1770, y: 120, width: 150, height: 300 })
assert.deepEqual(thumbnailCrop(selected, { x: 0, y: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
  { x: 0, y: 80, width: 100, height: 200 })
console.log('✓ 负坐标副屏、150%/100% 缩放跨屏裁剪')

const result = { resizedImageWidth: 1024, resizedImageHeight: 512, texts: [
  { text: '你好 Hello', box: [[256, 128], [768, 128], [768, 256], [256, 256]] },
  { text: '边界', box: [[-10, 480], [1024, 480], [1024, 544], [-10, 544]] },
  { text: 'invalid', box: [[NaN, 0], [5, 0], [5, 5], [0, 5]] }
] }
assert.deepEqual(normalizeOcrResult(result), [
  { text: '你好 Hello', x: .25, y: .25, w: .5, h: .25 },
  { text: '边界', x: 0, y: .9375, w: 1, h: .0625 }
])
assert.throws(() => normalizeOcrResult({ ...result, resizedImageWidth: 0 }), /格式无效/)
const tilted = normalizeOcrResult({ resizedImageWidth: 1120, resizedImageHeight: 384,
  texts: [{ text: '谷子助手Windows12345', box: [[36, 61], [601, 60], [601, 104], [36, 105]] }] })[0]
assert.equal(tilted.x, 36 / 1120)
assert.equal(tilted.y, 60 / 384)
assert.equal(tilted.h, 105 / 384 - 60 / 384)
class FakeChild extends EventEmitter {
  kills = 0
  kill() { this.kills++; queueMicrotask(() => this.emit('close', null)); return true }
}
const success = new FakeChild()
const recognized = waitForOcrChild(success)
success.emit('message', { result })
assert.equal(await recognized, result)
assert.equal(success.kills, 1)
assert.equal(success.listenerCount('message'), 0)
const aborted = new FakeChild(), controller = new AbortController()
const pending = waitForOcrChild(aborted, controller.signal)
controller.abort()
await assert.rejects(pending, { name: 'AbortError' })
assert.equal(aborted.kills, 1)
const timed = new FakeChild()
await assert.rejects(waitForOcrChild(timed, undefined, 5), /超时/)
assert.equal(timed.kills, 1)
const early = new FakeChild()
const exited = waitForOcrChild(early)
early.emit('close', 1)
await assert.rejects(exited, /意外退出/)
console.log('✓ OCR 用缩放后图像归一化左上坐标；成功/取消/超时清理进程及监听器')

const directory = await mkdtemp(join(tmpdir(), 'guzi-windows-capture-'))
const fixture = { directory, windows: [], cursor: { x: -100, y: 80 }, calls: [], nativeCalls: [], sources: [], crops: [] }
globalThis.__windowsCapture = fixture
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/platform/windows-capture.ts') && specifier === './windows-helper.ts') {
      return { url: 'windows-capture:helper', shortCircuit: true }
    }
    if (context.parentURL?.endsWith('/platform/windows-capture.ts') && specifier === 'electron') {
      return { url: 'windows-capture:electron', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'windows-capture:helper') return { format: 'module', shortCircuit: true, source: `
      import {writeFile} from 'node:fs/promises';const f=globalThis.__windowsCapture;
      export async function execWindowsHelper(args,options){f.nativeCalls.push({args,options});await writeFile(args[2],'window-png');await f.onNative?.();if(f.nativeError)throw Error('native capture failed');return JSON.stringify({path:args[2]})}
    ` }
    if (url === 'windows-capture:electron') return { format: 'module', shortCircuit: true, source: `
      import {EventEmitter} from 'node:events';const f=globalThis.__windowsCapture;
      export const app={isPackaged:false,getAppPath:()=>f.directory};
      export const ipcMain=new EventEmitter();ipcMain.handlers=new Map();ipcMain.handle=(k,v)=>ipcMain.handlers.set(k,v);ipcMain.removeHandler=k=>ipcMain.handlers.delete(k);f.ipc=ipcMain;
      export const screen=new EventEmitter();screen.getAllDisplays=()=>[{id:1,bounds:{x:-1280,y:0,width:1280,height:720},scaleFactor:1.5},{id:2,bounds:{x:0,y:0,width:1920,height:1080},scaleFactor:1}];screen.getCursorScreenPoint=()=>({...f.cursor});screen.getDisplayNearestPoint=()=>({id:1});f.screen=screen;
      export const desktopCapturer={getSources:async(options)=>{f.calls.push(options);await f.onSources?.();return f.sources}};
      class Image { constructor(width,height,color=30){this.width=width;this.height=height;this.color=color}isEmpty(){return false}getSize(){return {width:this.width,height:this.height}}toDataURL(){return 'data:image/png;base64,AA=='}toPNG(){return Buffer.from('window-png')}crop(rect){f.crops.push(rect);return new Image(rect.width,rect.height,this.color)}resize({width,height}){return new Image(width,height,this.color)}toBitmap(){return Buffer.alloc(this.width*this.height*4,this.color)}}f.Image=Image;
      export const nativeImage={createFromBitmap:(pixels,size)=>{f.composite={pixels,size};return new Image(size.width,size.height)}};
      export class BrowserWindow extends EventEmitter { static fromWebContents(contents){return contents.window} constructor(options){super();this.id=f.windows.length+1;this.options=options;this.webContents=new EventEmitter();this.webContents.window=this;this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};this.webContents.send=()=>{};f.windows.push(this)}isDestroyed(){return !!this.destroyed}destroy(){this.destroyed=true;this.emit('closed')}setAlwaysOnTop(){}setMenu(){}setBounds(){}showInactive(){this.shown=true}focus(){}loadFile(){queueMicrotask(()=>ipcMain.emit('guzi:capture:action',{sender:this.webContents,senderFrame:this.webContents.mainFrame},'ready'));return Promise.resolve()}}
    ` }
    if (url.endsWith('/platform/windows-capture.ts')) {
      const loaded = next(url, context)
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(String(loaded.source), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
      }).outputText }
    }
    return next(url, context)
  }
})
try {
  const { captureWindowsWindow, takeWindowsScreenshot } = await import('../src/main/platform/windows-capture.ts')
  const image = () => new fixture.Image(1920, 1080)
  for (const id of [0, -1, NaN, 9007199254740992]) {
    await assert.rejects(captureWindowsWindow(id, join(directory, 'wrong.png')), /窗口身份/)
  }
  assert.equal(fixture.nativeCalls.length, 0)
  assert.deepEqual(await readdir(directory), [])
  const file = join(directory, 'exact.png')
  assert.equal(await captureWindowsWindow(123, file), file)
  assert.equal(await readFile(file, 'utf8'), 'window-png')
  assert.deepEqual(fixture.nativeCalls[0].args, ['capture-window', '123', file])
  assert.equal(fixture.nativeCalls[0].options.timeout, 5000)
  assert.equal(fixture.calls.length, 0, 'passive capture must never enumerate desktopCapturer thumbnails')
  const cancelCapture = new AbortController()
  fixture.onNative = () => cancelCapture.abort()
  await assert.rejects(captureWindowsWindow(123, join(directory, 'aborted.png'), cancelCapture.signal), { name: 'AbortError' })
  assert.deepEqual(await readdir(directory), ['exact.png'])
  fixture.onNative = null
  fixture.nativeError = true
  await assert.rejects(captureWindowsWindow(123, join(directory, 'failed.png')), /native capture failed/)
  assert.deepEqual(await readdir(directory), ['exact.png'])
  fixture.nativeError = false
  fixture.sources = [{ display_id: '1', thumbnail: image() }, { display_id: '2', thumbnail: image() }]
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const action = (value) => {
    const sender = fixture.windows.at(-1).webContents
    fixture.ipc.emit('guzi:capture:action', { sender, senderFrame: sender.mainFrame }, value)
  }
  const manual = takeWindowsScreenshot(captureContentEpoch())
  await tick()
  assert.equal(fixture.windows.filter(window => window.shown).length, 2)
  action('start')
  fixture.cursor = { x: 100, y: 280 }
  action('finish')
  assert.ok(await manual)
  assert.deepEqual(fixture.crops, [{ x: 1770, y: 120, width: 150, height: 300 }, { x: 0, y: 80, width: 100, height: 200 }])
  assert.deepEqual(fixture.composite.size, { width: 300, height: 300, scaleFactor: 1 })
  assert.ok(fixture.windows.every(window => window.destroyed))
  assert.equal(fixture.ipc.listenerCount('guzi:capture:action'), 0)
  assert.equal(fixture.ipc.handlers.size, 0)
  assert.equal(fixture.screen.listenerCount('display-removed'), 0)
  const escaped = takeWindowsScreenshot(captureContentEpoch())
  await tick()
  fixture.windows.at(-1).webContents.emit('before-input-event', {}, { key: 'Escape' })
  assert.equal(await escaped, null)
  assert.ok(fixture.windows.every(window => window.destroyed))
  const reset = takeWindowsScreenshot(captureContentEpoch())
  await tick()
  const done = beginContentReset()
  const rejection = assert.rejects(reset, /已清除/)
  action('cancel')
  await rejection
  done()
  assert.ok(fixture.windows.every(window => window.destroyed))
  console.log('✓ Windows 实际适配器 mock：被动截图只调用精确 HWND 原生命令、取消/失败清理文件、跨屏合成、Esc/清空销毁全部遮罩')
} finally {
  hook.deregister()
  delete globalThis.__windowsCapture
  await rm(directory, { recursive: true, force: true })
}
