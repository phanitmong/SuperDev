interface Props {
  values: number[]
  /** Fixed upper bound. Omit to scale to the data. */
  max?: number
  color: string
  /** Optional second series drawn as a line only. */
  second?: number[]
  secondColor?: string
  slots?: number
}

/** Small area chart. Purely decorative trend; exact values are shown as text next to it. */
export default function Sparkline({ values, max, color, second, secondColor = '#f59a23', slots = 60 }: Props) {
  const W = 300
  const H = 72
  const top = max ?? Math.max(1, ...values, ...(second ?? [])) * 1.15
  const path = (series: number[]): string => {
    const start = slots - series.length
    return series
      .map((v, i) => {
        const x = ((start + i) / (slots - 1)) * W
        const y = H - 2 - (Math.min(v, top) / top) * (H - 6)
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }
  const line = path(values)
  const startX = ((slots - values.length) / (slots - 1)) * W
  const id = `g${color.replace('#', '')}`
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 && (
        <>
          <path d={`${line} L${W},${H} L${startX.toFixed(1)},${H} Z`} fill={`url(#${id})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </>
      )}
      {second && second.length > 1 && (
        <path d={path(second)} fill="none" stroke={secondColor} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      )}
    </svg>
  )
}
