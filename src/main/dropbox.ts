import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { submitExternalFiles } from './capture'
import { isSafeDropPath } from '@shared/safe-path'
import { isContentResetting, isExitPreparing } from './content-lifecycle'

let debounce: NodeJS.Timeout | null = null
let watcher: FSWatcher | null = null
let quitHooked = false

export function dropboxDir(): string {
  return join(app.getPath('userData'), 'dropbox')
}

/** 右键快速操作把选中文件的路径写成 manifest（.txt 一行一个路径），这里消费并删除 */
function processManifests(): void {
  if (isContentResetting() || isExitPreparing()) return
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
  // #3：拦截敏感路径（恶意 manifest 投递 ~/.ssh/id_rsa 等会被外发），再校验存在
  const valid = paths.filter((p) => isSafeDropPath(p) && existsSync(p))
  if (valid.length) void submitExternalFiles(valid)
}

export function initDropbox(): void {
  stopDropbox()
  const dir = dropboxDir()
  mkdirSync(dir, { recursive: true })
  // 应用没开时通过右键发送的文件，启动时补处理
  processManifests()
  watcher = watch(dir, () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(processManifests, 300)
  })
  // 退出时关闭 watcher 句柄，避免常驻 libuv handle 拖延退出
  if (!quitHooked) {
    app.on('will-quit', stopDropbox)
    quitHooked = true
  }
}

export function stopDropbox(): void {
  if (debounce) clearTimeout(debounce)
  debounce = null
  watcher?.close()
  watcher = null
}
