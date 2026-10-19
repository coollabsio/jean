import { BackendPaneHeader } from '../SettingsSection'
import { GeneralPane } from './GeneralPane'

export function DevinPane() {
  return (
    <div className="w-full space-y-6">
      <BackendPaneHeader backend="devin" />
      <GeneralPane scope="devin" />
    </div>
  )
}
