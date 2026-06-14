// 纯函数单测：任务 → .ics 导出（RFC 5545 转义/折行/浮动本地时）。运行：npm run test:ics
import { buildIcs } from '../src/shared/ics.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

function mkTask(o) {
  return {
    id: 'task-1',
    sourceId: null,
    title: '开会',
    itemType: 'meeting',
    belongsToUser: 'yes',
    belongingReason: '',
    userRole: 'owner',
    startTime: null,
    dueTime: null,
    location: null,
    priority: 'unknown',
    confidence: 0.9,
    suggestedAction: 'confirm',
    evidence: [],
    notes: [],
    duplicateOf: null,
    status: 'scheduled',
    feedback: null,
    createdAt: '',
    updatedAt: '',
    ...o
  }
}

const STAMP = { dtstamp: '20260101T000000Z' }

check('无任何时间返回 null', buildIcs(mkTask({}), STAMP) === null)

const onlyStart = buildIcs(mkTask({ startTime: '2026-12-31T08:00' }), STAMP)
check('仅开始时间 → DTSTART 浮动本地', onlyStart.includes('DTSTART:20261231T080000'))
check('仅开始时间无 DTEND', !onlyStart.includes('DTEND:'))
check('含必备头', onlyStart.includes('BEGIN:VCALENDAR') && onlyStart.includes('BEGIN:VEVENT'))
check('UID 带 @eshell', onlyStart.includes('UID:task-1@eshell'))
check('DTSTAMP 注入生效', onlyStart.includes('DTSTAMP:20260101T000000Z'))
check('行尾为 CRLF', onlyStart.includes('\r\n') && onlyStart.endsWith('\r\n'))

const onlyDue = buildIcs(mkTask({ dueTime: '2026-06-20T18:00' }), STAMP)
check('仅截止 → 以截止为 DTSTART', onlyDue.includes('DTSTART:20260620T180000') && !onlyDue.includes('DTEND:'))

const range = buildIcs(
  mkTask({ startTime: '2026-06-20T09:00', dueTime: '2026-06-20T10:30' }),
  STAMP
)
check('开始<截止 → 生成 DTEND 区间', range.includes('DTSTART:20260620T090000') && range.includes('DTEND:20260620T103000'))

const badRange = buildIcs(
  mkTask({ startTime: '2026-06-20T10:00', dueTime: '2026-06-20T09:00' }),
  STAMP
)
check('截止早于开始 → 不生成 DTEND', !badRange.includes('DTEND:'))

const esc = buildIcs(
  mkTask({ startTime: '2026-06-20T09:00', title: 'A,B;C\\D', location: '3楼\n会议室', notes: ['第一行\n第二行', '逗号,分号;'] }),
  STAMP
)
check('SUMMARY 转义逗号/分号/反斜杠', esc.includes('SUMMARY:A\\,B\\;C\\\\D'))
check('LOCATION 换行转义为 \\n', esc.includes('LOCATION:3楼\\n会议室'))
check('DESCRIPTION 多条 notes 合并并转义', esc.includes('DESCRIPTION:第一行\\n第二行\\n逗号\\,分号\\;'))

// 折行：构造一个超 75 字节的 SUMMARY（ASCII），应出现 CRLF+空格续行
const longTitle = 'x'.repeat(120)
const folded = buildIcs(mkTask({ startTime: '2026-06-20T09:00', title: longTitle }), STAMP)
check('超长行被折行（CRLF+空格续行）', /\r\n /.test(folded))
check(
  '折行后每物理行 ≤75 字节',
  folded.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
