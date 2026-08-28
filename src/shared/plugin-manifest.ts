// 插件 manifest 契约与依赖解析：主进程、preload 和渲染层共用的纯数据与纯函数。
//
// 设计取向借鉴 VS Code（contributes 声明式贡献点 + extensionDependencies）与 Obsidian
// （minAppVersion）。当前只有内置插件——代码随主包发布，Market 做的是启用/停用，
// 但契约按「将来能加载外部插件」的形状定，届时只需补一个 loader，不必推翻这里。
//
// 两条前缀约束是安全边界，不是命名习惯：
//  - 表名必须 p_<id>_ 开头 → 卸载时按前缀 DROP，够不到核心表
//  - IPC 通道必须 plugin:<id>: 开头 → preload 可按前缀校验，不必逐条登记

export type PluginCategory = 'planning' | 'focus' | 'habit' | 'reward'

/**
 * 助手可调用的动作。声明会被拼进对话提示词——**只拼已启用插件的**，
 * 所以没装某个插件时模型根本不知道有这个能力，不会承诺做不到的事。
 */
export interface AssistantActionSpec {
  /** 动作名，同一插件内唯一 */
  name: string
  /** 一句话说明这个动作做什么 */
  summary: string
  /** 参数形状的人话描述，直接写进提示词 */
  args: string
  /** 什么样的用户说法应该触发它 */
  when: string
}

/**
 * 插件事件：发出者不知道谁在听，监听者不知道谁会发。
 *
 * 这是插件之间「可随意抽插又能互相联系」的关键——「专注」走完一轮只管发出
 * pomodoro:round-completed，至于「作息」有没有装、装了要不要记，都与它无关。
 * 没装对方时循环里根本找不到监听者，什么都不会发生，不需要任何 if 判断。
 */
export interface PluginEventSpec {
  /** 事件名，不含 <plugin>: 前缀 */
  name: string
  summary: string
}

/** 完整事件名：<发出插件 id>:<事件名>。 */
export function pluginEventName(from: string, name: string): string {
  return `${from}:${name}`
}

export interface PluginContributes {
  /** 侧边栏导航项；order 越小越靠上，核心页占 0-99，插件从 100 起 */
  nav?: { label: string; order: number }
  // 这里刻意没有「设置分区」这个贡献点：插件的配置放在插件自己的页面里，
  // 跟着插件走。核心设置页只管核心功能，停用插件不会在那里留下空分区。
  /** 今日页卡片 id，由渲染层注册表映射到组件 */
  homeCards?: readonly string[]
  /** 是否向「成就」插件供给计数器 */
  achievementCounters?: boolean
  /** 桌宠 / 悬浮助手 / 快捷提问里可以用自然语言驱动的动作 */
  assistantActions?: readonly AssistantActionSpec[]
  /** 本插件会发出的事件 */
  emits?: readonly PluginEventSpec[]
  /** 本插件监听的事件（完整名 <plugin>:<event>），只用于校验与 Market 的联动提示 */
  listens?: readonly string[]
}

export interface PluginManifest {
  /** 小写字母开头的短 id，同时用作 IPC 前缀与表名前缀 */
  id: string
  name: string
  version: string
  /** 低于此客户端版本不显示该插件 */
  minAppVersion: string
  /** Market 卡片上的一句话 */
  summary: string
  description: string
  category: PluginCategory
  /** 硬依赖：对方未启用则本插件无法启用；启停会级联 */
  dependencies?: readonly string[]
  /** 软依赖：装了更好用，缺了不影响，只在 Market 里作为提示 */
  enhances?: readonly string[]
  contributes: PluginContributes
  storage: { tables: readonly string[] }
}

export type PluginRegistry = readonly PluginManifest[]

const ID_RE = /^[a-z][a-z0-9-]*$/

export function tablePrefix(id: string): string {
  return `p_${id.replace(/-/g, '_')}_`
}

export function channelPrefix(id: string): string {
  return `plugin:${id}:`
}

export function pluginChannel(id: string, action: string): string {
  return `${channelPrefix(id)}${action}`
}

/** 从通道名反解插件 id；不是插件通道返回 null。 */
export function parsePluginChannel(channel: string): { id: string; action: string } | null {
  const m = /^plugin:([a-z][a-z0-9-]*):([a-z0-9-]+)$/.exec(channel)
  return m ? { id: m[1], action: m[2] } : null
}

// ---------- 版本 ----------

/** 语义版本比较，只看 major.minor.patch；返回 -1 / 0 / 1。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/** 当前客户端版本是否够得上这个插件。 */
export function isAvailable(m: PluginManifest, appVersion: string): boolean {
  return compareVersions(appVersion, m.minAppVersion) >= 0
}

// ---------- 校验 ----------

/** 单个 manifest 的自洽性；返回人话错误列表，空数组表示通过。 */
export function validateManifest(m: PluginManifest): string[] {
  const errs: string[] = []
  if (!ID_RE.test(m.id)) errs.push(`id「${m.id}」非法：只能小写字母开头，含小写字母、数字和连字符`)
  if (!m.name) errs.push(`${m.id}: name 不能为空`)
  if (!m.summary) errs.push(`${m.id}: summary 不能为空`)
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) errs.push(`${m.id}: version「${m.version}」不是 x.y.z`)
  if (!/^\d+\.\d+\.\d+$/.test(m.minAppVersion))
    errs.push(`${m.id}: minAppVersion「${m.minAppVersion}」不是 x.y.z`)

  const prefix = tablePrefix(m.id)
  for (const t of m.storage.tables) {
    if (!t.startsWith(prefix)) errs.push(`${m.id}: 表名「${t}」必须以 ${prefix} 开头，否则卸载清不干净`)
  }
  if (new Set(m.storage.tables).size !== m.storage.tables.length)
    errs.push(`${m.id}: storage.tables 有重复`)

  for (const d of m.dependencies ?? []) {
    if (d === m.id) errs.push(`${m.id}: 不能依赖自己`)
  }
  for (const e of m.enhances ?? []) {
    if (e === m.id) errs.push(`${m.id}: 不能增强自己`)
    if ((m.dependencies ?? []).includes(e))
      errs.push(`${m.id}: 「${e}」同时出现在 dependencies 和 enhances，取其一`)
  }
  return errs
}

/** 整张注册表：id 唯一、表名不撞车、硬依赖都存在、依赖不成环。 */
export function validateRegistry(registry: PluginRegistry): string[] {
  const errs: string[] = []
  const ids = new Set<string>()
  const tables = new Map<string, string>()

  for (const m of registry) {
    errs.push(...validateManifest(m))
    if (ids.has(m.id)) errs.push(`重复的插件 id：${m.id}`)
    ids.add(m.id)
    for (const t of m.storage.tables) {
      const owner = tables.get(t)
      if (owner) errs.push(`表「${t}」被 ${owner} 和 ${m.id} 同时声明`)
      else tables.set(t, m.id)
    }
  }
  for (const m of registry) {
    for (const d of m.dependencies ?? []) {
      if (!ids.has(d)) errs.push(`${m.id} 依赖的「${d}」不在注册表里`)
    }
  }
  const cycle = findCycle(registry)
  if (cycle) errs.push(`依赖成环：${cycle.join(' → ')}`)
  return errs
}

/** 找出一条硬依赖环（首尾同一个 id），没有则返回 null。 */
export function findCycle(registry: PluginRegistry): string[] | null {
  const byId = new Map(registry.map((m) => [m.id, m]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let found: string[] | null = null

  const walk = (id: string): void => {
    if (found || state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      found = [...stack.slice(stack.indexOf(id)), id]
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const d of byId.get(id)?.dependencies ?? []) {
      if (byId.has(d)) walk(d)
    }
    stack.pop()
    state.set(id, 'done')
  }

  for (const m of registry) walk(m.id)
  return found
}

// ---------- 依赖解析 ----------

function manifestOf(registry: PluginRegistry, id: string): PluginManifest | undefined {
  return registry.find((m) => m.id === id)
}

/**
 * 启用 id 需要连带启用的插件，依赖在前、自身在最后；已启用的不重复列出。
 * 注册表里没有的 id 返回空数组——调用方据此判断「没这个插件」。
 */
export function enableChain(registry: PluginRegistry, enabled: readonly string[], id: string): string[] {
  if (!manifestOf(registry, id)) return []
  const have = new Set(enabled)
  const out: string[] = []
  const seen = new Set<string>()

  const walk = (cur: string): void => {
    if (seen.has(cur)) return
    seen.add(cur)
    const m = manifestOf(registry, cur)
    if (!m) return
    for (const d of m.dependencies ?? []) walk(d)
    if (!have.has(cur)) out.push(cur)
  }
  walk(id)
  return out
}

/** 谁硬依赖 id（只看直接依赖）。 */
export function dependentsOf(registry: PluginRegistry, id: string): string[] {
  return registry.filter((m) => (m.dependencies ?? []).includes(id)).map((m) => m.id)
}

/**
 * 停用 id 会连带停用的插件，依赖者在前、自身在最后；只列当前已启用的。
 * 停用级联是必须的：A 依赖 B，只停 B 会让 A 在缺依赖的状态下继续跑。
 */
export function disableChain(registry: PluginRegistry, enabled: readonly string[], id: string): string[] {
  const have = new Set(enabled)
  if (!have.has(id)) return []
  const out: string[] = []
  const seen = new Set<string>()

  const walk = (cur: string): void => {
    if (seen.has(cur)) return
    seen.add(cur)
    for (const dep of dependentsOf(registry, cur)) {
      if (have.has(dep)) walk(dep)
    }
    out.push(cur)
  }
  walk(id)
  return out
}

/** 剔除注册表里没有的、以及硬依赖不全的条目。启动时用它兜住手改过数据库的情况。 */
export function pruneEnabled(registry: PluginRegistry, enabled: readonly string[]): string[] {
  let keep = enabled.filter((id) => manifestOf(registry, id))
  for (;;) {
    const set = new Set(keep)
    const next = keep.filter((id) =>
      (manifestOf(registry, id)?.dependencies ?? []).every((d) => set.has(d))
    )
    if (next.length === keep.length) return next
    keep = next
  }
}

/**
 * 已启用插件的助手动作清单，渲染成提示词里的一段。
 * 没有任何可用动作时返回空串，调用方据此整段省略——不给模型无谓的噪音。
 */
export function assistantActionsBlock(
  registry: PluginRegistry,
  enabled: readonly string[]
): string {
  const lines: string[] = []
  for (const m of registry) {
    if (!enabled.includes(m.id)) continue
    for (const a of m.contributes.assistantActions ?? []) {
      lines.push(
        `- {"plugin":"${m.id}","action":"${a.name}"}：${a.summary}。参数 args=${a.args}。${a.when}`
      )
    }
  }
  return lines.join('\n')
}

/** 校验一个动作调用是否指向已启用插件里真实存在的动作。 */
export function isKnownAssistantAction(
  registry: PluginRegistry,
  enabled: readonly string[],
  plugin: string,
  action: string
): boolean {
  if (!enabled.includes(plugin)) return false
  const m = registry.find((x) => x.id === plugin)
  return (m?.contributes.assistantActions ?? []).some((a) => a.name === action)
}

/** 注册表里所有已声明的事件全名。 */
export function declaredEvents(registry: PluginRegistry): string[] {
  return registry.flatMap((m) =>
    (m.contributes.emits ?? []).map((e) => pluginEventName(m.id, e.name))
  )
}

/** 监听了但没人发的事件——多半是拼错了事件名，构建期就该发现。 */
export function danglingListeners(registry: PluginRegistry): { plugin: string; event: string }[] {
  const declared = new Set(declaredEvents(registry))
  return registry.flatMap((m) =>
    (m.contributes.listens ?? [])
      .filter((e) => !declared.has(e))
      .map((event) => ({ plugin: m.id, event }))
  )
}

/** 软依赖里还没启用的那些——Market 卡片用来提示「装了它会更好用」。 */
export function missingEnhancements(
  registry: PluginRegistry,
  enabled: readonly string[],
  id: string
): string[] {
  const have = new Set(enabled)
  return (manifestOf(registry, id)?.enhances ?? []).filter((e) => !have.has(e) && manifestOf(registry, e))
}

// ---------- Market 视图 ----------

export interface PluginState {
  manifest: PluginManifest
  enabled: boolean
  /** 客户端版本够不够；不够则 Market 里灰显并提示升级 */
  available: boolean
  /** 启用它会连带启用的其它插件（不含自己） */
  requires: string[]
  /** 停用它会连带停用的其它插件（不含自己） */
  breaks: string[]
  /** 还没启用的软依赖 */
  missing: string[]
}

/** Market 页要的全部状态，一次算完。纯函数，主进程和渲染层都能用。 */
export function buildPluginStates(
  registry: PluginRegistry,
  enabled: readonly string[],
  appVersion: string
): PluginState[] {
  return registry.map((manifest) => {
    const id = manifest.id
    const on = enabled.includes(id)
    return {
      manifest,
      enabled: on,
      available: isAvailable(manifest, appVersion),
      requires: on ? [] : enableChain(registry, enabled, id).filter((x) => x !== id),
      breaks: on ? disableChain(registry, enabled, id).filter((x) => x !== id) : [],
      missing: missingEnhancements(registry, enabled, id)
    }
  })
}
