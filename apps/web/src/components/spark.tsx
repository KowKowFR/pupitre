import { cn } from '@/lib/utils';

/**
 * A micro-curve without a scale — it only shows the shape ("it goes up"), the
 * readable figure is next to it. A soft area under the line.
 */
export function MicroSpark({
  values,
  width = 72,
  height = 22,
  tone = 'var(--n500)',
  max,
  dot = false,
  className,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  tone?: string;
  max: number;
  /** A dot on the last measurement. */
  dot?: boolean;
  className?: string;
}) {
  const ceiling = Math.max(1, max);
  const step = values.length > 1 ? (width - 2) / (values.length - 1) : 0;
  const toY = (value: number) => height - 1 - (Math.min(value, ceiling) / ceiling) * (height - 3);

  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: index * step + 1, y: toY(value) });
  });
  if (current.length > 0) segments.push(current);
  if (segments.length === 0) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={cn('block shrink-0 overflow-visible', className)}
    >
      {segments.map((segment) => {
        const first = segment[0];
        const last = segment[segment.length - 1];
        if (!first || !last) return null;
        const d = segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
        return (
          <g key={`${first.x}`}>
            {segment.length > 1 ? (
              <polygon
                points={`${first.x.toFixed(1)},${height} ${d} ${last.x.toFixed(1)},${height}`}
                fill={tone}
                opacity={0.1}
              />
            ) : null}
            {segment.length > 1 ? (
              <polyline
                points={d}
                fill="none"
                stroke={tone}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : (
              <circle cx={first.x} cy={first.y} r={2} fill={tone} />
            )}
          </g>
        );
      })}
      {dot
        ? (() => {
            const last = segments[segments.length - 1]?.at(-1);
            return last ? <circle cx={last.x} cy={last.y} r={2.2} fill={tone} /> : null;
          })()
        : null}
    </svg>
  );
}
