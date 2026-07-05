import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

export const AntigravityIcon = forwardRef<SVGSVGElement, LucideProps>(
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
      aria-label="Antigravity"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m16 10-4-4-4 4" />
      <path d="M12 6v12" />
    </svg>
  )
)

AntigravityIcon.displayName = 'AntigravityIcon'
