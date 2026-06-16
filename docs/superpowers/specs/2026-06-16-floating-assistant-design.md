# 助手改为右下角悬浮对话 — 设计

日期：2026-06-16

## 背景与目标

当前助手是一个独立的导航页（5 页之一），且是启动默认页。但 agent 对话不是产品想突出的能力——核心是"统计日程及相关内容"的助手。因此：

- 去掉独立的「助手」导航页。
- 助手改为**应用内右下角悬浮对话**（Notion 式：常驻悬浮圆按钮 → 点开在窗口内展开聊天面板），覆盖在任意页面之上。
- 主界面默认显示**日程**页，且日程排在导航第一位。

助手的全部能力保留（对话问答、截图、扫描屏幕、候选事项确认、待确认批量加入）。

## 范围

仅 UI/交互架构调整。聊天的主进程逻辑（`assistant:chat` / `assistant:add` IPC、`assistant.ts`、`@shared/chat-layout` 等）不改；聊天记录仍内存存、重启清空；屏幕监控的右下角"建议卡"独立窗口 `previewWin` 不动，与新面板共存。

## 组件与文件改动

- 新增 `src/renderer/src/components/FloatingAssistant.tsx`
  - 渲染：右下角悬浮圆按钮（彩色 logo 图标）+ 待确认数角标；点击切换面板开合。
  - 面板：固定右下角、宽 `400px`、高 `min(600px, 72vh)`，含紧凑标题栏（logo + 标题 + ✕）和聊天主体。
  - 开合状态由 `App` 提升管理（`open` / `onOpenChange` props），以便外部触发打开。
- `src/renderer/src/pages/Assistant.tsx` → 迁移为 `src/renderer/src/components/AssistantChat.tsx`
  - 逻辑不变；适配窄面板：底部工具栏改为「操作按钮一行 + 输入框/发送一行」，收窄水平内边距。
- `src/renderer/src/App.tsx`
  - `Page` 与 `NAV` 去掉 `'assistant'`；`NAV` 重排为 日程 / 时间轴 / 记忆 / 设置。
  - 默认页改为 `'schedule'`。
  - 移除挂在导航「助手」项上的待确认角标（移到悬浮按钮）。
  - `eshell:navigate` 处理：`'inbox'/'assistant'` → 打开悬浮面板（`setChatOpen(true)`），不再切页；其余路由仍 `setPage`。
  - 顶层渲染 `<FloatingAssistant />`（在 `<main>` 之外，覆盖所有页面）。

## 层级（z-index）

悬浮按钮/面板 `z-40`：高于页面内容、低于弹窗与 toast（`z-50`），保证面板内打开的 `TaskDetailModal`/`SourceModal` 仍盖在其上；与顶部 `drag-strip`（`z-30`）不冲突。

## 接住原"跳转助手页"

唯一指向助手页的入口是 `PreviewCard.tsx` 的 `api.focusMain('assistant')`（点建议卡入口）。改为打开悬浮面板后仍有效（聚焦主窗 + 开面板）。

## 验证 / 风险 / 回滚

- 验证：`npm run typecheck` + `npm run build` + 运行实测（开合面板、发消息、候选/待确认操作、默认落日程、PreviewCard 入口打开面板）。
- 现有 smoke 测试针对主进程 / shared 逻辑，不受影响。
- 风险：迁移 ~500 行聊天 UI 可能漏接交互——只搬不改逻辑，仅重排输入区布局，运行实测覆盖。
- 回滚：独立 `feat/floating-assistant` 分支，丢弃即可。
