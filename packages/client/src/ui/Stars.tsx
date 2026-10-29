/** Star rating made of CSS shapes. `animate` pops earned stars in sequence. */
export function Stars({ value, animate = false, size = 'sm' }: { value: number; animate?: boolean; size?: 'sm' | 'lg' }) {
  return (
    <span className={`stars stars-${size}`} role="img" aria-label={`${value} of 3 stars`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`star${i < value ? ' on' : ''}${animate && i < value ? ' pop' : ''}`}
          style={animate ? { animationDelay: `${250 + i * 280}ms` } : undefined}
        />
      ))}
    </span>
  );
}
