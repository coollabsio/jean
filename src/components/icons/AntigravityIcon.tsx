import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

/**
 * Antigravity (Google) CLI icon — a stylized orbit/gravity-well mark.
 */
export const AntigravityIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-label="Antigravity"
      {...props}
    >
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        transform="rotate(-30 12 12)"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        transform="rotate(30 12 12)"
      />
    </svg>
  )
)

AntigravityIcon.displayName = 'AntigravityIcon'
