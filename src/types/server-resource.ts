export type ServerId = string

export const LOCAL_SERVER_ID = 'local' as const

export interface ServerResourceRef {
  serverId: ServerId
  resourceId: string
}

export type ServerOwned<T> = T & { serverId: ServerId }
