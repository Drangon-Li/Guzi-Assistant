import { homedir } from 'os'
import { resolve, sep } from 'path'

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
export function isSafeDropPath(p: string, home: string = homedir()): boolean {
  const abs = resolve(p)
  if (abs.split(sep).some((seg) => seg.length > 1 && seg.startsWith('.'))) return false
  if (SENSITIVE_PREFIXES.some((pre) => abs === pre || abs.startsWith(pre + sep))) return false
  if (!(abs === home || abs.startsWith(home + sep) || abs.startsWith('/Volumes' + sep))) return false
  return true
}
