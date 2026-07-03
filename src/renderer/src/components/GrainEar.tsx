/**
 * 谷穗麦田——主界面签名视觉 v3：地平线就是一天的时间轴（0–24 时带刻度），
 * 每个有活动的小时长出一株麦子，穗高与穗形随记录密度生长；无活动小时留短茬。
 * 迭代记录：v1 把 24 小时平铺成"秃线挂圆点"、v2 密穗好看但弱化了时间线（用户两轮反馈）——
 * 本版高度=密度、横轴=时间，图表的可读性和麦田的收获感都保住。
 */

interface Props {
  /** 24 项：每小时的活动量（工作记录条数） */
  byHour: number[]
}

const W = 960
const H = 150
const GROUND = 118
const PADX = 34
// 谷粒：尖头饱腹的种子形（局部坐标竖放）
const GRAIN = 'M 0 -9 Q 6.5 -2.5 0 9 Q -6.5 -2.5 0 -9'

export default function GrainEar({ byHour }: Props): React.JSX.Element {
  const max = Math.max(...byHour, 1)
  const step = (W - PADX * 2) / 24

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="今日麦田：每小时活动长成的麦子">
      {/* 地平线（时间轴本体） */}
      <line
        x1={PADX - 8}
        y1={GROUND}
        x2={W - PADX + 8}
        y2={GROUND}
        stroke="var(--color-brand-dark)"
        opacity="0.3"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {[0, 6, 12, 18, 24].map((h) => (
        <g key={h}>
          <line x1={PADX + h * step} y1={GROUND} x2={PADX + h * step} y2={GROUND + 5} className="stroke-slate-400" strokeWidth="1" />
          <text x={PADX + h * step} y={GROUND + 22} textAnchor="middle" fontSize="11" className="fill-slate-400">
            {h}:00
          </text>
        </g>
      ))}

      {byHour.map((c, h) => {
        const x = PADX + (h + 0.5) * step
        // 茬：没长麦子的小时留短茬，地里仍有生气
        if (c === 0) return <line key={h} x1={x} y1={GROUND} x2={x} y2={GROUND - 4} className="stroke-slate-300" strokeWidth="1.2" />

        const plump = c / max
        const hgt = 22 + 56 * plump
        const s = (0.72 + 0.42 * plump) * 1.5
        const lean = h % 2 ? 5 : -5 // 交错微倾，像有风
        const topx = x + lean * (hgt / 46)
        const topy = GROUND - hgt

        return (
          <g key={h}>
            {/* 麦秆 */}
            <path
              d={`M ${x} ${GROUND} Q ${x + lean * 0.3} ${GROUND - hgt * 0.55} ${topx} ${topy}`}
              fill="none"
              stroke="var(--color-brand-dark)"
              opacity="0.45"
              strokeWidth="2"
              strokeLinecap="round"
            />
            {/* 穗头：主粒 + 麦芒；较饱满的小时两侧再结小穗 */}
            <g transform={`translate(${topx} ${topy}) rotate(${lean * 0.8})`}>
              <title>{`${h}:00–${h + 1}:00 · ${c} 条记录${c === max && max > 1 ? '（今日最饱满）' : ''}`}</title>
              <line x1="0" y1="-16" x2={lean > 0 ? 4 : -4} y2="-34" stroke="var(--color-brand-dark)" opacity="0.4" strokeWidth="1" />
              {plump > 0.34 && (
                <>
                  <g transform={`translate(-7 -3) rotate(-30) scale(${s * 0.62})`}>
                    <path d={GRAIN} fill="var(--color-brand)" opacity={0.4 + 0.5 * plump} />
                  </g>
                  <g transform={`translate(7 -3) rotate(30) scale(${s * 0.62})`}>
                    <path d={GRAIN} fill="var(--color-brand)" opacity={0.4 + 0.5 * plump} />
                  </g>
                </>
              )}
              <g transform={`translate(0 -8) scale(${s})`}>
                <path
                  d={GRAIN}
                  fill="var(--color-brand)"
                  opacity={0.55 + 0.45 * plump}
                  stroke="var(--color-brand-dark)"
                  strokeOpacity="0.3"
                  strokeWidth="0.8"
                />
                <path d="M 0 -6.5 Q 1.2 0 0 6.5" fill="none" stroke="var(--color-brand-dark)" opacity="0.25" strokeWidth="0.7" />
              </g>
            </g>
          </g>
        )
      })}
    </svg>
  )
}
