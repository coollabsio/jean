import { forwardRef } from 'react'
import type { LucideProps } from '@/components/icons/reicon'

export const MuseIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Muse"
      {...props}
    >
      <path
        d="M4 19V6.5C4 5.67 4.67 5 5.5 5C6.03 5 6.52 5.28 6.79 5.74L12 14.5L17.21 5.74C17.48 5.28 17.97 5 18.5 5C19.33 5 20 5.67 20 6.5V19"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
)

MuseIcon.displayName = 'MuseIcon'
