import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

let cached: Record<string, string> | null = null

export function loadEnv(): Record<string, string> {
  if (cached) return cached
  const result: Record<string, string> = {}
  const candidates = [join(app.getAppPath(), '.env'), join(app.getPath('userData'), '.env')]
  for (const file of candidates) {
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
        if (m && !(m[1] in result)) result[m[1]] = m[2]
      }
    } catch {
      // 文件不存在则跳过
    }
  }
  cached = result
  return result
}
