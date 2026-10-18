import { forwardRef, type SVGProps } from 'react'

type MarkdownIconProps = SVGProps<SVGSVGElement> & {
  size?: string | number
}

export const MarkdownIcon = forwardRef<SVGSVGElement, MarkdownIconProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M6 15V9l2.5 3L11 9v6" />
      <path d="M16.5 9v6M14.5 13l2 2 2-2" />
    </svg>
  )
)

MarkdownIcon.displayName = 'MarkdownIcon'
