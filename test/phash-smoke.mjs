// 纯函数单测：dhash / hamming / textHash（#40 屏幕监控的本地变化门核心）。运行：npm run test:phash
import { dhash, hamming, bgraToGray, textHash } from '../src/shared/phash.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// 9×8 灰度：每行严格递增 → 每个相邻比较都是 左<右 → 全 1（64 bit 全置位）
const incRow = Array.from({ length: 9 }, (_, x) => x * 10)
const allInc = Array.from({ length: 8 }, () => incRow).flat()
const hAll = dhash(allInc, 9, 8)
check('严格递增行 → 64 bit 全 1', hAll === (1n << 64n) - 1n)

// 每行严格递减 → 全 0
const decRow = Array.from({ length: 9 }, (_, x) => (8 - x) * 10)
const allDec = Array.from({ length: 8 }, () => decRow).flat()
check('严格递减行 → 全 0', dhash(allDec, 9, 8) === 0n)

check('同图汉明距离 = 0', hamming(hAll, hAll) === 0)
check('全1 vs 全0 汉明距离 = 64', hamming(hAll, 0n) === 64)
check('单 bit 差 → 距离 1', hamming(0n, 1n) === 1)

// 改一行的一个像素关系，应只影响 1 bit（距离 1）
const oneFlip = allInc.slice()
oneFlip[0] = 1000 // 第一行第0像素变成最大 → 第0个比较从 左<右 变 左>右
const hFlip = dhash(oneFlip, 9, 8)
check('单像素翻转 → 汉明距离 1', hamming(hAll, hFlip) === 1)

// bgraToGray：纯红 BGRA(0,0,255,255) 一个像素 → 灰度≈74.5
const gray = bgraToGray([0, 0, 255, 255], 1, 1)
check('BGRA 纯红 → 灰度≈74.5', Math.abs(gray[0] - 76.245) < 1)

// textHash：折叠空白后相同 → 同哈希；不同内容 → 不同
check('空白差异 → 同哈希', textHash('开会  通知\n明天') === textHash('开会 通知 明天'))
check('内容不同 → 不同哈希', textHash('开会通知') !== textHash('放假通知'))
check('稳定可复现', textHash('数据库期末项目') === textHash('数据库期末项目'))

process.exit(failed ? 1 : 0)
