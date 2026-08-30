import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

/** GitLab "tanuki" logo mark. */
export const GitLabIcon = forwardRef<SVGSVGElement, LucideProps>(
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
      <path d="m23.6 9.593-.033-.086-3.23-8.427a.84.84 0 0 0-.83-.576.84.84 0 0 0-.798.582l-2.18 6.674H7.47L5.29 1.086A.84.84 0 0 0 4.493.504a.84.84 0 0 0-.83.576L.433 9.507l-.032.086a5.996 5.996 0 0 0 1.988 6.929l.012.009.03.021 4.914 3.682 2.432 1.84 1.48 1.119a.99.99 0 0 0 1.196 0l1.48-1.119 2.433-1.84 4.943-3.703.013-.01a6 6 0 0 0 1.987-6.927Z" />
    </svg>
  )
)

GitLabIcon.displayName = 'GitLabIcon'
