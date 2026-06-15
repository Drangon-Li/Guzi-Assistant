/**
 * 归属判断个性化学习（#15）：用户把某任务判为「不是我的」时，从任务文本里提取信号词，
 * 沉淀进 profile.belongingNotMine，下次解析作先验注入（注入见 belonging-hints.ts）。
 *
 * 刻意只取**高精度信号**——@提及、引号内的名字——不做脆弱的中文姓名识别（issue #15 自己点名的坑）。
 * 提不到高精度词就只记纠偏（调用方仍会把任务标 no），不往词典里塞噪声。
 */
import type { Profile } from './types'

// 中英文成对引号；用 \u 转义避免源码里花引号肉眼难辨
const QUOTES = '「」『』"\'“”‘’'
const QUOTED = new RegExp(`[${QUOTES}]([^${QUOTES}]{1,20})[${QUOTES}]`, 'g')
// 整段捕获（非 {1,20} 截断）→ 过长由 add() 的长度检查拒绝，而不是截断成噪声
const MENTION = /@([^\s@,，。、:：]+)/g

/** 从纠偏文本提取高精度归属信号（@提及 + 引号内名字），排除用户自己的名字/昵称/账号。 */
export function extractBelongingSignals(text: string, ownNames: string[]): string[] {
  if (!text) return []
  const own = new Set(ownNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
  const out: string[] = []
  const add = (raw: string): void => {
    const t = raw.trim()
    if (t && t.length <= 20 && !own.has(t.toLowerCase()) && !out.includes(t)) out.push(t)
  }
  for (const m of text.matchAll(MENTION)) add(m[1])
  for (const m of text.matchAll(QUOTED)) add(m[1])
  return out
}

/** 并入 belongingNotMine：去重（忽略大小写、保留首次原样）+ 上限（超出保留最新）。 */
export function mergeBelongingNotMine(existing: string[], signals: string[], cap = 50): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const item of [...existing, ...signals]) {
    const t = (item ?? '').trim()
    const key = t.toLowerCase()
    if (!t || seen.has(key)) continue
    seen.add(key)
    merged.push(t)
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/**
 * 纯学习：用户判某任务「不是我的」→ 从其文本提信号并入 profile。
 * 无新信号则原样返回（引用不变，调用方可据此判断是否需要落库）。
 */
export function learnNotMine(profile: Profile, taskText: string): Profile {
  const ownNames = [profile.name, ...(profile.nicknames ?? []), ...(profile.accounts ?? [])]
  const signals = extractBelongingSignals(taskText, ownNames)
  if (!signals.length) return profile
  const next = mergeBelongingNotMine(profile.belongingNotMine ?? [], signals)
  return { ...profile, belongingNotMine: next }
}
