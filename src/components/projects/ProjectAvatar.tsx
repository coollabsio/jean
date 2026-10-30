import { useState } from 'react'
import { cn } from '@/lib/utils'
import { projectAvatarUrl } from '@/lib/project-avatar'
import { useAppDataDir } from '@/services/projects'
import type { Project } from '@/types/projects'

interface ProjectAvatarProps {
  project: Project
  /** Size and corner radius, applied to the image and the letter fallback. */
  className?: string
  /** Text style of the letter fallback. */
  letterClassName?: string
}

/** Project image, or the first letter of the name when it has no image. */
export function ProjectAvatar({
  project,
  className = 'size-4 rounded',
  letterClassName = 'text-2xs',
}: ProjectAvatarProps) {
  const { data: appDataDir = '' } = useAppDataDir()
  const url = projectAvatarUrl(project, appDataDir)
  // Keyed by URL so a new avatar gets a fresh load attempt
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  // Image and letter share one tile, so icons with transparent padding keep the same footprint
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-muted-foreground/20',
        className
      )}
    >
      {url && failedUrl !== url ? (
        <img
          src={url}
          alt={project.name}
          className="size-full object-cover"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className={cn('font-medium uppercase', letterClassName)}>
          {project.name[0]}
        </span>
      )}
    </div>
  )
}
