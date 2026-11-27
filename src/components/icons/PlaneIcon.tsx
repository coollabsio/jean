import type { LucideProps } from '@/components/icons/reicon'
import { forwardRef } from 'react'

/** Simple mark for the Plane integration (not the official logo). */
export const PlaneIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M2 2h7v7H2zM9 9h6.5v6.5H9zM15.5 15.5H22V22h-6.5z" />
      <path d="M9 2h6.5v7H9zM15.5 9H22v6.5h-6.5z" opacity=".45" />
    </svg>
  )
)

PlaneIcon.displayName = 'PlaneIcon'
