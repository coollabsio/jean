interface DirectoryBrowserRoutingInput {
  isLocalBackend: boolean
  isClientMacOS: boolean
  isLocalTarget: boolean
}

export function shouldUseDirectoryBrowser({
  isLocalBackend,
  isClientMacOS,
  isLocalTarget,
}: DirectoryBrowserRoutingInput): boolean {
  return !isLocalBackend || isClientMacOS || !isLocalTarget
}
