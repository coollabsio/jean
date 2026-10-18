interface TerminalExitState {
  exitCode: number | null
  signal: string | null
  isPanel: boolean
  isRunTerminal: boolean
}

export function shouldAutoCloseTerminal({
  exitCode,
  signal,
  isPanel,
  isRunTerminal,
}: TerminalExitState): boolean {
  if (!isPanel || isRunTerminal) return false

  const isIntentionalSignal =
    signal != null &&
    (signal.includes('Interrupt') || signal.includes('Terminated'))

  return exitCode === 0 || isIntentionalSignal
}
