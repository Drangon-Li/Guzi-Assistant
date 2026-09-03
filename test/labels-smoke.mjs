// 纯函数单测：倒计时/日期展示（锁 QA §18「已超期/病句」修复）。运行：npm run test:labels
import {
  countdownLabel,
  daysUntil,
  dayKey,
  fillFromPlaceholder,
  fmtTime,
  formatHotkey,
  placeholderExample
} from '../src/renderer/src/labels.ts'

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

// ---- Tab 补全 ----
check('剥掉「如：」前缀', placeholderExample('如：北京中关村学院') === '北京中关村学院')
check('半角冒号也剥', placeholderExample('如: lisi2024') === 'lisi2024')
check('没有前缀的原样返回', placeholderExample('北京中关村学院') === '北京中关村学院')
check('句中的「如：」不动', placeholderExample('比如：不该剥') === '比如：不该剥')

function press(key, value, placeholder, opts = {}) {
  let filled = null
  let prevented = false
  const e = { key, shiftKey: !!opts.shift, preventDefault: () => (prevented = true) }
  fillFromPlaceholder(e, value, placeholder, (v) => (filled = v))
  return { filled, prevented }
}

const hit = press('Tab', '', '如：北京中关村学院')
check('空输入框按 Tab → 填示例并拦截默认行为', hit.filled === '北京中关村学院' && hit.prevented)
check('已有内容 → 不覆盖，放行 Tab', press('Tab', '清华', '如：北京中关村学院').filled === null)
check('只有空白也算空 → 仍然补全', press('Tab', '   ', '如：北京中关村学院').filled === '北京中关村学院')
check(
  'Shift+Tab 放行（那是往回跳）',
  press('Tab', '', '如：北京中关村学院', { shift: true }).filled === null
)
check('其它按键不受影响', press('a', '', '如：北京中关村学院').filled === null)
check('没有 placeholder → 放行', press('Tab', '', '').filled === null)
check('placeholder 只有「如：」→ 放行，不填空串', press('Tab', '', '如：').filled === null)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
