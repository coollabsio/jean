import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Loader2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { copyToClipboard } from '@/lib/clipboard'
import { BackendCliSourceSelect } from './BackendCliSourceSelect'
import { InlineField } from './InlineField'

interface PathDetection {
  found: boolean
  path?: string | null
  version?: string | null
}

/**
 * The Source and Version rows of a CLI section. Source picks Jean managed or
 * System PATH and shows the active binary path; Version shows the installed
 * version with its actions, or an Install button.
 */
export function CliInstallFields({
  backendName,
  binary,
  source,
  onSourceChange,
  pathDetection,
  activePath,
  loading,
  installed,
  version,
  description,
  actions,
  onInstall,
  installing = false,
  onUninstall,
}: {
  backendName: string
  /** Binary name for the "add it to your PATH" hint. */
  binary?: string
  /** Omit for CLIs that only run from PATH. */
  source?: 'jean' | 'path'
  onSourceChange?: (value: 'jean' | 'path') => void
  pathDetection?: PathDetection | null
  /** Path of the binary Jean runs. */
  activePath?: string | null
  loading: boolean
  installed: boolean
  version?: string | null
  description?: ReactNode
  /** Update or change-version controls, shown when installed. */
  actions?: ReactNode
  onInstall: () => void
  installing?: boolean
  /** Removes the Jean-managed binary. */
  onUninstall?: () => void
}) {
  const pathFound = !!pathDetection?.found
  const hint =
    !installed && !pathFound && binary ? (
      <>
        Install with Jean or add <code>{binary}</code> to your PATH.
      </>
    ) : undefined

  return (
    <>
      <InlineField
        label="Source"
        description={
          activePath ? (
            <CopyablePath path={activePath} />
          ) : (
            <span>
              {installed || pathFound ? 'System PATH' : 'Not installed'}
            </span>
          )
        }
      >
        {source && onSourceChange ? (
          <BackendCliSourceSelect
            value={source}
            onValueChange={onSourceChange}
            backendName={backendName}
            path={pathDetection?.path}
            pathVersion={pathDetection?.version}
            pathFound={pathFound}
          />
        ) : (
          <span className="text-sm">System PATH</span>
        )}
      </InlineField>
      <InlineField
        label={installed ? 'Version' : 'Status'}
        description={description ?? hint}
      >
        <div className="flex flex-wrap items-center gap-2">
          {loading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : installed ? (
            <>
              <span className="text-sm tabular-nums">
                {version ?? 'Installed'}
              </span>
              {actions}
              {source === 'jean' && onUninstall && (
                <Button variant="ghost" size="sm" onClick={onUninstall}>
                  Uninstall
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" disabled={installing} onClick={onInstall}>
              {installing ? 'Installing…' : 'Install'}
            </Button>
          )}
        </div>
      </InlineField>
    </>
  )
}

function CopyablePath({ path }: { path: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            copyToClipboard(path)
            toast.success('Path copied to clipboard')
          }}
          className="block max-w-full cursor-pointer truncate text-left hover:underline"
        >
          {path}
        </button>
      </TooltipTrigger>
      <TooltipContent>{path}</TooltipContent>
    </Tooltip>
  )
}

/** Updates a CLI that runs from PATH. Disabled when it is up to date. */
export function CliUpdateButton({
  checking,
  hasUpdate,
  latestVersion,
  pending = false,
  onUpdate,
}: {
  checking: boolean
  hasUpdate: boolean
  latestVersion?: string | null
  pending?: boolean
  onUpdate: () => void
}) {
  if (checking) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending || !hasUpdate}
      onClick={onUpdate}
    >
      {pending
        ? 'Updating…'
        : hasUpdate
          ? `Update to ${latestVersion}`
          : 'Up to date'}
    </Button>
  )
}

/** Opens the version picker for a Jean-managed CLI. */
export function CliChangeVersionButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      Change version
    </Button>
  )
}
