/**
 * 谷穗时间轴——主界面签名视觉：把「攒成收获」的口号变成看得见的。
 * 24 小时是一根穗轴，有活动的小时结成谷粒（左右交错如真麦穗），
 * 记录越密谷粒越饱满；无活动小时只留穗轴上的小节点。颜色走品牌 token，深浅色自动跟随。
 */

interface Props {
  /** 24 项：每小时的活动量（工作记录条数） */
  byHour: number[]
}

const W = 960
const H = 96
const STEM_Y = 54
const PAD = 24

export default function GrainEar({ byHour }: Props): React.JSX.Element {
  const max = Math.max(...byHour, 1)
  const step = (W - PAD * 2) / 23
  const total = byHour.reduce((n, c) => n + c, 0)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="今日谷穗：按小时的活动分布">
      {/* 穗轴：微弯的主茎，收获感来自"有东西挂在上面" */}
      <path
        d={`M ${PAD} ${STEM_Y + 3} Q ${W / 2} ${STEM_Y - 6} ${W - PAD} ${STEM_Y + 1}`}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-slate-200"
      />

      {byHour.map((count, h) => {
        const x = PAD + h * step
        // 穗轴的弯度上取近似 y（与上面的二次曲线一致）
        const t = (x - PAD) / (W - PAD * 2)
        const stemY = (1 - t) * (1 - t) * (STEM_Y + 3) + 2 * (1 - t) * t * (STEM_Y - 6) + t * t * (STEM_Y + 1)

        if (count === 0) {
          // 无活动：穗轴上的小节点，让茎看起来仍是活的
          return <circle key={h} cx={x} cy={stemY} r="1.6" className="fill-slate-200" />
        }

        const plump = count / max // 0..1 饱满度
        const up = h % 2 === 0 // 左右（上下）交错
        const cy = stemY + (up ? -9 - 4 * plump : 9 + 4 * plump)
        const rx = 4.5 + 6.5 * plump
        const ry = 3 + 4 * plump
        const angle = up ? -32 : 32

        return (
          <g key={h} transform={`rotate(${angle} ${x} ${cy})`}>
            {/* 粒柄 */}
            <line
              x1={x}
              y1={cy + (up ? ry : -ry)}
              x2={x}
              y2={cy + (up ? ry + 4 : -ry - 4)}
              strokeWidth="1.2"
              className="stroke-slate-300"
            />
            <ellipse
              cx={x}
              cy={cy}
              rx={rx}
              ry={ry}
              fill="var(--color-brand)"
              opacity={0.32 + 0.68 * plump}
              stroke="var(--color-brand-dark)"
              strokeOpacity="0.25"
              strokeWidth="0.8"
            >
              <title>{`${h}:00–${h + 1}:00 · ${count} 条记录${plump === 1 ? '（今日最饱满）' : ''}`}</title>
            </ellipse>
            {/* 最饱满一粒加高光，视线有落点 */}
            {plump === 1 && total > 2 && (
              <ellipse cx={x - rx * 0.3} cy={cy - ry * 0.35} rx={rx * 0.28} ry={ry * 0.22} className="fill-white/50" />
            )}
          </g>
        )
      })}

      {/* 时刻标尺 */}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={PAD + h * step} y={H - 4} textAnchor="middle" fontSize="10" className="fill-slate-400">
          {h}:00
        </text>
      ))}
      <text x={W - PAD} y={H - 4} textAnchor="middle" fontSize="10" className="fill-slate-400">
        24:00
      </text>
    </svg>
  )
}
