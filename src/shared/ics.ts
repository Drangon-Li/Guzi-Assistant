// 把任务导出成 RFC 5545 iCalendar(.ics)。纯函数，便于单测与复用。
// 时间用「浮动本地时」（不带 TZID/Z），与 app 内 normalizeTime 产出的本地时一致，
// 日历 App 会按用户本机时区解释，符合个人事项语义。
import type { TaskRecord } from './types'

/** 'YYYY-MM-DDTHH:MM' → '20261231T080000'；非法返回 null */
function toICalLocal(v: string | null): string | null {
  if (!v) return null
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!m) return null
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`
}

/** RFC 5545 TEXT 转义：反斜杠、分号、逗号、换行 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** 内容行按 75 字节折行（CRLF + 空格续行），按 UTF-8 字节计且不切碎码点 */
function foldLine(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  let first = true
  for (const ch of line) {
    const chBytes = enc.encode(ch).length
    // 续行以一个空格起头，可用字节数相应少 1；首行可用 75，续行 74
    const limit = first ? 75 : 74
    if (curBytes + chBytes > limit) {
      out.push(cur)
      cur = ch
      curBytes = chBytes
      first = false
    } else {
      cur += ch
      curBytes += chBytes
    }
  }
  out.push(cur)
  return out.join('\r\n ')
}

function utcStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

export interface IcsOptions {
  /** DTSTAMP（UTC，形如 20261231T080000Z）；省略则用当前时间。测试可注入以求确定性 */
  dtstamp?: string
}

/**
 * 任务 → .ics 字符串。无任何时间（startTime/dueTime 均空）的任务无法成事件，返回 null。
 * 仅开始时间 → 点事件；仅截止 → 以截止为事件时刻；两者都有且截止晚于开始 → 区间事件。
 */
export function buildIcs(task: TaskRecord, opts: IcsOptions = {}): string | null {
  const start = toICalLocal(task.startTime)
  const due = toICalLocal(task.dueTime)
  const dtstart = start ?? due
  if (!dtstart) return null
  const dtend = start && due && due > start ? due : null

  const dtstamp = opts.dtstamp ?? utcStamp(new Date())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gooz//Task Export//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeText(task.id)}@eshell`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    ...(dtend ? [`DTEND:${dtend}`] : []),
    `SUMMARY:${escapeText(task.title)}`,
    ...(task.location ? [`LOCATION:${escapeText(task.location)}`] : []),
    ...(task.notes.length ? [`DESCRIPTION:${escapeText(task.notes.join('\n'))}`] : []),
    'END:VEVENT',
    'END:VCALENDAR'
  ]
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
