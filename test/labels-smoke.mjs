// 纯函数单测：倒计时/日期展示（锁 QA §18「已超期/病句」修复）。运行：npm run test:labels
import { countdownLabel, daysUntil, dayKey, fmtTime, formatHotkey } from '../src/renderer/src/labels.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- daysUntil / countdownLabel：用绝对的过去/远期日期，结果与「今天」无关 ----
check('过去日期 daysUntil 为负', daysUntil('2000-01-01T00:00') < 0)
check('远期日期 daysUntil 为正且很大', daysUntil('2099-12-31T00:00') > 1000)
check('过去 → 已超期 N 天', /^已超期 \d+ 天$/.test(countdownLabel('2000-01-01T00:00')))
check('远期 → 还有 N 天', /^还有 \d+ 天$/.test(countdownLabel('2099-12-31T00:00')))

// 明天：相对 now 构造（now+1 天恒为 +1 自然日，无午夜 flake）
const tm = new Date(Date.now() + 86400000)
const p = (n) => String(n).padStart(2, '0')
const tomorrowNoon = `${tm.getFullYear()}-${p(tm.getMonth() + 1)}-${p(tm.getDate())}T12:00`
check('明天 → 「明天」', countdownLabel(tomorrowNoon) === '明天')

// ---- dayKey ----
check('dayKey 取前 10 位', dayKey('2026-06-20T18:00') === '2026-06-20')
check('dayKey 空值 → null', dayKey(null) === null && dayKey('') === null)

// ---- fmtTime ----
check('fmtTime 跨年含年份', fmtTime('2000-03-05T09:08').startsWith('2000年3月5日 09:08'))
check('fmtTime 空值 → 空串', fmtTime(null) === '' && fmtTime(undefined) === '')
check('fmtTime 非法时间原样返回', fmtTime('不是时间') === '不是时间')

// ---- formatHotkey ----
check('快捷键符号化', formatHotkey('CommandOrControl+Shift+K') === '⌘ ⇧ K')
check('未知键原样保留', formatHotkey('Alt+C') === '⌥ C')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
