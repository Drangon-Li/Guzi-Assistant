import { app } from 'electron'
import { join } from 'path'

// 桌宠窗口 preload：electron-vite 产物，main 在 out/main、preload 在 out/preload（与 windows.ts 的 ../preload/index.js 同约定）
export function petPreloadPath(): string {
  return join(__dirname, '../preload/pet.js')
}

// 桌宠运行时在 userData 下的工作目录（生成的 HTML、按需安装的宠物等）。spritesheet 走 electron-vite 的 ?asset 导入，不在此解析。
export function petUserDataDir(): string {
  return join(app.getPath('userData'), 'pet')
}
