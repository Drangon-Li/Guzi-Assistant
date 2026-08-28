// 主进程侧的插件实现契约。manifest（shared/plugin-registry.ts）声明「有什么」，
// 这里实现「怎么做」——两边由 test/plugin-smoke.mjs 卡住，不允许只有一边。
import type Database from 'better-sqlite3'

/** 供给「成就」插件的计数器；key 对应成就定义里的 counter 名。 */
export interface AchievementCounter {
  key: string
  value: number
}

// 每个插件的 handler 参数形状都不同，统一签名只能放宽到 any——
// 真正的类型约束在渲染层 api.ts 和各插件自己的实现里。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginHandler = (...args: any[]) => unknown

/** 助手动作的执行结果。message 会被拼进桌宠气泡和对话回复里。 */
export interface AssistantActionResult {
  ok: boolean
  message: string
}

export interface PluginMainModule {
  id: string
  /** 幂等建表。启用时调用一次，此后每次启动也会调用。 */
  initTables(db: Database.Database): void
  /** key 是 action，不含 plugin:<id>: 前缀——前缀由注册循环统一加，插件无法绕开。 */
  handlers: Record<string, PluginHandler>
  /** 向成就插件供给计数器。不实现就等于这个插件不带成就。 */
  counters?: () => AchievementCounter[]
  /**
   * 自然语言可驱动的动作，key 要与 manifest 的 contributes.assistantActions 对上。
   * 参数来自模型输出，一律当不可信输入校验。
   */
  assistantActions?: Record<string, (args: Record<string, unknown>) => AssistantActionResult>
}
