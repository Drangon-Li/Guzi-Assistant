// 纯函数单测：isSafeDropPath（#3 dropbox 投递路径校验）。运行：npm run test:safepath
import { isSafeDropPath } from '../src/shared/safe-path.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const HOME = '/Users/test'
const ok = (p) => isSafeDropPath(p, HOME)

check('~/Desktop 普通文件 → 放行', ok('/Users/test/Desktop/notes.pdf'))
check('~/Documents 普通文件 → 放行', ok('/Users/test/Documents/作业.docx'))
check('外接卷 /Volumes → 放行', ok('/Volumes/USB/通知.txt'))
check('home 根下文件 → 放行', ok('/Users/test/a.txt'))

check('~/.ssh/id_rsa → 拦', !ok('/Users/test/.ssh/id_rsa'))
check('~/.aws/credentials → 拦', !ok('/Users/test/.aws/credentials'))
check('~/.env → 拦', !ok('/Users/test/.env'))
check('~/.config/x 子目录 → 拦', !ok('/Users/test/.config/secret/x.txt'))
check('/etc/passwd → 拦', !ok('/etc/passwd'))
check('/private/etc/hosts → 拦', !ok('/private/etc/hosts'))
check('/Library/Keychains → 拦', !ok('/Library/Keychains/login.keychain-db'))
check('其他用户目录 → 拦', !ok('/Users/other/secret.txt'))
check('根级散落 /tmpsecret → 拦', !ok('/tmpsecret/x.txt'))
check('路径含 .. 归一后越界 → 拦', !ok('/Users/test/../other/.ssh/id_rsa'))

process.exit(failed ? 1 : 0)
