// 渲染层侧的插件实现契约。与 main/plugins/types.ts 对称：
// manifest 声明「贡献什么」，这里给出对应的组件。
//
// 页面一律走 React.lazy：没启用的插件不进首屏 chunk，装了四个插件和一个都不装
// 在启动开销上不该有明显差别。
import type { ComponentType, LazyExoticComponent } from 'react'

/**
 * 每个插件页面都会拿到当前启用了哪些插件——软依赖靠它落地：
 * 「专注」装了「作息」就多出关联时间块的下拉，没装就完全不去碰对方的通道。
 */
export interface PluginPageProps {
  enabledPlugins: string[]
}

export interface PluginRendererModule {
  id: string
  /** 侧边栏图标；与 manifest.contributes.nav 配套 */
  Icon: () => React.JSX.Element
  Page: LazyExoticComponent<ComponentType<PluginPageProps>>
  /** 今日页卡片，key 对应 manifest.contributes.homeCards 里的名字 */
  homeCards?: Record<string, LazyExoticComponent<ComponentType>>
}
