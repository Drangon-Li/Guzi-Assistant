export default function ConfidenceBadge({ value }: { value: number }): React.JSX.Element {
  const pct = Math.round(value * 100)
  const cls =
    value >= 0.85
      ? 'bg-emerald-100 text-emerald-700'
      : value >= 0.6
        ? 'bg-amber-100 text-amber-700'
        : 'bg-slate-200 text-slate-600'
  return (
    <span className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 ${cls}`}>
      置信 {pct}%
    </span>
  )
}
