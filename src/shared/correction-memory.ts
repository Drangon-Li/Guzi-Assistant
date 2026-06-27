/**
 * 校正记忆（Phase 2，MemPrompt 式）：把「云端 VLM 校正 ≠ 本地」的案例存为记忆；本地抽取时
 * 按词法相似度检索相关校正 —— 精确命中=直接覆盖(等价语义缓存)，相似命中=注入分类 prompt 作 few-shot。
 * 参考 MemPrompt(Madaan et al., EMNLP'22)：不重训、靠检索过去纠正改进部署后的判别。
 * 纯函数、零依赖、可离线单测。相似度用字符 trigram Jaccard（中文友好，无需 tokenizer/embedding）。
 */
import type { Belongs } from './types'

export interface Correction {
  /** 本地分类时看到的候选文字（检索键） */
  inputText: string
  /** VLM 判定：是不是真待办（false = 本地假阳性） */
  isTodo: boolean
  /** 校正后的标题（isTodo 时有值） */
  title: string | null
  /** 校正后的归属（isTodo 时有值） */
  belongs: Belongs | null
  createdAt?: string
}

const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

function trigrams(s: string): Set<string> {
  const t = norm(s)
  const g = new Set<string>()
  if (t.length < 3) {
    if (t) g.add(t)
    return g
  }
  for (let i = 0; i <= t.length - 3; i++) g.add(t.slice(i, i + 3))
  return g
}

/** 字符 trigram Jaccard 相似度 [0,1]。 */
export function textSimilarity(a: string, b: string): number {
  const ga = trigrams(a)
  const gb = trigrams(b)
  if (!ga.size || !gb.size) return norm(a) === norm(b) ? 1 : 0
  let inter = 0
  for (const x of ga) if (gb.has(x)) inter++
  return inter / (ga.size + gb.size - inter)
}

/** 精确(近似)命中：相似度 ≥ thr 的最相似校正 → 当语义缓存直接覆盖。无则 null。 */
export function exactCorrection(candidate: string, corrections: Correction[], thr = 0.9): Correction | null {
  let best: Correction | null = null
  let bestSim = thr
  for (const c of corrections) {
    const sim = textSimilarity(candidate, c.inputText)
    if (sim >= bestSim) {
      bestSim = sim
      best = c
    }
  }
  return best
}

/** 相似命中：相似度 ≥ minSim 的 top-K 校正(降序) → 注入 few-shot。 */
export function relevantCorrections(
  candidate: string,
  corrections: Correction[],
  k = 2,
  minSim = 0.35
): Correction[] {
  return corrections
    .map((c) => ({ c, sim: textSimilarity(candidate, c.inputText) }))
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map((x) => x.c)
}

/** 校正 → CLASSIFY 格式的 few-shot 示例文本（与 CLASSIFY_SYSTEM_PROMPT 示例同形）。 */
export function buildCorrectionFewShot(corrections: Correction[]): string {
  return corrections
    .map((c) => {
      const inp = c.inputText.replace(/\s+/g, ' ').slice(0, 60)
      const out = c.isTodo
        ? `[{"title":"${c.title ?? ''}","isoTime":null,"deadline":false,"belongsToUser":"${c.belongs ?? 'uncertain'}","hits":[],"confidence":0.9,"needsVlm":false}]`
        : '[]'
      return `"${inp}" → ${out}`
    })
    .join('\n')
}
