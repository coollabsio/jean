import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

export const GrokIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 34 32"
      fill="none"
      aria-label="Grok"
      {...props}
    >
      <path
        d="M13.37 20.54L24.46 12.35C25 11.95 25.78 12.11 26.03 12.73C27.4 16.02 26.79 19.97 24.08 22.69C21.37 25.4 17.59 25.99 14.15 24.64L10.38 26.38C15.78 30.08 22.34 29.17 26.44 25.06C29.69 21.81 30.7 17.37 29.76 13.37L29.77 13.38C28.4 7.5 30.1 5.15 33.59 0.34C33.67 0.23 33.75 0.12 33.83 0L29.25 4.59V4.58L13.37 20.54"
        fill="currentColor"
      />
      <path
        d="M11.09 22.53C7.21 18.82 7.88 13.09 11.19 9.78C13.63 7.33 17.64 6.33 21.14 7.8L24.9 6.06C24.22 5.57 23.35 5.04 22.36 4.67C17.86 2.82 12.47 3.74 8.81 7.4C5.29 10.92 4.19 16.34 6.09 20.96C7.51 24.42 5.18 26.86 2.84 29.33C2 30.2 1.17 31.07 0.5 32L11.08 22.53"
        fill="currentColor"
      />
    </svg>
  )
)

GrokIcon.displayName = 'GrokIcon'
