export interface TerminalOutputEvent {
  terminal_id: string
  data: string
}

export interface TerminalStartedEvent {
  terminal_id: string
  cols: number
  rows: number
}

export interface TerminalStoppedEvent {
  terminal_id: string
  exit_code: number | null
  signal: string | null
}
