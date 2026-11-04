import { create } from 'zustand'

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(id)) next.add(id)
  return next
}

/**
 * Lead sessions whose sub-sessions are hidden in session lists, and how each
 * lead's sub-session panel is shown. UI only and not persisted: every lead
 * starts expanded, with the panel open and the narrow strip closed.
 */
interface SubSessionState {
  collapsedLeadSessionIds: ReadonlySet<string>
  toggleLeadCollapsed: (leadId: string) => void
  expandLeads: (leadIds: readonly string[]) => void
  /** Leads whose side panel is folded to a rail */
  railPanelSessionIds: ReadonlySet<string>
  togglePanelRail: (leadId: string) => void
  /** Leads whose narrow strip above the composer is open */
  openStripSessionIds: ReadonlySet<string>
  toggleStripOpen: (leadId: string) => void
}

export const useSubSessionStore = create<SubSessionState>()(set => ({
  collapsedLeadSessionIds: new Set(),
  toggleLeadCollapsed: leadId =>
    set(state => ({
      collapsedLeadSessionIds: toggled(state.collapsedLeadSessionIds, leadId),
    })),
  expandLeads: leadIds =>
    set(state => {
      if (!leadIds.some(id => state.collapsedLeadSessionIds.has(id))) {
        return state
      }
      const next = new Set(state.collapsedLeadSessionIds)
      for (const id of leadIds) next.delete(id)
      return { collapsedLeadSessionIds: next }
    }),
  railPanelSessionIds: new Set(),
  togglePanelRail: leadId =>
    set(state => ({
      railPanelSessionIds: toggled(state.railPanelSessionIds, leadId),
    })),
  openStripSessionIds: new Set(),
  toggleStripOpen: leadId =>
    set(state => ({
      openStripSessionIds: toggled(state.openStripSessionIds, leadId),
    })),
}))
