// 谷子云端 MCP：用谷子账号登录后，经 wss://mcp.guzilab.com 把 AI 客户端的工具调用转到这台电脑。
// 工具与本地 MCP 服务完全相同（TOOLS + executeMcpTool），不监听任何端口；任务等数据仍只在本机。
import { app, powerMonitor, safeStorage } from 'electron'
import { chmodSync, renameSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { CloudLink, createFileStorage } from './cloud-link.mjs'
import { executeMcpTool, TOOLS } from '../mcp-server'
import { broadcast } from '../windows'
import { desktopPlatform } from '@shared/platform'
import type { CloudState } from '@shared/cloud'

const SEALED_PREFIX = 'safe:'
let link: CloudLink | null = null

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 会话 token 用系统钥匙串（safeStorage）加密后再写盘；文件本身 0600。 */
function createStorage(): ReturnType<typeof createFileStorage> {
  return createFileStorage({
    file: join(app.getPath('userData'), 'guzi-cloud.json'),
    encrypt: (text) => (encryptionAvailable() ? SEALED_PREFIX + safeStorage.encryptString(text).toString('base64') : text),
    decrypt: (text) =>
      text.startsWith(SEALED_PREFIX) ? safeStorage.decryptString(Buffer.from(text.slice(SEALED_PREFIX.length), 'base64')) : text,
    writeFile: async (file, text) => {
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, file)
      chmodSync(file, 0o600)
    }
  })
}

async function initCloud(): Promise<void> {
  if (link) return
  const instance = new CloudLink({
    app: 'assistant',
    appVersion: app.getVersion(),
    platform: desktopPlatform(process.platform),
    deviceName: () => hostname().replace(/\.local$/i, '').trim() || 'Mac',
    storage: createStorage(),
    // 开发构建可以用环境变量指向本机的 guzi-cloud；发布版固定使用 guzilab.com。
    accountOrigin: app.isPackaged ? undefined : process.env.GUZI_CLOUD_ACCOUNT_ORIGIN,
    mcpOrigin: app.isPackaged ? undefined : process.env.GUZI_CLOUD_MCP_ORIGIN,
    tools: {
      list: async () => TOOLS.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as Record<string, unknown> })),
      call: (name, args) => executeMcpTool(name, args)
    },
    log: (line) => console.log(line)
  })
  instance.on('state', (state: CloudState) => broadcast('guzi-assistant:cloud-state', state))
  await instance.initialize()
  link = instance
  powerMonitor.on('resume', () => link?.nudge())
}

/** 启动云端 MCP。可选能力：失败只记录日志，设置页的云端分区会提示，不影响应用其余部分。 */
export function startCloud(): void {
  initCloud().catch((error) => console.error('[cloud] 云端 MCP 启动失败:', error))
}

export function getCloud(): CloudLink {
  if (!link) throw new Error('云端 MCP 未能启动，请重启应用后再试。')
  return link
}

export function stopCloud(): void {
  link?.dispose()
  link = null
}
