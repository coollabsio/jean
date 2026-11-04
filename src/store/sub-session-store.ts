import { create } from 'zustand'

/**
 * Lead sessions whose sub-sessions are hidden in session lists. UI only and
 * not persisted: every lead starts expanded.
 */
interface SubSessionState {
  collapsedLeadSessionIds: ReadonlySet<string>
  toggleLeadCollapsed: (leadId: string) => void
  expandLeads: (leadIds: readonly string[]) => void
}

export const useSubSessionStore = create<SubSessionState>()(set => ({
  collapsedLeadSessionIds: new Set(),
  toggleLeadCollapsed: leadId =>
    set(state => {
      const next = new Set(state.collapsedLeadSessionIds)
      if (!next.delete(leadId)) next.add(leadId)
      return { collapsedLeadSessionIds: next }
    }),
  expandLeads: leadIds =>
    set(state => {
      if (!leadIds.some(id => state.collapsedLeadSessionIds.has(id))) {
        return state
      }
      const next = new Set(state.collapsedLeadSessionIds)
      for (const id of leadIds) next.delete(id)
      return { collapsedLeadSessionIds: next }
    }),
}))
