import { execFile } from 'child_process'
import { win32 } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)
export const EXPLORER_FILE_FLAG = '--guzi-capture-file'
export const EXPLORER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.txt', '.md', '.eml', '.csv', '.log', '.pdf', '.docx']
const VERB = 'GuziAssistant.Capture'
const registryKey = (extension: string): string => `HKCU\\Software\\Classes\\SystemFileAssociations\\${extension}\\shell\\${VERB}`
const registryExe = (): string => win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')

export function explorerCommand(executable: string): string {
  if (!win32.isAbsolute(executable) || /["\0\r\n]/.test(executable)) throw new Error('无效的应用安装路径')
  return `"${executable}" ${EXPLORER_FILE_FLAG} "%1"`
}

export function explorerFilesFromArgv(argv: string[]): string[] {
  const index = argv.indexOf(EXPLORER_FILE_FLAG)
  return index >= 0 && index === argv.length - 2 && argv[index + 1] ? [argv[index + 1]] : []
}

export function windowsSecondInstanceArgv(additionalData: unknown): string[] {
  if (!additionalData || typeof additionalData !== 'object' || Array.isArray(additionalData) || !('argv' in additionalData)) return []
  const { argv } = additionalData
  return Array.isArray(argv) && Array.from(argv).every((arg) => typeof arg === 'string') ? argv : []
}

export async function windowsIntegrationInstalled(executable: string): Promise<boolean> {
  const command = explorerCommand(executable)
  try {
    for (const extension of EXPLORER_EXTENSIONS) {
      await run(registryExe(), ['query', `${registryKey(extension)}\\command`, '/ve', '/f', command, '/d', '/e', '/t', 'REG_SZ'], { windowsHide: true })
    }
    return true
  } catch { return false }
}

export async function installWindowsIntegration(executable: string): Promise<boolean> {
  const command = explorerCommand(executable)
  try {
    for (const extension of EXPLORER_EXTENSIONS) {
      const key = registryKey(extension)
      for (const args of [
        ['add', key, '/ve', '/d', '发送到 谷子助手', '/f'],
        ['add', key, '/v', 'Icon', '/d', `"${executable}",0`, '/f'],
        ['add', key, '/v', 'MultiSelectModel', '/d', 'Single', '/f'],
        ['add', `${key}\\command`, '/ve', '/d', command, '/f']
      ]) await run(registryExe(), args, { windowsHide: true })
    }
    return true
  } catch (error) {
    console.warn('[explorer] 安装失败：', error)
    return false
  }
}

export async function uninstallWindowsIntegration(): Promise<boolean> {
  try {
    for (const extension of EXPLORER_EXTENSIONS) {
      const key = registryKey(extension)
      try { await run(registryExe(), ['query', key], { windowsHide: true }) } catch { continue }
      await run(registryExe(), ['delete', key, '/f'], { windowsHide: true })
    }
    return true
  } catch (error) {
    console.warn('[explorer] 移除失败：', error)
    return false
  }
}
