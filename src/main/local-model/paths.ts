import { app } from 'electron'
import { join } from 'path'

/** node-llama-cpp 的 hf: 解析器：仓库:量化档。Q5_K_M（1.29GB）。 */
export const MODEL_URI = 'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:q5_k_m'
/** HF 该量化档实际文件名（下载后核对，不符则改这里）。 */
export const MODEL_FILENAME = 'qwen2.5-1.5b-instruct-q5_k_m.gguf'

export function modelDir(): string {
  return join(app.getPath('userData'), 'models')
}
export function modelPath(): string {
  return join(modelDir(), MODEL_FILENAME)
}
