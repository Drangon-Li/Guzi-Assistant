import { existsSync } from 'fs'
import { getLlama, LlamaChatSession, createModelDownloader } from 'node-llama-cpp'
import type { Llama, LlamaModel, LlamaJsonSchemaGrammar } from 'node-llama-cpp'
import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  coerceExtractions
} from '@shared/local-model-schema'
import type { LocalExtraction, LocalModelState, LocalModelStatus } from '@shared/types'
import { MODEL_URI, modelDir, modelPath } from './paths'

const CONTEXT_SIZE = 1024
const MAX_TOKENS = 1024

let llama: Llama | null = null
let model: LlamaModel | null = null
let grammar: LlamaJsonSchemaGrammar<typeof EXTRACTION_JSON_SCHEMA> | null = null
let state: LocalModelState = 'absent'
let errMsg: string | undefined
let lastUsed = 0

export function getLocalModelStatus(): LocalModelStatus {
  if ((state === 'absent' || state === 'unloaded') && existsSync(modelPath()) && !model) {
    return { state: state === 'absent' ? 'ready' : 'unloaded' }
  }
  return { state, error: errMsg }
}

async function ensureLlama(): Promise<Llama> {
  if (!llama) llama = await getLlama() // 全局单例，永不 dispose
  return llama
}

/** 首次开启按需下载（带进度）。node-llama-cpp 仅校验文件大小；SHA 固定作为后续 hardening。 */
export async function downloadLocalModel(onProgress: (p: number) => void): Promise<void> {
  if (existsSync(modelPath())) {
    state = 'ready'
    return
  }
  state = 'downloading'
  errMsg = undefined
  try {
    const downloader = await createModelDownloader({
      modelUri: MODEL_URI,
      dirPath: modelDir(),
      onProgress: ({ totalSize, downloadedSize }) =>
        onProgress(totalSize ? downloadedSize / totalSize : 0)
    })
    await downloader.download()
    state = 'ready'
  } catch (e) {
    state = 'error'
    errMsg = e instanceof Error ? e.message : String(e)
    throw e
  }
}

/** lazy load + 一次 warmup 推理消化 mmap 首次延迟。 */
export async function ensureLoaded(): Promise<void> {
  if (model) {
    lastUsed = Date.now()
    return
  }
  if (!existsSync(modelPath())) throw new Error('本地模型尚未下载')
  state = 'loading'
  errMsg = undefined
  try {
    const l = await ensureLlama()
    model = await l.loadModel({ modelPath: modelPath() })
    grammar = await l.createGrammarForJsonSchema(EXTRACTION_JSON_SCHEMA)
    const warm = await model.createContext({ contextSize: CONTEXT_SIZE })
    const s = new LlamaChatSession({ contextSequence: warm.getSequence() })
    await s.prompt('hi', { maxTokens: 1 })
    await warm.dispose()
    state = 'ready'
    lastUsed = Date.now()
  } catch (e) {
    state = 'error'
    errMsg = e instanceof Error ? e.message : String(e)
    model = null
    grammar = null
    throw e
  }
}

/** 关功能 / idle 调：dispose 释放权重+KV，归还统一内存。必须 await，别等 GC。 */
export async function unloadLocalModel(): Promise<void> {
  if (model) await model.dispose() // 级联 dispose 其 context
  model = null
  grammar = null
  if (state !== 'error') state = existsSync(modelPath()) ? 'unloaded' : 'absent'
}

/** 一次抽取：每次新建 context（KV 用完即弃），model 常驻。失败/解析不出返回 []。 */
export async function extract(text: string, selfNames?: string[]): Promise<LocalExtraction[]> {
  if (!text.trim()) return []
  await ensureLoaded()
  lastUsed = Date.now()
  const ctx = await model!.createContext({ contextSize: CONTEXT_SIZE })
  try {
    const session = new LlamaChatSession({
      contextSequence: ctx.getSequence(),
      systemPrompt: SYSTEM_PROMPT
    })
    const res = await session.prompt(buildExtractionPrompt(text, { now: new Date(), selfNames }), {
      grammar: grammar!,
      maxTokens: MAX_TOKENS
    })
    let parsed: unknown
    try {
      parsed = grammar!.parse(res)
    } catch {
      return [] // won't-stop 截断成残缺 JSON → 当作无日程
    }
    return coerceExtractions(parsed)
  } finally {
    await ctx.dispose()
  }
}

let idleTimer: ReturnType<typeof setInterval> | null = null
/** idle 自动卸载：超 ms 未用就卸模型释放内存。screenwatch 在开启功能时启动。 */
export function startIdleSweep(idleMs: number): void {
  stopIdleSweep()
  idleTimer = setInterval(
    () => {
      if (model && Date.now() - lastUsed > idleMs) void unloadLocalModel()
    },
    Math.max(60_000, idleMs / 2)
  )
}
export function stopIdleSweep(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
}
