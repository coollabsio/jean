/**
 * Standalone ACP — frontend module.
 *
 * ⚠️ EXPERIMENTAL. Gated by `preferences.experimental_acp`.
 *
 * When the preference is on, every newly-created session is assigned
 * backend `'acp_lab'` (see `src-tauri/src/chat/commands.rs::create_session`),
 * and `ChatWindow` swaps in `<AcpChat>` for those sessions. Existing
 * non-`acp_lab` sessions keep the regular chat pipeline.
 *
 * Naming: commands, events, types, and storage are all named neutrally
 * (`acp_*`) so graduation requires no rename — just flip the preference
 * default and remove the experimental badge.
 *
 * Deletion contract: see `src-tauri/src/acp/mod.rs`.
 */
export { default as AcpChat } from './components/AcpChat'
export { useAcpStreamingEvents } from './hooks/useAcpStreamingEvents'
