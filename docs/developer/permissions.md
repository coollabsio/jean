# Workflow and permission policies

The chat toolbar shows only the permission selector. Selecting a permission leaves any existing Plan mode. Full access is the default for new sessions. Existing preferences are not rewritten.

## Wire compatibility

Keep `selected_execution_mode` and each run's `execution_mode` compatible with previous history:

| Wire value   | Workflow | Permission policy                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------- |
| `plan`       | Plan     | Backend planning/read-only policy                                                     |
| `supervised` | Build    | User approval for actions that need approval                                          |
| `build`      | Build    | Auto-accept edits on Claude, Codex, OpenCode, Grok, and Kimi; legacy policy elsewhere |
| `auto`       | Build    | Backend-native automatic approval review                                              |
| `yolo`       | Build    | Full access                                                                           |

`selected_permission_mode` stores the Build permission choice while planning. It is session metadata, not global UI state. The existing session-state command persists it and broadcasts `permissionMode` changes after saving. Both the native shell and Web Access use the core dispatch handler.

Old session JSON without `selected_execution_mode` loads as Plan. Session creation captures the current default explicitly. This prevents the new default from escalating old sessions.

Shift+Tab toggles Plan/Build without cycling permissions. Plan approval uses the retained permission choice. The explicit legacy Yolo approval remains a Full access override.

## Capabilities

| Backend                               | Permission choices                                                 |
| ------------------------------------- | ------------------------------------------------------------------ |
| Claude                                | Supervised, Auto-accept edits, Auto, Full access                   |
| Codex                                 | Supervised, Auto-accept edits, Auto, Full access                   |
| OpenCode                              | Supervised, Auto-accept edits, Full access                         |
| Grok, Kimi                            | Supervised, Auto-accept edits, Auto, Full access                   |
| Cursor, PI, Command Code, Antigravity | Full access; retain existing Legacy Build sessions where supported |

Unsupported restricted policies must not become Full access. Backend selection falls back to Plan, and direct IPC/MCP sends reject unsupported policies.

Claude Supervised uses native `default` permissions and Jean's existing permission-denial/approval/re-send flow, not a live Agent SDK callback. Native Auto requires CLI/model/account support. Claude's provider policies, deny rules, and tools that require user input still apply.

Codex Supervised uses `untrusted` plus read-only sandboxing. Auto-accept edits keeps Jean's existing granular approvals and workspace-write sandbox. Sandboxed commands can run without approval. Auto uses `on-request` with `approvalsReviewer: auto_review`. Set and reset the reviewer on thread start, resume, and every turn so automatic review cannot leak into Supervised or Full access.

OpenCode installs explicit session permission rules before every turn, including resumed sessions. Failure to apply or confirm the rules in the returned session stops the turn. Supervised asks for edits and commands; Auto-accept edits allows edits but asks for commands. Plan resets permissive rules and denies edits and commands. Environment-file and external-directory access retain separate approval rules.

### Grok and Kimi ACP approvals

Grok and Kimi use a shared ACP approval bridge. Supervised forwards native permission requests to Jean. Auto-accept edits approves only ACP `read`, `search`, and `edit` kinds, once; commands, network actions, missing kinds, and unknown actions still require approval. Do not classify commands as edits from their titles. Auto uses each backend's native reviewer and forwards any remaining requests to the user.

Grok explicitly sets `--permission-mode default` for Supervised/Auto-accept edits, `auto` for Auto, and `bypassPermissions` for Full access. Restricted runs use `--no-leader` and omit `--always-approve` so a shared unrestricted leader or a saved Full access default cannot bypass Jean's requested policy. Native Auto depends on Grok's feature availability.

Kimi uses native ACP mode `default` for Supervised/Auto-accept edits, `auto` for Auto, and `yolo` for Full access. The old Build-to-native-Auto mapping is no longer used: native Auto reviews safe operations, not only edits.

The detached host writes `jean_acp_permission_request` and `jean_acp_permission_resolved` markers into the run log. The log tail persists pending requests with their run ID and broadcasts `chat:acp_permissions_changed`. Approval replies go through the existing host socket and a host-local channel. The attached fallback uses the same decision code and an in-process channel. Replies must match a current running/resumable run and a native offered option. Jean offers Allow once and Reject, not broad remembered grants. Cancellation, missing approval context, missing options, and the ten-minute response timeout fail closed.

Pending requests live in session metadata, not persisted global UI state. Waiting state is derived from requests belonging to active runs, so cancelled/completed runs cannot retain an old approval card. The frontend card fetches pending requests on mount and refreshes from events; the same component works on desktop and mobile. `get_acp_permission_requests` and `respond_acp_permission` use the shared native/Web Access dispatcher.

### Other backend audit

| Backend      | Native capability                                                              | Why no new menu choices yet                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cursor       | Per-tool Shell/Read/Write/MCP allow/deny rules, sandbox, forced approval flags | Jean uses a streaming CLI without a live approval callback. A sandbox does not mean edit-only approval; adding choices requires scoped runtime rules and a supported response path.                    |
| PI           | Tool filtering, OS/container isolation, extension hooks                        | PI explicitly does not provide built-in per-tool approval. Project trust is not tool approval. A Jean extension/approval integration is required before advertising these policies.                    |
| Command Code | Interactive standard, accept-edits, and bypass policies                        | Published 1.74.1 print mode blocks write/shell tools unless permissions are bypassed. Its accept-edits CLI flag alone cannot provide interactive approvals in Jean's print transport.                  |
| Antigravity  | Allow/deny/ask rules and terminal sandbox                                      | Its documented asks target the editor/TUI; Jean's streaming CLI currently reports denied tools, not a live reply interface. Existing sandbox plus skip-permissions behavior is not edit-only approval. |

Do not expose policies for these transports until Jean can enforce the real approval contract. Preserve existing user configurations; do not rewrite global allowlists to simulate a per-session policy.

## Current references

- https://code.claude.com/docs/en/permission-modes
- https://developers.openai.com/codex/app-server
- https://opencode.ai/docs/permissions/
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts

For Codex API changes, generate the installed app-server schema and check the exact request fields. Do not infer API support from UI labels.

- https://docs.x.ai/build/features/permissions
- https://agentclientprotocol.com/protocol/tool-calls
- https://github.com/MoonshotAI/kimi-code/tree/main/apps/kimi-code
- https://cursor.com/docs/cli/reference/permissions
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md
- https://registry.npmjs.org/command-code/latest (audited published version 1.74.1)
- https://antigravity.google/docs/permissions/
