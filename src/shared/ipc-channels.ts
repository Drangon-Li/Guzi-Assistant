// IPC 通道单一事实源：主进程注册、preload 白名单、渲染层调用都以此为准。
// 新增通道必须在此登记，否则 preload 白名单会拒绝（test/ipc-channels-smoke.mjs 会校验本表与源码一致）。

/** 渲染层 → 主进程的 invoke 通道（对应 ipcMain.handle） */
export const INVOKE_CHANNELS = [
  'profile:get',
  'profile:save',
  'settings:get',
  'settings:save',
  'capture:clipboard',
  'capture:files',
  'capture:screenshot',
  'preview:submit',
  'preview:cancel',
  'preview:hide',
  'tasks:list',
  'tasks:update',
  'tasks:bulk',
  'source:get',
  'source:delete',
  'data:wipe',
  'permissions:get',
  'quickaction:status',
  'quickaction:install',
  'feishu:status',
  'screen:scan',
  'suggestion:accept',
  'assistant:chat',
  'assistant:add',
  'app:focus-main',
  'task:export-ics'
] as const

/** 主进程 → 渲染层的事件通道（对应 broadcast / webContents.send 与渲染层 on） */
export const EVENT_CHANNELS = [
  'eshell:navigate',
  'eshell:preview',
  'eshell:settings-updated',
  'eshell:tasks-updated'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]
