import type { LucideProps } from '@/components/icons/reicon'
import { forwardRef } from 'react'

export const PiIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 800 800"
      fill="none"
      aria-label="Pi"
      {...props}
    >
      <rect width="800" height="800" rx="120" fill="#09090b" />
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  )
)

PiIcon.displayName = 'PiIcon'
