import { cn } from '@/lib/utils'

interface BorderSpinnerProps {
  shape: 'square' | 'circle'
  className?: string
  bgClassName?: string
}

export function BorderSpinner({
  shape,
  className,
  bgClassName,
}: BorderSpinnerProps) {
  // Use larger viewBox for better rendering at small sizes
  // Perimeter: circle ≈ 75 (2πr where r=12), square ≈ 88
  const perimeter = shape === 'circle' ? 75 : 88

  return (
    <svg
      viewBox="0 0 28 28"
      className={cn('shrink-0', className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {shape === 'circle' ? (
        <>
          {/* Background circle */}
          <circle
            cx="14"
            cy="14"
            r="12"
            className={bgClassName}
            fill="transparent"
          />
          {/* Animated stroke */}
          <circle
            cx="14"
            cy="14"
            r="12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="animate-border-spin"
            style={{
              strokeDasharray: `${perimeter * 0.3} ${perimeter * 0.7}`,
              strokeDashoffset: perimeter,
            }}
          />
        </>
      ) : (
        <>
          {/* Background square */}
          <rect
            x="2"
            y="2"
            width="24"
            height="24"
            rx="4"
            className={bgClassName}
            fill="transparent"
          />
          {/* Animated stroke */}
          <rect
            x="2"
            y="2"
            width="24"
            height="24"
            rx="4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="animate-border-spin"
            style={{
              strokeDasharray: `${perimeter * 0.3} ${perimeter * 0.7}`,
              strokeDashoffset: perimeter,
            }}
          />
        </>
      )}
    </svg>
  )
}
