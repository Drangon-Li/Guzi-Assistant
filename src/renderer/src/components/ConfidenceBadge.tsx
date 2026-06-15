export default function ConfidenceBadge({ value }: { value: number }): React.JSX.Element {
  const level = value >= 0.85 ? 'h' : value >= 0.6 ? 'm' : 'l'
  return (
    <span className={'conf ' + level}>
      <span className="bars"><i></i><i></i><i></i></span>
      {Math.round(value * 100)}%
    </span>
  )
}
