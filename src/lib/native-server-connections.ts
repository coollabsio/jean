import { isNativeApp } from './environment'

export async function startNativeServerConnections(): Promise<() => void> {
  if (!isNativeApp()) return () => undefined

  const [connections, managerModule, tunnels] = await Promise.all([
    import('./remote-connections'),
    import('./server-connections'),
    import('./ssh-tunnel'),
  ])
  const { serverConnectionManager } = managerModule

  const sync = () => {
    serverConnectionManager.sync(tunnels.getTransportConnections(), undefined)
  }

  try {
    await tunnels.hydrateSshSecrets()
    await tunnels.startSshTunnelEvents()
    await tunnels.refreshSshTunnelStatus()
  } catch {
    // SSH tunnel commands exist only in the desktop shell.
  }

  sync()
  const unsubscribeConnections = connections.subscribeRemoteConnections(() => {
    void tunnels.reconcileSshTunnels()
    sync()
  })
  const unsubscribeTunnels = tunnels.subscribeSshTunnels(sync)
  void tunnels.reconcileSshTunnels()
  return () => {
    unsubscribeConnections()
    unsubscribeTunnels()
    // React remounts must not kill ssh. The Rust supervisor owns the process.
    tunnels.stopSshTunnelEvents()
    serverConnectionManager.dispose()
  }
}
