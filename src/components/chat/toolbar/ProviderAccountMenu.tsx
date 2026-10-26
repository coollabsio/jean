import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { accountLabel, accountsForBackend } from '@/lib/provider-accounts'
import type { ProviderAccount } from '@/types/preferences'

const CLI_LOGIN = '__cli_login__'

interface ProviderAccountMenuProps {
  backend: string
  accounts: ProviderAccount[]
  selectedAccountId: string | null
  onChange: (accountId: string | null) => void
}

export function ProviderAccountMenu({
  backend,
  accounts,
  selectedAccountId,
  onChange,
}: ProviderAccountMenuProps) {
  const [open, setOpen] = useState(false)
  const backendAccounts = accountsForBackend(accounts, backend)
  if (backendAccounts.length === 0) return null

  const label = accountLabel(accounts, selectedAccountId)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
              aria-label="Provider account"
            >
              <span>{label}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Account</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Account
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selectedAccountId ?? CLI_LOGIN}
          onValueChange={value => onChange(value === CLI_LOGIN ? null : value)}
        >
          <DropdownMenuRadioItem value={CLI_LOGIN}>
            CLI login
          </DropdownMenuRadioItem>
          {backendAccounts.map(account => (
            <DropdownMenuRadioItem key={account.id} value={account.id}>
              {account.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
