import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import {
  applyViewedToggle,
  type DiffViewedFiles,
  type ViewedDiffType,
} from '@/lib/diff-viewed'

export const diffViewedQueryKey = (
  worktreeId: string,
  diffType: ViewedDiffType
) => ['diff-viewed', worktreeId, diffType] as const

export function useDiffViewedFiles(
  worktreeId: string | undefined,
  diffType: ViewedDiffType | null
) {
  return useQuery({
    queryKey: diffViewedQueryKey(worktreeId ?? '', diffType ?? 'uncommitted'),
    queryFn: () =>
      invoke<DiffViewedFiles>('get_diff_viewed_files', {
        worktreeId,
        diffType,
      }),
    enabled: !!worktreeId && !!diffType,
    staleTime: 30_000,
  })
}

interface ToggleViewedArgs {
  worktreeId: string
  diffType: ViewedDiffType
  path: string
  hash: string
  viewed: boolean
}

export function useSetDiffFileViewed() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: ToggleViewedArgs) =>
      invoke<{ githubSynced: boolean }>('set_diff_file_viewed', { ...args }),
    onMutate: async ({ worktreeId, diffType, path, hash, viewed }) => {
      const key = diffViewedQueryKey(worktreeId, diffType)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<DiffViewedFiles>(key)
      queryClient.setQueryData(
        key,
        applyViewedToggle(previous, path, hash, viewed)
      )
      return { key, previous }
    },
    onError: (error, _args, context) => {
      if (context) queryClient.setQueryData(context.key, context.previous)
      toast.error(`Failed to update viewed state: ${error}`)
    },
  })
}
