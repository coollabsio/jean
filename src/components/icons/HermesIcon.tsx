import { forwardRef } from 'react'
import type { LucideProps } from 'lucide-react'

/** Simple caduceus-inspired mark for Hermes Agent. */
export const HermesIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Hermes Agent"
      {...props}
    >
      <path
        d="M12 2v20"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 5c3.5 1.5 5.5 3.2 5.5 5.5S15.5 14 12 15.5C8.5 14 6.5 12.3 6.5 10.5S8.5 6.5 12 5z"
        stroke="#c9a227"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M12 10.5c3.2 1.2 5 2.7 5 4.5s-1.8 3.3-5 4.5c-3.2-1.2-5-2.7-5-4.5s1.8-3.3 5-4.5z"
        stroke="#c9a227"
        strokeWidth="1.5"
        fill="none"
      />
      <circle cx="12" cy="3.2" r="1.2" fill="#c9a227" />
    </svg>
  )
)

HermesIcon.displayName = 'HermesIcon'
