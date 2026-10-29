import { toast } from 'sonner'
import { Copy } from '@/components/icons/reicon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/clipboard'
import { ExtensionDetail, ExtensionLink, ExtensionRow } from '../ExtensionRow'

const PRESETS = [
  {
    name: 'Devin',
    anchorId: 'pref-mcp-section-devin',
    docs: 'https://docs.devin.ai/work-with-devin/devin-mcp',
    description:
      'Manage cloud sessions and read public or private repository documentation. A Devin account is required. Cloud sessions can incur charges.',
    config: {
      devin: {
        url: 'https://mcp.devin.ai/mcp',
        headers: {
          Authorization: 'Bearer <COG_API_KEY>',
          'X-Org-Id': '<ORGANIZATION_ID>',
        },
        disabled: true,
      },
    },
  },
  {
    name: 'DeepWiki',
    anchorId: undefined,
    docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    description:
      'Read public repository documentation. This service is free and does not require authentication.',
    config: {
      deepwiki: {
        url: 'https://mcp.deepwiki.com/mcp',
        disabled: true,
      },
    },
  },
]

export function DevinMcpRows() {
  const copyConfig = async (config: string) => {
    try {
      await copyToClipboard(config)
      toast.success('MCP template copied')
    } catch (error) {
      toast.error(`Could not copy the template: ${String(error)}`)
    }
  }

  return PRESETS.map(preset => {
    const snippet = JSON.stringify({ mcpServers: preset.config }, null, 2)
    return (
      <ExtensionRow
        key={preset.name}
        name={preset.name}
        anchorId={preset.anchorId}
        status={
          <Badge variant="subtle" className="max-w-full shrink">
            <span className="truncate">Manual setup</span>
          </Badge>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyConfig(snippet)}
            className="w-full sm:w-auto"
          >
            <Copy className="h-4 w-4" />
            Copy template
          </Button>
        }
      >
        <div className="space-y-1 pt-1">
          <p className="text-xs text-muted-foreground">{preset.description}</p>
          <p className="text-xs text-muted-foreground">
            This service is separate from the local Devin chat backend. Nothing
            is installed or enabled automatically.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ExtensionLink url={preset.docs} label="Setup documentation" />
          </div>
        </div>
        <ExtensionDetail title="How to use">
          <p className="text-xs text-muted-foreground">
            For Devin CLI, merge the template into your user configuration at{' '}
            <code>~/.config/devin/mcp_config.json</code> (Windows:{' '}
            <code>%APPDATA%\devin\mcp_config.json</code>). Keep existing
            servers. Replace placeholders in that file, then set{' '}
            <code>disabled</code> to <code>false</code> when ready. Reopen MCP
            settings to find the server. Other backends use their own MCP
            configuration format.
          </p>
          {preset.name === 'Devin' && (
            <p className="text-xs text-muted-foreground">
              Devin requires a <code>cog_</code> API key. Personal and
              enterprise keys also require <code>X-Org-Id</code>. Remove that
              header for an org-scoped key if not needed. Do not put credentials
              in a shared project file. Jean does not collect credentials here.
            </p>
          )}
          <Textarea
            aria-label={`${preset.name} MCP template`}
            value={snippet}
            readOnly
            className="font-mono text-xs"
          />
        </ExtensionDetail>
      </ExtensionRow>
    )
  })
}
