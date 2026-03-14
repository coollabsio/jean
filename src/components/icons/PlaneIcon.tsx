import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

export const PlaneIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2 12h20" />
      <path d="M13 5l7 7-7 7" />
      <path d="M5 12l7 7 7-7" />
    </svg>
  )
)

PlaneIcon.displayName = 'PlaneIcon'
