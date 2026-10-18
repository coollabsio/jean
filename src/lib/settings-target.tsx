import { createContext, useContext, type ReactNode } from 'react'
import { LOCAL_SERVER_ID, type ServerId } from '@/types/server-resource'

const SettingsTargetContext = createContext<ServerId>(LOCAL_SERVER_ID)

export function SettingsTargetProvider({
  serverId,
  children,
}: {
  serverId: ServerId
  children?: ReactNode
}) {
  return (
    <SettingsTargetContext.Provider value={serverId}>
      {children}
    </SettingsTargetContext.Provider>
  )
}

export function useSettingsTargetServerId(): ServerId {
  return useContext(SettingsTargetContext)
}

/** Server id for commands that otherwise use the local Jean instance. */
export function useOptionalSettingsTargetServerId(): ServerId | undefined {
  const serverId = useSettingsTargetServerId()
  return serverId === LOCAL_SERVER_ID ? undefined : serverId
}
