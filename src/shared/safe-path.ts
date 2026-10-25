import { homedir } from 'os'
import { posix, win32 } from 'path'

/** 拦截的系统目录前缀（投递这些下面的文件没有正常用途，多是凭据/系统文件） */
const SENSITIVE_PREFIXES = ['/etc', '/private', '/var', '/usr', '/bin', '/sbin', '/System', '/Library']

/**
 * dropbox manifest 投递路径校验（#3 安全加固）。
 * 威胁：本地恶意程序写 manifest 投递 `~/.ssh/id_rsa` 等敏感文件 → 内容被发往解析 API。
 * 策略（保功能前提下挡凭据重灾区）：
 *  - 拒绝任何「点开头」路径段（.ssh/.aws/.env/.config/.gnupg/.docker… 凭据集中地）；
 *  - 拒绝系统目录（/etc /private /usr /Library…）；
 *  - 仅允许用户 home 或外接卷 /Volumes 下的文件（挡其他用户目录、根级散落）。
 * 正常用户文件（~/Desktop、~/Documents、外接盘）不受影响。
 */
export function isSafeDropPath(p: string, home: string = homedir(), platform: string = process.platform): boolean {
  if (platform === 'win32') {
    // Explorer ingress is automatic: network/device paths and alternate data streams must not reach parsing.
    if (!/^[a-z]:[\\/]/i.test(p) || /[\x00-\x1f]/.test(p) || p.slice(2).includes(':')) return false
    const segments = p.split(/[\\/]/)
    if (segments.some((s) => (s.length > 1 && s.startsWith('.') && s !== '..') || /[ .]$/.test(s) && s !== '..')) return false
    const abs = win32.resolve(p).toLowerCase()
    const root = win32.resolve(home).toLowerCase().replace(/\\+$/, '')
    if (!(abs.startsWith(root + '\\'))) return false
    const relative = abs.slice(root.length + 1).split('\\')
    if (relative.some((s) => s === 'appdata' || s.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) return false
    return true
  }
  const { resolve, sep } = posix
  const abs = resolve(p)
  home = resolve(home)
  if (abs.split(sep).some((seg) => seg.length > 1 && seg.startsWith('.'))) return false
  if (SENSITIVE_PREFIXES.some((pre) => abs === pre || abs.startsWith(pre + sep))) return false
  if (!(abs === home || abs.startsWith(home + sep) || abs.startsWith('/Volumes' + sep))) return false
  return true
}
