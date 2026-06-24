// 纯函数单测：缓动曲线、重力地板、显示器 clamp（经注入 screen）。运行：npm run test:petmotion
import {
  _setScreenForTesting,
  clampToVisibleWorkArea,
  clampToNearestDisplayIfOffscreen,
  isOnAnyDisplay
} from '../src/main/pet/display.ts'
import { easeProgress, computeGravityFloor } from '../src/main/pet/motion-math.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const near = (a, b) => Math.abs(a - b) < 1e-9

// 缓动
check('linear', near(easeProgress(0.7, 'linear'), 0.7))
check('ease-in(0.5)=0.25', near(easeProgress(0.5, 'ease-in'), 0.25))
check('ease-out(0.5)=0.75', near(easeProgress(0.5, 'ease-out'), 0.75))
check('ease-in-out(0)=0', near(easeProgress(0, 'ease-in-out'), 0))
check('ease-in-out(1)=1', near(easeProgress(1, 'ease-in-out'), 1))
check('ease-in-out(0.5)=0.5', near(easeProgress(0.5, 'ease-in-out'), 0.5))

// 重力地板
check('gravityFloor(0,1000,420)=580', computeGravityFloor(0, 1000, 420) === 580)
check('gravityFloor 带偏移', computeGravityFloor(100, 1080, 420) === 760)

// 显示器 clamp：注入单显示器 1920×1080
const display = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
}
_setScreenForTesting({
  getAllDisplays: () => [display],
  getPrimaryDisplay: () => display,
  getDisplayNearestPoint: () => display
})

// 桌宠 340×420 → maxX=1920-340=1580, maxY=1080-420=660
const c1 = clampToVisibleWorkArea({ x: 5000, y: 5000 })
check('右下越界 → (1580,660)', c1.x === 1580 && c1.y === 660)
const c2 = clampToVisibleWorkArea({ x: -100, y: -100 })
check('左上越界 → (0,0)', c2.x === 0 && c2.y === 0)

check('屏内 → isOnAnyDisplay true', isOnAnyDisplay({ x: 100, y: 100 }, 340, 420) === true)
check('远离 → isOnAnyDisplay false', isOnAnyDisplay({ x: 5000, y: 5000 }, 340, 420) === false)

const v = clampToNearestDisplayIfOffscreen({ x: 100, y: 100 })
check('屏内 → 原样返回', v.x === 100 && v.y === 100)
const v2 = clampToNearestDisplayIfOffscreen({ x: 5000, y: 5000 })
check('离屏 → 吸附 (1580,660)', v2.x === 1580 && v2.y === 660)

_setScreenForTesting(null)
process.exit(failed ? 1 : 0)
