import React, { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from '@/components/preferences/SettingsSection'
import { useClickUpConfig, useSaveClickUpConfig } from '@/services/clickup'

const Field: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="space-y-2">
    <div className="space-y-0.5">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
    </div>
    {children}
  </div>
)

/**
 * ClickUp integration settings (token + list ids), stored in the isolated
 * ClickUp sidecar config (not in AppPreferences).
 */
export const ClickUpSettings: React.FC = () => {
  const { data: config } = useClickUpConfig()
  const saveConfig = useSaveClickUpConfig()

  const [showToken, setShowToken] = useState(false)
  const [localToken, setLocalToken] = useState<string | null>(null)
  const [localPlanexpo, setLocalPlanexpo] = useState<string | null>(null)
  const [localSprint, setLocalSprint] = useState<string | null>(null)
  const [localProductionVersionUrl, setLocalProductionVersionUrl] = useState<
    string | null
  >(null)

  const currentToken = config?.token ?? ''
  const currentPlanexpo = config?.planexpoListId ?? ''
  const currentSprint = config?.sprintListId ?? ''
  const currentProductionVersionUrl = config?.productionVersionUrl ?? ''

  const token = localToken ?? currentToken
  const planexpo = localPlanexpo ?? currentPlanexpo
  const sprint = localSprint ?? currentSprint
  const productionVersionUrl =
    localProductionVersionUrl ?? currentProductionVersionUrl

  const changed =
    (localToken !== null && localToken !== currentToken) ||
    (localPlanexpo !== null && localPlanexpo !== currentPlanexpo) ||
    (localSprint !== null && localSprint !== currentSprint) ||
    (localProductionVersionUrl !== null &&
      localProductionVersionUrl !== currentProductionVersionUrl)

  const resetLocal = () => {
    setLocalToken(null)
    setLocalPlanexpo(null)
    setLocalSprint(null)
    setLocalProductionVersionUrl(null)
  }

  const handleSave = () => {
    saveConfig.mutate(
      {
        token: token.trim() || undefined,
        planexpoListId: planexpo.trim() || undefined,
        sprintListId: sprint.trim() || undefined,
        productionVersionUrl: productionVersionUrl.trim() || undefined,
      },
      {
        onSuccess: () => {
          resetLocal()
          toast.success('Configuration ClickUp enregistrée')
        },
        onError: e => toast.error(`Échec de l'enregistrement : ${e}`),
      }
    )
  }

  const handleClearToken = () => {
    saveConfig.mutate(
      {
        token: undefined,
        planexpoListId: planexpo.trim() || undefined,
        sprintListId: sprint.trim() || undefined,
        productionVersionUrl: productionVersionUrl.trim() || undefined,
      },
      {
        onSuccess: () => {
          setLocalToken(null)
          toast.success('Token ClickUp supprimé')
        },
        onError: e => toast.error(`Échec : ${e}`),
      }
    )
  }

  return (
    <SettingsSection
      title="ClickUp"
      anchorId="pref-integrations-section-clickup"
    >
      <Field
        label="Personal API Token"
        description={
          <>
            Ton token personnel ClickUp (commence par <code>pk_</code>).
            Génère-le depuis{' '}
            <a
              href="https://app.clickup.com/settings/apps"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              ClickUp Settings → Apps
            </a>
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type={showToken ? 'text' : 'password'}
            placeholder="pk_..."
            value={token}
            onChange={e => setLocalToken(e.target.value)}
            className="flex-1 text-base md:text-sm font-mono"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowToken(!showToken)}
          >
            {showToken ? 'Hide' : 'Show'}
          </Button>
        </div>
      </Field>

      <Field
        label="Liste Planexpo (list id)"
        description="Liste ClickUp par défaut pour parcourir/lier les tâches."
      >
        <Input
          placeholder="123456789"
          value={planexpo}
          onChange={e => setLocalPlanexpo(e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </Field>

      <Field
        label="Liste Sprint (list id)"
        description="Liste ClickUp du sprint en cours (optionnelle) pour parcourir/lier les tâches."
      >
        <Input
          placeholder="987654321"
          value={sprint}
          onChange={e => setLocalSprint(e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </Field>

      <Field
        label="Version de production (URL)"
        description="Endpoint HTTP retournant le SHA Git complet actuellement servi en production. Active le cockpit Déploiement."
      >
        <Input
          type="url"
          placeholder="https://example.com/version"
          value={productionVersionUrl}
          onChange={e => setLocalProductionVersionUrl(e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!changed || saveConfig.isPending}
        >
          {saveConfig.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
        {currentToken && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearToken}
            disabled={saveConfig.isPending}
          >
            Remove token
          </Button>
        )}
      </div>
    </SettingsSection>
  )
}
