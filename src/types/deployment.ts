export type DeploymentState = 'deployed' | 'pending' | 'uncertain'

export interface DeploymentPullRequest {
  number: number
  title: string
  branch: string
  url: string
  mergeCommit: string
  mergedAt: string
}

export interface DeploymentWorktree {
  id: string
  name: string
  branch: string
}

export interface DeploymentTask {
  taskId: string
  name: string
  url?: string
  state: DeploymentState
  pullRequest?: DeploymentPullRequest
  worktrees: DeploymentWorktree[]
  reason?: string
}

export interface DeploymentOverview {
  projectId: string
  projectName: string
  productionSha: string
  remoteBranch: string
  versionUrl: string
  tasks: DeploymentTask[]
}

export interface CloseDeploymentResult {
  taskId: string
  closed: boolean
  archivedWorktreeIds: string[]
  archiveErrors: string[]
  error?: string
}
