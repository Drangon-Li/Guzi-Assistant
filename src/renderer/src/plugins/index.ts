// 渲染层插件注册表。与 shared/plugin-registry.ts 的 manifest 一一对应，
// test/plugin-smoke.mjs 卡住「声明了没实现」和「实现了没声明」两个方向。
import achievement from './achievement/index.tsx'
import habit from './habit/index.tsx'
import pomodoro from './pomodoro/index.tsx'
import timeblock from './timeblock/index.tsx'
import type { PluginRendererModule } from './types'

export const PLUGIN_UI: Record<string, PluginRendererModule> = {
  timeblock,
  pomodoro,
  habit,
  achievement
}
