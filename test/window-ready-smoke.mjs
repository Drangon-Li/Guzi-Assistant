// 渲染层就绪握手：渲染层挂好订阅之前推的消息必须排队、按序补发，页面重载后重新等待。
// Run: node test/window-ready-smoke.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { markWindowReady, trackWindowReadiness, whenWindowReady } from '../src/main/window-ready.ts'

const fakeWindow = () => {
  const webContents = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed } })
  return { webContents }
}

{
  const win = fakeWindow()
  trackWindowReadiness(win)
  const sent = []
  whenWindowReady(win, () => sent.push('busy'))
  whenWindowReady(win, () => sent.push('result'))
  assert.deepEqual(sent, [], '就绪前不能推')
  markWindowReady(win.webContents)
  assert.deepEqual(sent, ['busy', 'result'], '就绪后按入队顺序补发')
  whenWindowReady(win, () => sent.push('later'))
  assert.deepEqual(sent, ['busy', 'result', 'later'], '已就绪的窗口立即执行')
  markWindowReady(win.webContents)
  assert.equal(sent.length, 3, '重复 ready 不会重放已发过的消息')
  console.log('✓ 就绪前排队、就绪后按序补发，之后立即送达且不重放')
}

{
  const win = fakeWindow()
  trackWindowReadiness(win)
  markWindowReady(win.webContents)
  win.webContents.emit('did-start-loading')
  const sent = []
  whenWindowReady(win, () => sent.push('after-reload'))
  assert.deepEqual(sent, [], '重载后旧订阅已失效，要等新的 ready')
  markWindowReady(win.webContents)
  assert.deepEqual(sent, ['after-reload'])
  console.log('✓ 页面重载后重新等待 ready')
}

{
  const win = fakeWindow()
  trackWindowReadiness(win)
  const sent = []
  whenWindowReady(win, () => sent.push('never'))
  win.webContents.destroyed = true
  markWindowReady(win.webContents)
  assert.deepEqual(sent, [], '窗口已销毁就不再推')
  console.log('✓ 窗口在就绪前被销毁时丢弃排队消息')
}

{
  const a = fakeWindow()
  const b = fakeWindow()
  trackWindowReadiness(a)
  trackWindowReadiness(b)
  const sent = []
  whenWindowReady(a, () => sent.push('a'))
  whenWindowReady(b, () => sent.push('b'))
  markWindowReady(b.webContents)
  assert.deepEqual(sent, ['b'], '各窗口的队列互不影响')
  console.log('✓ 不同窗口的就绪状态互相独立')
}

console.log('\nAll window-ready tests passed')
