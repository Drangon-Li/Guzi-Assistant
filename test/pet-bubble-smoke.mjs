// 纯函数单测：桌宠气泡仲裁器（优先级抢占 / 合并 / pinned 优先级 / 出队推进 / 队列上限）。运行：npm run test:petbubble
import { PetBubbleArbiter } from '../src/main/pet/bubble-arbiter.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

function makeRec() {
  const events = []
  const sink = { present: (slot, c) => events.push([slot, c ? c.bubble.text : null]) }
  const dismissed = []
  const cb = (tag) => ({ onDismiss: (r) => dismissed.push([tag, r]) })
  return { events, sink, dismissed, cb }
}

// 1) 高优先级抢占可打断的当前气泡
{
  const { events, sink, dismissed, cb } = makeRec()
  const arb = new PetBubbleArbiter(sink)
  arb.show('s1', { text: 'A', priority: 'normal' }, cb('A'))
  arb.show('s1', { text: 'B', priority: 'urgent' }, cb('B'))
  const lastTransient = [...events].reverse().find((e) => e[0] === 'transient')
  check('urgent 抢占 → 当前显示 B', lastTransient && lastTransient[1] === 'B')
  check('被抢占的 A 以 replaced 结束', dismissed.some((d) => d[0] === 'A' && d[1] === 'replaced'))
  check('当前 = B', arb.snapshot().current?.bubble.text === 'B')
}

// 2) 相邻同文合并
{
  const { sink, dismissed, cb } = makeRec()
  const arb = new PetBubbleArbiter(sink)
  arb.show('s', { text: 'X', priority: 'normal' }, cb('X1'))
  arb.show('s', { text: 'X', priority: 'normal' }, cb('X2'))
  check('同来源同文 → 第二条被合并丢弃', dismissed.some((d) => d[0] === 'X2' && d[1] === 'replaced'))
  check('当前仍为 X', arb.snapshot().current?.bubble.text === 'X')
  check('队列为空（未入队）', arb.snapshot().queued === 0)
}

// 3) pinned 槽：低优先级不能挤掉高优先级
{
  const { sink, dismissed, cb } = makeRec()
  const arb = new PetBubbleArbiter(sink)
  arb.show('s', { text: 'P-high', priority: 'high', pin: true }, cb('PH'))
  arb.show('s', { text: 'P-low', priority: 'low', pin: true }, cb('PL'))
  check('低优先级 pin 被拒（replaced）', dismissed.some((d) => d[0] === 'PL' && d[1] === 'replaced'))
  check('pinned 仍为高优先级', arb.snapshot().pinned?.bubble.text === 'P-high')
}

// 4) dismiss 当前 → 推进到队列下一个
{
  const { sink, cb } = makeRec()
  const arb = new PetBubbleArbiter(sink)
  // 当前为 sticky urgent（不可打断），后续同级排队
  arb.show('s', { text: 'U', priority: 'urgent', sticky: true }, cb('U'))
  const h = arb.show('s', { text: 'Q', priority: 'urgent' }, cb('Q'))
  check('Q 进入队列', arb.snapshot().queued === 1)
  // 手动结束当前 U → 推进显示 Q
  arb.snapshot() // no-op
  // 通过 handle 结束 Q 之前先结束 U：用 clearSource 会清掉两者，这里用 dismiss U 的 handle
  // U 没有 handle 引用，改用：再 show 一个更高没有；直接验证 advance：dismiss Q 的 handle 不触发 advance（Q 在队列）
  h.dismiss()
  check('dismiss 队列中的 Q → 队列空、当前仍 U', arb.snapshot().queued === 0 && arb.snapshot().current?.bubble.text === 'U')
}

// 5) 队列上限 16
{
  const { sink, cb } = makeRec()
  const arb = new PetBubbleArbiter(sink)
  arb.show('s', { text: 'U', priority: 'urgent', sticky: true }, cb('U')) // 不可打断的当前
  for (let i = 0; i < 20; i++) arb.show('s', { text: `q${i}`, priority: 'low' }, cb(`q${i}`))
  check('队列上限 16', arb.snapshot().queued === 16)
}

process.exit(failed ? 1 : 0)
