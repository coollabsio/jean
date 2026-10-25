import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type { ProjectHostCheckout } from '@/types/projects'

export class StartOnHostCancelled extends Error {
  constructor() {
    super('Start cancelled')
    this.name = 'StartOnHostCancelled'
  }
}

export function isStartOnHostCancelled(error: unknown): boolean {
  return error instanceof StartOnHostCancelled
}

export interface EnvCopyOffer {
  sourceServerId: string
  sourceServerName: string
  sourceProjectPath: string
  files: string[]
}

export interface EnvHostFiles {
  serverId: string
  serverName: string
  projectPath: string
  files: string[]
}

/** Files the target is missing, from the host that can supply the most of them. */
export function envFilesToOffer(
  targetFiles: string[],
  sources: EnvHostFiles[]
): EnvCopyOffer | null {
  const present = new Set(targetFiles)
  let best: EnvCopyOffer | null = null
  for (const source of sources) {
    const missing = source.files.filter(name => !present.has(name))
    if (missing.length === 0) continue
    const offer: EnvCopyOffer = {
      sourceServerId: source.serverId,
      sourceServerName: source.serverName,
      sourceProjectPath: source.projectPath,
      files: missing,
    }
    if (!best || missing.length > best.files.length) {
      best = offer
      continue
    }
    if (
      missing.length === best.files.length &&
      source.serverId === LOCAL_SERVER_ID &&
      best.sourceServerId !== LOCAL_SERVER_ID
    ) {
      best = offer
    }
  }
  return best
}

export interface StartProjectInput {
  id: string
  name: string
  path: string
  serverId?: string
  serverName?: string
  hostCheckouts?: ProjectHostCheckout[]
}

export interface StartProjectOnHostInput {
  project: StartProjectInput
  targetServerId: string
  targetServerName: string
  targetOnline: boolean
  targetError?: string | null
}

export interface StartProjectOnHostResult {
  projectId: string
  serverId: string
  projectPath: string
  status: 'current' | 'present' | 'cloned'
}

interface EnsureProjectResponse {
  status?: string
  project?: { id?: string; path?: string }
}

export interface StartProjectOnHostDeps {
  invoke: (
    serverId: string,
    command: string,
    args?: Record<string, unknown>
  ) => Promise<unknown>
  confirmEnvCopy: (offer: EnvCopyOffer) => Promise<'copy' | 'skip' | 'cancel'>
  onProgress?: (message: string) => void
  isCancelled?: () => boolean
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function sourceCheckouts(project: StartProjectInput): ProjectHostCheckout[] {
  if (project.hostCheckouts && project.hostCheckouts.length > 0) {
    return project.hostCheckouts
  }
  const serverId = project.serverId ?? LOCAL_SERVER_ID
  return [
    {
      serverId,
      projectId: project.id,
      path: project.path,
      serverName:
        project.serverName ??
        (serverId === LOCAL_SERVER_ID ? 'Local' : serverId),
    },
  ]
}

function throwIfCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) throw new StartOnHostCancelled()
}

/**
 * Make the project runnable on `targetServerId`.
 *
 * An existing checkout is reused. A missing checkout is cloned from the
 * project's remotes. Env files are copied only after `confirmEnvCopy`.
 */
export async function startProjectOnHost(
  input: StartProjectOnHostInput,
  deps: StartProjectOnHostDeps
): Promise<StartProjectOnHostResult> {
  const sourceServerId = input.project.serverId ?? LOCAL_SERVER_ID
  if (input.targetServerId === sourceServerId) {
    return {
      projectId: input.project.id,
      serverId: sourceServerId,
      projectPath: input.project.path,
      status: 'current',
    }
  }

  if (!input.targetOnline) {
    const detail = input.targetError?.trim()
      ? ` ${input.targetError.trim()}`
      : ''
    throw new Error(`Can't reach ${input.targetServerName}.${detail}`)
  }

  const existing = sourceCheckouts(input.project).find(
    checkout => checkout.serverId === input.targetServerId && !checkout.offline
  )

  let projectId: string
  let projectPath: string
  let status: 'present' | 'cloned'

  if (existing) {
    deps.onProgress?.(
      `Using the checkout already on ${input.targetServerName}…`
    )
    projectId = existing.projectId
    projectPath = existing.path
    status = 'present'
  } else {
    deps.onProgress?.(
      `Cloning ${input.project.name} onto ${input.targetServerName}…`
    )
    const cloneUrls = asStringArray(
      await deps.invoke(sourceServerId, 'list_clone_urls', {
        repoPath: input.project.path,
      })
    )
    throwIfCancelled(deps.isCancelled)
    if (cloneUrls.length === 0) {
      throw new Error(
        'This project has no git remote to clone from. Add a remote, then start again.'
      )
    }
    const ensured = (await deps.invoke(
      input.targetServerId,
      'ensure_project_present',
      { cloneUrls, name: input.project.name }
    )) as EnsureProjectResponse
    throwIfCancelled(deps.isCancelled)
    if (!ensured?.project?.id || !ensured.project.path) {
      throw new Error(
        `Jean on ${input.targetServerName} did not return a project checkout.`
      )
    }
    projectId = ensured.project.id
    projectPath = ensured.project.path
    status = ensured.status === 'cloned' ? 'cloned' : 'present'
  }

  const sources = sourceCheckouts(input.project).filter(
    checkout => checkout.serverId !== input.targetServerId && !checkout.offline
  )
  if (sources.length > 0) {
    deps.onProgress?.(
      `Looking for env files to copy onto ${input.targetServerName}…`
    )
    let targetFiles: string[] = []
    try {
      targetFiles = asStringArray(
        await deps.invoke(input.targetServerId, 'list_project_env_files', {
          projectPath,
        })
      )
    } catch {
      targetFiles = []
    }
    throwIfCancelled(deps.isCancelled)

    const sourceFiles: EnvHostFiles[] = []
    for (const source of sources) {
      try {
        sourceFiles.push({
          serverId: source.serverId,
          serverName: source.serverName,
          projectPath: source.path,
          files: asStringArray(
            await deps.invoke(source.serverId, 'list_project_env_files', {
              projectPath: source.path,
            })
          ),
        })
      } catch {
        // A host that cannot list files is skipped; another source may have them.
      }
      throwIfCancelled(deps.isCancelled)
    }

    const offer = envFilesToOffer(targetFiles, sourceFiles)
    if (offer) {
      const decision = await deps.confirmEnvCopy(offer)
      throwIfCancelled(deps.isCancelled)
      if (decision === 'cancel') throw new StartOnHostCancelled()
      if (decision === 'copy') {
        deps.onProgress?.(
          `Copying ${offer.files.join(', ')} to ${input.targetServerName}…`
        )
        const files = await deps.invoke(
          offer.sourceServerId,
          'read_project_env_files',
          { projectPath: offer.sourceProjectPath, names: offer.files }
        )
        throwIfCancelled(deps.isCancelled)
        await deps.invoke(input.targetServerId, 'write_project_env_files', {
          projectPath,
          files,
        })
        throwIfCancelled(deps.isCancelled)
      }
    }
  }

  return {
    projectId,
    serverId: input.targetServerId,
    projectPath,
    status,
  }
}
