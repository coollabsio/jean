import { Loader2, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BranchItem } from './NewWorktreeItems'

export interface BranchesTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  branches: string[]
  isLoading: boolean
  isRefetching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectBranch: (branchName: string, background?: boolean) => void
  creatingFromBranch: string | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

export function BranchesTab({
  searchQuery,
  setSearchQuery,
  branches,
  isLoading,
  isRefetching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectBranch,
  creatingFromBranch,
  searchInputRef,
}: BranchesTabProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search and refresh */}
      <div className="p-3 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search branches..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRefresh}
                disabled={isRefetching}
                className={cn(
                  'flex items-center justify-center h-8 w-8 rounded-md border border-border',
                  'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                  'transition-colors',
                  isRefetching && 'opacity-50 cursor-not-allowed'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4 text-muted-foreground',
                    isRefetching && 'animate-spin'
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh branches</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Branch list */}
      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading branches...
            </span>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <AlertCircle className="h-5 w-5 text-destructive mb-2" />
            <span className="text-sm text-muted-foreground">
              {error.message || 'Failed to load branches'}
            </span>
          </div>
        )}

        {!isLoading && !error && branches.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              {searchQuery
                ? 'No branches match your search'
                : 'No branches found'}
            </span>
          </div>
        )}

        {!isLoading && !error && branches.length > 0 && (
          <div className="py-1">
            {branches.map((branch, index) => (
              <BranchItem
                key={branch}
                branch={branch}
                index={index}
                isSelected={index === selectedIndex}
                isCreating={creatingFromBranch === branch}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={bg => onSelectBranch(branch, bg)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
