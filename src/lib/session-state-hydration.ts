let hydrationDepth = 0

export function beginSessionStateHydration(): void {
  hydrationDepth += 1
}

export function endSessionStateHydration(): void {
  hydrationDepth = Math.max(0, hydrationDepth - 1)
}

export function isSessionStateHydrating(): boolean {
  return hydrationDepth > 0
}
