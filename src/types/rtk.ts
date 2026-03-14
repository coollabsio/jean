export interface RtkGainSummary {
  totalCommands: number
  totalInput: number
  totalOutput: number
  totalSaved: number
  avgSavingsPct: number
  totalTimeMs: number
  avgTimeMs: number
}

export interface RtkPeriodStat {
  label: string
  commands: number
  input: number
  output: number
  saved: number
  savingsPct: number
  timeMs: number
}

export interface RtkGainSnapshot {
  summary: RtkGainSummary
  daily: RtkPeriodStat[]
  weekly: RtkPeriodStat[]
  monthly: RtkPeriodStat[]
  fetchedAt: number
}
