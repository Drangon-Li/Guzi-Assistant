export default function ConfidenceBadge({ value }: { value: number }): React.JSX.Element {
  const pct = Math.round(value * 100)
  const level = value >= 0.85 ? 3 : value >= 0.6 ? 2 : 1
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
      <span className="inline-flex items-center gap-[3px]">
        <i className={`block w-[3px] h-2.5 rounded-[1px] ${level >= 1 ? 'bg-slate-500' : 'bg-slate-200'}`} />
        <i className={`block w-[3px] h-2.5 rounded-[1px] ${level >= 2 ? 'bg-slate-500' : 'bg-slate-200'}`} />
        <i className={`block w-[3px] h-2.5 rounded-[1px] ${level >= 3 ? 'bg-slate-500' : 'bg-slate-200'}`} />
      </span>
      <span className="tabular-nums">{pct}%</span>
    </span>
  )
}
