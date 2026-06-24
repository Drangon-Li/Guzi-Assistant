import { app } from 'electron'
import { join } from 'path'

// 桌宠窗口 preload：原始 .cjs（用 DOM，不进 tsc）。放 resources/pet，dev 走项目根、打包走 resourcesPath。
export function petPreloadPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'pet', 'pet-preload.cjs')
  return join(app.getAppPath(), 'resources', 'pet', 'pet-preload.cjs')
}

// 桌宠运行时在 userData 下的工作目录（生成的 HTML、按需安装的宠物等）。spritesheet 走 electron-vite 的 ?asset 导入，不在此解析。
export function petUserDataDir(): string {
  return join(app.getPath('userData'), 'pet')
}
