// macOS 应用菜单：让菜单栏在本应用前台时显示自己的菜单（关于/设置/编辑/窗口）。
// 之前从未设置过应用菜单，输入框的 ⌘C/⌘V 等编辑快捷键也因此缺失。
// 限制：dev 下菜单栏左上角粗体名仍是 Electron（来自 Electron.app 的 Info.plist），打包后显示 productName。
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { focusMain } from './windows'
import { triggerClipboardCapture, triggerScreenshotCapture } from './ipc'
import { checkForUpdates } from './updater'

export function installAppMenu(): void {
  const viewItems: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' }
      ]

  const menu = Menu.buildFromTemplate([
    {
      label: '谷子助手', // macOS 忽略首个菜单的 label，实际显示应用名
      submenu: [
        { role: 'about', label: '关于 谷子助手' },
        { label: '检查更新…', click: () => void checkForUpdates(true) },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => focusMain('settings') },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [
          { role: 'hide', label: '隐藏 谷子助手' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' }
        ] satisfies MenuItemConstructorOptions[] : []),
        { label: '退出 谷子助手', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '提交剪切板内容', click: () => triggerClipboardCapture() },
        { label: '截图捕获', click: () => triggerScreenshotCapture() },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' } // 主窗 close 被拦截为隐藏，应用常驻托盘
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [...viewItems, { role: 'togglefullscreen', label: '进入/退出全屏' }]
    },
    { label: '窗口', role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}
