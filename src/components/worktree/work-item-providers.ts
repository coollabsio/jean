import type { ComponentType } from 'react'
import { isLinearAuthError } from '@/services/linear'
import { isPlaneAuthError } from '@/services/plane'
import { LinearAuthError } from '@/components/shared/LinearAuthError'
import { PlaneAuthError } from '@/components/shared/PlaneAuthError'

/** Issue trackers whose items share the Linear issue shape and list UI. */
export type WorkItemProvider = 'linear' | 'plane'

export interface WorkItemProviderConfig {
  label: string
  /** Plural noun for list copy, e.g. "issues" */
  noun: string
  /** Section heading, e.g. "Linear Issues" */
  title: string
  isAuthError: (error: unknown) => boolean
  AuthError: ComponentType
}

export const WORK_ITEM_PROVIDERS: Record<
  WorkItemProvider,
  WorkItemProviderConfig
> = {
  linear: {
    label: 'Linear',
    noun: 'issues',
    title: 'Linear Issues',
    isAuthError: isLinearAuthError,
    AuthError: LinearAuthError,
  },
  plane: {
    label: 'Plane',
    noun: 'work items',
    title: 'Plane Work Items',
    isAuthError: isPlaneAuthError,
    AuthError: PlaneAuthError,
  },
}
