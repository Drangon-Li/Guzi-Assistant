/**
 * 谷穗麦田——主界面签名视觉 v4：地平线是一天的时间轴（0–24 时带刻度），
 * 每个有活动的小时长出一株麦子；记录越多 → 穗段越长、结粒越多（成对谷粒可数），
 * 「时间越长麦穗越多」一眼可见。无活动小时留短茬。
 * 迭代记录：v1 秃线挂圆点 → v2 密穗但丢了时间线 → v3 高度=密度 → v4 粒数=密度（用户逐轮反馈）。
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
        const pairs = Math.max(1, Math.min(5, Math.ceil(plump * 5))) // 记录越多结粒越多
        const earLen = 4 + pairs * 8 // 穗段随粒数变长；对距 8px 保证粒粒可辨（7px 时高密会糊成实心块）
        const stemH = 12 + 22 * plump + (h % 2 ? 6 : 0) // 相邻株高交错，满穗连排也不挤成一坨
        const sg = 0.6 + 0.2 * plump
        const lean = h % 2 ? 5 : -5 // 交错微倾，像有风
        const bx = x + lean * (stemH / 46)
        const by = GROUND - stemH // 秆顶 = 穗基

        const grainProps = {
          fill: 'var(--color-brand)',
          stroke: 'var(--color-brand-dark)',
          strokeOpacity: 0.3,
          strokeWidth: 0.8
        }
        const awnProps = { stroke: 'var(--color-brand-dark)', opacity: 0.4, strokeWidth: 1 }

        return (
          <g key={h}>
            {/* 麦秆（纯秆段） */}
            <path
              d={`M ${x} ${GROUND} Q ${x + lean * 0.3} ${GROUND - stemH * 0.55} ${bx} ${by}`}
              fill="none"
              stroke="var(--color-brand-dark)"
              opacity="0.45"
              strokeWidth="2"
              strokeLinecap="round"
            />
            {/* 穗（整体微倾）：穗轴 + 成对谷粒自穗尖向下叠 + 尖端麦芒扇 */}
            <g transform={`translate(${bx} ${by}) rotate(${lean * 0.9})`}>
              <title>{`${h}:00–${h + 1}:00 · ${c} 条记录 · 结 ${pairs * 2 + 1} 粒${c === max && max > 1 ? '（今日最饱满）' : ''}`}</title>
              <line x1="0" y1="0" x2="0" y2={-earLen} stroke="var(--color-brand-dark)" opacity="0.4" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="0" y1={-earLen} x2="-5" y2={-earLen - 15} {...awnProps} />
              <line x1="0" y1={-earLen} x2="1" y2={-earLen - 18} {...awnProps} />
              <line x1="0" y1={-earLen} x2="6" y2={-earLen - 14} {...awnProps} />
              {/* 尖端主粒 */}
              <g transform={`translate(0 ${-earLen}) scale(${sg})`}>
                <path d={GRAIN} opacity={0.55 + 0.45 * plump} {...grainProps} />
                <path d="M 0 -6.5 Q 1.2 0 0 6.5" fill="none" stroke="var(--color-brand-dark)" opacity="0.25" strokeWidth="0.7" />
              </g>
              {/* 成对谷粒：自穗尖向下每 7px 一对，粒数=密度 */}
              {Array.from({ length: pairs }, (_, k) => {
                const yk = -earLen + 8 + k * 8
                return [-1, 1].map((side) => (
                  <g key={`${k}${side}`} transform={`translate(${side * 4.5} ${yk}) rotate(${side * 38}) scale(${sg})`}>
                    <path d={GRAIN} opacity={0.5 + 0.5 * plump} {...grainProps} />
                    <path d="M 0 -6.5 Q 1.2 0 0 6.5" fill="none" stroke="var(--color-brand-dark)" opacity="0.22" strokeWidth="0.7" />
                  </g>
                ))
              })}
            </g>
          </g>
        )
      })}
    </svg>
  )
}
