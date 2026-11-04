// 渲染层就绪握手。
//
// 主进程往窗口推消息（预览卡内容、提醒、桌宠对话注入、导航…）时，渲染层的订阅是在 React
// effect 里异步挂上的：did-finish-load 并不代表组件已经在听，此刻 send 的消息会直接丢掉。
// 以前只能靠「启动时预建窗口、等它早早加载完」来躲这个竞态，几个常驻窗口各占一个渲染进程。
//
// 现在由渲染层在挂好订阅后调用 window:ready，主进程把在那之前要推的消息排队、就绪后按序补发。
// 窗口因此可以按需创建、用完销毁，不必为了不丢消息而一直开着。
import type { BrowserWindow, WebContents } from 'electron'

const ready = new WeakSet<WebContents>()
const pending = new WeakMap<WebContents, (() => void)[]>()

/** load() 时调用：每次（重新）开始加载页面，之前的订阅都没了，要等下一次 ready */
export function trackWindowReadiness(win: BrowserWindow): void {
  const contents = win.webContents
  contents.on('did-start-loading', () => ready.delete(contents))
}

/** 渲染层 window:ready 的处理：标记就绪并补发排队的消息 */
export function markWindowReady(contents: WebContents): void {
  ready.add(contents)
  const queued = pending.get(contents)
  pending.delete(contents)
  for (const run of queued ?? []) if (!contents.isDestroyed()) run()
}

/** 渲染层已就绪就立刻执行，否则排队到就绪时执行（窗口先被销毁则不执行） */
export function whenWindowReady(win: BrowserWindow, run: () => void): void {
  const contents = win.webContents
  if (ready.has(contents)) {
    run()
    return
  }
  const queued = pending.get(contents) ?? []
  queued.push(run)
  pending.set(contents, queued)
}
