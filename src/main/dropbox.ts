import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { submitExternalFiles } from './capture'

let debounce: NodeJS.Timeout | null = null

export function dropboxDir(): string {
  return join(app.getPath('userData'), 'dropbox')
}

/** 右键快速操作把选中文件的路径写成 manifest（.txt 一行一个路径），这里消费并删除 */
function processManifests(): void {
  const dir = dropboxDir()
  let manifests: string[] = []
  try {
    manifests = readdirSync(dir).filter((f) => f.endsWith('.txt'))
  } catch {
    return
  }
  const paths: string[] = []
  for (const name of manifests) {
    const full = join(dir, name)
    try {
      paths.push(
        ...readFileSync(full, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      )
      unlinkSync(full)
    } catch {
      // 读取失败的 manifest 留待下次
    }
  }
  const valid = paths.filter((p) => existsSync(p))
  if (valid.length) void submitExternalFiles(valid)
}

export function initDropbox(): void {
  const dir = dropboxDir()
  mkdirSync(dir, { recursive: true })
  // 应用没开时通过右键发送的文件，启动时补处理
  processManifests()
  watch(dir, () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(processManifests, 300)
  })
}
