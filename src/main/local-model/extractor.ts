import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { basename, join } from 'path'
import type { Llama, LlamaModel, LlamaJsonSchemaGrammar } from 'node-llama-cpp'
import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  coerceExtractions,
  chunkForExtraction,
  dedupeExtractions
} from '@shared/local-model-schema'
import { correctIsoDate } from '@shared/local-time'
import type { LocalExtraction, LocalModelState, LocalModelStatus } from '@shared/types'
import { MODEL_URI, modelDir, modelPath } from './paths'

const CONTEXT_SIZE = 1024
const MAX_TOKENS = 1024

// node-llama-cpp 是带顶层 await 的 ESM，CJS 主进程不能静态 require → 动态 import() 延迟加载（首次用时才载）。
type NlcModule = typeof import('node-llama-cpp')
let nlc: NlcModule | null = null
async function nlcMod(): Promise<NlcModule> {
  if (!nlc) nlc = await import('node-llama-cpp')
  return nlc
}

let llama: Llama | null = null
let model: LlamaModel | null = null
let grammar: LlamaJsonSchemaGrammar<typeof EXTRACTION_JSON_SCHEMA> | null = null
let state: LocalModelState = 'absent'
let errMsg: string | undefined
let lastUsed = 0
let lastProgress = 0
// 串行化抽取：同一时刻只跑一个 extract；卸载会等在途抽取结束，避免 dispose 撞上正在推理的 model。
let inflight = 0
let extractChain: Promise<unknown> = Promise.resolve()

export function getLocalModelStatus(): LocalModelStatus {
  if (state === 'downloading') return { state, progress: lastProgress }
  if ((state === 'absent' || state === 'unloaded') && modelPath() && !model) {
    return { state: state === 'absent' ? 'ready' : 'unloaded' }
  }
  return { state, error: errMsg }
}

async function ensureLlama(): Promise<Llama> {
  if (!llama) {
    const { getLlama } = await nlcMod()
    llama = await getLlama() // 全局单例，永不 dispose
  }
  return llama
}

/** 首次开启按需下载（带进度）。endpoint 可传 HF 镜像（如 hf-mirror.com）免代理；留空走官方。 */
export async function downloadLocalModel(
  onProgress: (p: number) => void,
  endpoint?: string
): Promise<void> {
  if (modelPath()) {
    state = 'ready'
    return
  }
  state = 'downloading'
  errMsg = undefined
  try {
    const { createModelDownloader } = await nlcMod()
    // 自定义下载源（HF 镜像）：补全 https:// 与结尾斜杠
    const hf = endpoint?.trim()
      ? endpoint
          .trim()
          .replace(/^(?!https?:\/\/)/, 'https://')
          .replace(/\/?$/, '/')
      : undefined
    const downloader = await createModelDownloader({
      modelUri: MODEL_URI,
      dirPath: modelDir(),
      ...(hf ? { endpoints: { huggingFace: hf } } : {}),
      onProgress: ({ totalSize, downloadedSize }) => {
        lastProgress = totalSize ? downloadedSize / totalSize : 0
        onProgress(lastProgress)
      }
    })
    await downloader.download()
    state = 'ready'
  } catch (e) {
    state = 'error'
    errMsg = e instanceof Error ? e.message : String(e)
    throw e
  }
}

/** 导入用户已下好的 .gguf：先卸载在用模型，清掉旧文件，拷进模型目录。绕开一切网络/代理。 */
export async function importLocalModel(srcPath: string): Promise<void> {
  if (!srcPath.toLowerCase().endsWith('.gguf')) throw new Error('请选择 .gguf 模型文件')
  await unloadLocalModel()
  const dir = modelDir()
  await mkdir(dir, { recursive: true })
  for (const f of await readdir(dir)) {
    if (f.toLowerCase().endsWith('.gguf')) await rm(join(dir, f)).catch(() => {})
  }
  await copyFile(srcPath, join(dir, basename(srcPath)))
  state = 'ready'
  errMsg = undefined
}

/** lazy load + 一次 warmup 推理消化 mmap 首次延迟。warmup/加载任何抛出都 dispose 干净，不泄漏原生句柄。 */
export async function ensureLoaded(): Promise<void> {
  if (model) {
    lastUsed = Date.now()
    return
  }
  const mp = modelPath()
  if (!mp) throw new Error('本地模型尚未下载')
  state = 'loading'
  errMsg = undefined
  try {
    const l = await ensureLlama()
    const { LlamaChatSession } = await nlcMod()
    model = await l.loadModel({ modelPath: mp })
    grammar = await l.createGrammarForJsonSchema(EXTRACTION_JSON_SCHEMA)
    const warm = await model.createContext({ contextSize: CONTEXT_SIZE })
    try {
      const s = new LlamaChatSession({ contextSequence: warm.getSequence() })
      await s.prompt('hi', { maxTokens: 1 })
    } finally {
      await warm.dispose()
    }
    state = 'ready'
    lastUsed = Date.now()
  } catch (e) {
    state = 'error'
    errMsg = e instanceof Error ? e.message : String(e)
    if (model) await model.dispose().catch(() => {}) // 别让加载失败的 model 泄漏（下面要置 null）
    model = null
    grammar = null
    throw e
  }
}

/** 关功能 / idle 调：先等在途抽取结束再 dispose（防撞上推理），释放权重+KV、归还统一内存。必须 await。 */
export async function unloadLocalModel(): Promise<void> {
  await extractChain.catch(() => {})
  if (model) await model.dispose() // 级联 dispose 其 context
  model = null
  grammar = null
  if (state !== 'error') state = modelPath() ? 'unloaded' : 'absent'
}

/** 一次抽取：串行排队（同一时刻仅一个），每次新建 context（KV 用完即弃），model 常驻。失败/解析不出返回 []。 */
export async function extract(text: string, selfNames?: string[]): Promise<LocalExtraction[]> {
  if (!text.trim()) return []
  const run = extractChain.then(
    () => doExtract(text, selfNames),
    () => doExtract(text, selfNames)
  )
  extractChain = run.catch(() => {}) // 链上忽略错误，避免一次失败卡死后续；调用方仍拿到 run 的 reject
  return run
}

async function doExtract(text: string, selfNames?: string[]): Promise<LocalExtraction[]> {
  await ensureLoaded()
  const { LlamaChatSession } = await nlcMod()
  inflight++
  lastUsed = Date.now()
  const m = model! // 串行化 + unload 等在途，doExtract 期间 model/grammar 不会被置 null
  const g = grammar!
  const now = new Date()
  try {
    // 切块逐块抽：满屏 OCR 噪声会把小模型淹掉，小窗口逐块跑再合并去重，召回更稳
    const all: LocalExtraction[] = []
    for (const chunk of chunkForExtraction(text)) {
      const ctx = await m.createContext({ contextSize: CONTEXT_SIZE })
      try {
        const session = new LlamaChatSession({
          contextSequence: ctx.getSequence(),
          systemPrompt: SYSTEM_PROMPT
        })
        const res = await session.prompt(buildExtractionPrompt(chunk, { now, selfNames }), {
          grammar: g,
          maxTokens: MAX_TOKENS
        })
        try {
          const items = coerceExtractions(g.parse(res), now)
          for (const it of items) it.isoTime = correctIsoDate(it.isoTime, chunk, now) // 确定性日期纠错
          all.push(...items)
        } catch {
          /* won't-stop 截断成残缺 JSON → 跳过该块 */
        }

      } finally {
        await ctx.dispose()
      }
    }
    return dedupeExtractions(all)
  } finally {
    inflight--
    lastUsed = Date.now()
  }
}

let idleTimer: ReturnType<typeof setInterval> | null = null
/** idle 自动卸载：超 ms 未用且无在途抽取就卸模型释放内存。screenwatch 在开启功能时启动。 */
export function startIdleSweep(idleMs: number): void {
  stopIdleSweep()
  idleTimer = setInterval(
    () => {
      if (model && inflight === 0 && Date.now() - lastUsed > idleMs) void unloadLocalModel()
    },
    Math.max(60_000, idleMs / 2)
  )
}
export function stopIdleSweep(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
}
