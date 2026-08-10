import { forwardRef } from 'react'
import type { LucideProps } from 'lucide-react'

export const AntigravityIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Antigravity CLI"
      {...props}
    >
      <path
        d="M12 2C12.72 7.76 16.24 11.28 22 12C16.24 12.72 12.72 16.24 12 22C11.28 16.24 7.76 12.72 2 12C7.76 11.28 11.28 7.76 12 2Z"
        fill="currentColor"
      />
    </svg>
  )
)

AntigravityIcon.displayName = 'AntigravityIcon'
