import { forwardRef, type SVGProps } from 'react'

type IssueIconProps = SVGProps<SVGSVGElement> & {
  size?: string | number
}

export const IssueIcon = forwardRef<SVGSVGElement, IssueIconProps>(
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
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  )
)

IssueIcon.displayName = 'IssueIcon'
