/**
 * 谷穗——主界面签名视觉：一支横卧的麦穗，今天每个有活动的小时结一粒谷。
 * 谷粒从穗尖往下成对交错密排（真实麦穗的长法），粒数少=初生的穗尖、粒数多=沉甸甸一整穗，
 * 永远不会出现"秃轴挂零星圆点"。记录越密的小时谷粒越饱满；麦芒是麦穗的辨识度所在。
 * 手绘贝塞尔 + 品牌 token，深浅色自适应，无外部素材。
 */

interface Props {
  /** 24 项：每小时的活动量（工作记录条数） */
  byHour: number[]
}

interface Pt {
  x: number
  y: number
}

// 穗秆：从左下向右上的舒缓曲线，穗尖在右
const P0: Pt = { x: 40, y: 106 }
const P1: Pt = { x: 300, y: 102 }
const P2: Pt = { x: 610, y: 74 }
const P3: Pt = { x: 926, y: 44 }

function bezPoint(t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * P0.x + 3 * u * u * t * P1.x + 3 * u * t * t * P2.x + t * t * t * P3.x,
    y: u * u * u * P0.y + 3 * u * u * t * P1.y + 3 * u * t * t * P2.y + t * t * t * P3.y
  }
}

function bezAngleDeg(t: number): number {
  const u = 1 - t
  const dx = 3 * u * u * (P1.x - P0.x) + 6 * u * t * (P2.x - P1.x) + 3 * t * t * (P3.x - P2.x)
  const dy = 3 * u * u * (P1.y - P0.y) + 6 * u * t * (P2.y - P1.y) + 3 * t * t * (P3.y - P2.y)
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

// 谷粒：尖头饱腹的种子形（局部坐标竖放，尖端朝 -y）
const GRAIN_PATH = 'M 0 -11 Q 7.5 -3 0 11 Q -7.5 -3 0 -11'

export default function GrainEar({ byHour }: Props): React.JSX.Element {
  const active = byHour
    .map((count, hour) => ({ hour, count }))
    .filter((g) => g.count > 0)
  const max = Math.max(...active.map((g) => g.count), 1)
  const n = active.length

  // 从穗尖(0.97)往穗基倒排、固定小间距密排：粒少=初生穗尖，粒多=沉甸甸整穗，
  // 谷粒相互叠压才是真麦穗的长法（间距拉开就成了"树枝挂叶子"，实测翻过车）
  const gap = 0.026
  const stalkPath = `M ${P0.x} ${P0.y} C ${P1.x} ${P1.y} ${P2.x} ${P2.y} ${P3.x} ${P3.y}`

  return (
    <svg viewBox="0 0 960 132" className="h-auto w-full" role="img" aria-label="今日谷穗：活动小时结成的谷粒">
      {/* 穗秆（麦秆的暖金，不用冷灰） */}
      <path d={stalkPath} fill="none" strokeWidth="3" strokeLinecap="round" stroke="var(--color-brand-dark)" opacity="0.32" />
      {/* 基部一片叶，给秆一点生气 */}
      <g transform={`translate(${bezPoint(0.14).x} ${bezPoint(0.14).y}) rotate(${bezAngleDeg(0.14) + 142}) scale(1.5 2.4)`}>
        <path d={GRAIN_PATH} fill="var(--color-brand)" opacity="0.14" />
      </g>

      {active.map((g, i) => {
        const t = 0.97 - (n - 1 - i) * gap
        const at = bezPoint(t)
        const theta = bezAngleDeg(t)
        const side = i % 2 === 0 ? 1 : -1
        const plump = g.count / max
        const s = (0.85 + 0.45 * plump) * 1.6
        // 谷粒收拢贴秆：尖端方向 = 切线 ∓ 28°，交错分居穗轴两侧
        const tipDir = theta - side * 28
        const rot = tipDir + 90 // 把局部 -y（粒尖）转到 tipDir
        const rad = ((tipDir * Math.PI) / 180)
        const cx = at.x + Math.cos(rad) * 11 * s * 0.45
        const cy = at.y + Math.sin(rad) * 11 * s * 0.45

        return (
          <g key={g.hour} transform={`translate(${cx} ${cy}) rotate(${rot}) scale(${s})`}>
            {/* 麦芒：从粒尖伸出的长须，麦穗的辨识度所在 */}
            <line x1="0" y1="-11" x2={side * 5} y2="-34" strokeWidth="1" stroke="var(--color-brand-dark)" opacity="0.4" />
            <path
              d={GRAIN_PATH}
              fill="var(--color-brand)"
              opacity={0.5 + 0.5 * plump}
              stroke="var(--color-brand-dark)"
              strokeOpacity="0.3"
              strokeWidth="0.8"
            >
              <title>{`${g.hour}:00–${g.hour + 1}:00 · ${g.count} 条记录${g.count === max && n > 2 ? '（今日最饱满）' : ''}`}</title>
            </path>
            {/* 腹沟：谷粒中线，一笔就够 */}
            <path d="M 0 -8 Q 1.5 0 0 8" fill="none" strokeWidth="0.7" stroke="var(--color-brand-dark)" opacity="0.25" />
          </g>
        )
      })}

      {n === 0 && (
        // 空穗：尖端两片小芽，等着结粒
        <>
          <g transform={`translate(${P3.x - 4} ${P3.y + 2}) rotate(${bezAngleDeg(0.97) + 52}) scale(0.55)`}>
            <path d={GRAIN_PATH} fill="var(--color-brand)" opacity="0.28" />
          </g>
          <g transform={`translate(${P3.x - 10} ${P3.y + 6}) rotate(${bezAngleDeg(0.95) + 128}) scale(0.55)`}>
            <path d={GRAIN_PATH} fill="var(--color-brand)" opacity="0.28" />
          </g>
        </>
      )}
    </svg>
  )
}
