import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/clipboard'
import { openExternal } from '@/lib/platform'
import { SettingsSection } from '../SettingsSection'

const PRESETS = [
  {
    name: 'Devin',
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

export function DevinMcpSection() {
  const copyConfig = async (config: string) => {
    try {
      await copyToClipboard(config)
      toast.success('MCP template copied')
    } catch (error) {
      toast.error(`Could not copy the template: ${String(error)}`)
    }
  }

  return (
    <SettingsSection title="Devin and DeepWiki MCP (optional)">
      <p className="text-sm text-muted-foreground">
        These services are separate from the local Devin chat backend. Nothing
        is installed or enabled automatically.
      </p>
      <p className="text-sm text-muted-foreground">
        For Devin CLI, merge the selected template into your user configuration
        at <code>~/.config/devin/mcp_config.json</code> (Windows:{' '}
        <code>%APPDATA%\devin\mcp_config.json</code>). Keep existing servers.
        Replace placeholders in that file, then set <code>disabled</code> to{' '}
        <code>false</code> when ready. Reopen MCP settings to find the server.
        Other backends use their own MCP configuration format.
      </p>
      <p className="text-sm text-muted-foreground">
        Devin requires a <code>cog_</code> API key. Personal and enterprise keys
        also require <code>X-Org-Id</code>. Remove that header for an org-scoped
        key if not needed. Do not put credentials in a shared project file. Jean
        does not collect credentials in this setup section.
      </p>
      {PRESETS.map(preset => {
        const snippet = JSON.stringify({ mcpServers: preset.config }, null, 2)
        return (
          <div key={preset.name} className="space-y-2 rounded-md border p-3">
            <h4 className="text-sm font-medium">{preset.name}</h4>
            <p className="text-sm text-muted-foreground">
              {preset.description}
            </p>
            <Textarea
              aria-label={`${preset.name} MCP template`}
              value={snippet}
              readOnly
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyConfig(snippet)}
              >
                Copy template
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openExternal(preset.docs)}
              >
                Setup documentation
              </Button>
            </div>
          </div>
        )
      })}
    </SettingsSection>
  )
}
