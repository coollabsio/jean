import type { LucideProps } from '@/components/icons/reicon'
import { forwardRef } from 'react'

export const OpenCodeIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-label="OpenCode"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
    </svg>
  )
)

OpenCodeIcon.displayName = 'OpenCodeIcon'
