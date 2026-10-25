import assert from 'node:assert/strict'
import { isSafeDropPath } from '../src/shared/safe-path.ts'

const safe = (p) => isSafeDropPath(p, 'C:\\Users\\tester', 'win32')
for (const path of ['C:\\Users\\tester\\Desktop\\通知.pdf', 'c:/users/TESTER/Documents/a.txt', 'C:\\Users\\tester\\OneDrive\\桌面\\notes.docx']) {
  assert.equal(safe(path), true, path)
}
for (const path of [
  'C:\\Users\\tester2\\Desktop\\notes.txt', 'C:\\Users\\other\\a.txt',
  'C:\\Users\\tester\\..\\other\\a.txt', 'C:\\Users\\tester\\AppData\\Local\\secret.txt',
  'C:\\Users\\tester\\Desktop\\.env', 'C:\\Users\\tester\\.ssh\\id_rsa',
  'C:\\Users\\tester\\Desktop\\a.txt:secret', '\\\\server\\share\\notes.txt',
  '\\\\?\\C:\\Users\\tester\\notes.txt', 'C:notes.txt', 'notes.txt',
  'C:\\Windows\\system.ini', 'C:\\Users\\tester\\Desktop\\NUL.txt',
  'C:\\Users\\tester\\AppData \\secret.txt', 'C:\\Users\\tester\\Desktop\\file.txt.',
  'C:\\Users\\tester\\Desktop\\a\u0000.txt'
]) assert.equal(safe(path), false, path)
assert.equal(isSafeDropPath('/Users/test/Desktop/a.pdf', '/Users/test', 'darwin'), true)
assert.equal(isSafeDropPath('/Volumes/USB/a.txt', '/Users/test', 'darwin'), true)
console.log('Windows path boundaries, device paths, ADS, private directories and Mac compatibility passed')
