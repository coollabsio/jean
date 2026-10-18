import { forwardRef, type SVGProps } from 'react'

type GitCommitIconProps = SVGProps<SVGSVGElement> & {
  size?: string | number
}

export const GitCommitIcon = forwardRef<SVGSVGElement, GitCommitIconProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M2 12h6m8 0h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle
        cx="12"
        cy="12"
        r="4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
)

GitCommitIcon.displayName = 'GitCommitIcon'
