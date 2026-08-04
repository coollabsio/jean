import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'
import antigravityLogo from '@/assets/antigravity-logo.png'

/**
 * Official Google Antigravity logo.
 * Source: https://antigravity.google/assets/image/antigravity-logo.png
 */
export const AntigravityIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 200 184"
      aria-label="Antigravity"
      {...props}
    >
      <image href={antigravityLogo} width="200" height="184" />
    </svg>
  )
)

AntigravityIcon.displayName = 'AntigravityIcon'
