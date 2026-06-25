import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'

/** node-llama-cpp 的 hf: 解析器：仓库:量化档。Q5_K_M（1.29GB）。 */
export const MODEL_URI = 'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:q5_k_m'

export function modelDir(): string {
  return join(app.getPath('userData'), 'models')
}

/**
 * 已下载的模型文件绝对路径；没有则 null。
 * 扫 modelDir 里的 .gguf（避开下载中的 .ipull 半成品），不依赖 hf: 解析器的确切命名。
 */
export function modelPath(): string | null {
  const dir = modelDir()
  if (!existsSync(dir)) return null
  const f = readdirSync(dir).find((n) => n.endsWith('.gguf'))
  return f ? join(dir, f) : null
}
