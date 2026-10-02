# Devin integration

Jean uses the Devin CLI's ACP v1 interface. The CLI and official release manifest
were checked at version **3000.11.3**. Keep capability negotiation: a version
number alone does not prove that a feature is available for an account.

## Local and cloud sessions

Select **Devin**, then select **Local** or **Cloud** before the first message.
The location belongs to the session and is locked after a message or resume ID
exists. Existing sessions default to Local.

- Local starts `devin acp` in the worktree. Jean passes its required MCP servers
  and the selected MCP configuration. Devin can also have its own configured
  servers; the ACP list is not an isolation boundary.
- Cloud starts `devin acp --cloud`. It receives no local MCP servers and no local
  working-directory path. The VM needs its own repository access. Local changes
  are not automatically pushed or synchronized. Use explicit file attachments
  for local content that the remote agent needs.
- The cloud model picker uses the remote session's advertised options, not the
  local CLI model list. Thinking and speed selectors appear only when advertised.
  The first cloud turn uses its configured remote model.
- Local CLI model variants use the advertised ACP family model plus its separate
  thinking control. Jean validates both values and rejects unknown mappings
  instead of silently changing models. An explicit session thinking choice takes
  precedence over the variant's thinking level.

Session IDs and configuration options are persisted. Jean uses `session/load`
only when the server advertises `loadSession`; it does not silently create a
replacement conversation if loading is unsupported.

## Modes and permissions

Jean maps Plan to `plan`, Build to `accept-edits`, and YOLO to `bypass`, using the
advertised ACP mode selector, or the legacy ACP modes API when available.
A rejected mode remains an error. Local execution requires a mode control.

Cloud sessions can omit mode controls. In that case Jean keeps the remote
permission policy and sends the selected execution mode as a task instruction.
Cloud Plan is not an enforced read-only sandbox. The toolbar states this limit.
Other explicit configuration choices must still be advertised and accepted.

Local Build uses Devin's Code mode, which can accept workspace edits. Other permission
requests use Jean's approval card. Plan rejects requested permissions. YOLO uses
`allow_once` for reverse requests; it does not silently choose a permanent grant.
An explicit **Approve (yolo)** decision applies to the current turn and updates
Jean's selected execution mode for later turns.

Permission responses are scoped to a session and a unique request ID. They cannot
fall through to the Codex transport. The shared card is a display adapter only.

## Cancellation and recovery

The ACP reader uses a separate pipe reader and bounded waits. Cancel sends
`session/cancel`, waits up to five seconds, then closes the CLI. This interrupts
the turn; it is not a cloud-session deletion command. If the remote service does
not confirm cancellation, check the remote session before assuming its work has
stopped.

Each stream update is written to the run log before it is emitted to clients.
History uses the same incremental parser as live output. It retains partial
text, thinking, tool input/output, and failed tool state. Old synthetic Devin
logs remain readable.

Local execution is attached, not a detached host: it is not designed to continue
when Jean exits. A live local CLI PID alone is not offered as a resumable log
stream after restart. The saved Devin session can be loaded for a later turn.
Cloud work belongs to the remote service and can continue after Jean disconnects.

## Context and MCP

Images are encoded as ACP content blocks when image support is advertised
(20 MiB combined input limit). Text attachments use embedded resources or inline
text (2 MiB combined limit). Explicit file and skill references are embedded for
cloud sessions. Directory attachments are rejected for cloud sessions; attach
individual files instead. Selected issue, PR, saved, and other loaded context is
included directly rather than relying on local file paths.

Settings → MCP includes disabled templates for:

- [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp): authenticated cloud
  delegation and repository documentation. Session creation can incur charges.
- [DeepWiki MCP](https://docs.devin.ai/work-with-devin/deepwiki-mcp): public
  repository documentation without authentication.

Templates do not install or enable a service. Merge them into the chosen
backend's private user configuration. Keep API keys out of shared project files.
Devin CLI discovery reads user, project, and local `mcp_config.json` files with
local precedence and supports the older config file locations.

JSON-dependent magic prompts remain disabled for Devin. No REST v3 management
client or automatic cloud handoff is added by this integration.

## Verification

Run the focused checks:

```sh
cargo test --manifest-path jean-core/Cargo.toml devin --lib
bun run test:run src/services/devin-cli.test.ts src/services/mcp.test.ts
```

Manual checks (cloud prompts can incur charges):

1. Create an empty Devin session, select Cloud, reload, and confirm the location
   persists. Do not send a prompt unless cloud usage is approved.
2. In Local Build mode, request an action that requires permission. Exercise
   Approve, Decline, and Cancel. Confirm that the approval card closes.
3. Cancel after partial output, reload, and confirm that history is preserved.
4. Complete a Plan turn and check the plan approval state before and after reload.
5. Attach an image and text file. Check that content reaches Devin. In Cloud,
   check that a directory attachment produces an explicit error.
6. Change an advertised thinking or speed value while idle. Confirm that the next
   turn applies it and that a rejected value does not silently fall back.

## Sources

- [CLI commands](https://docs.devin.ai/cli/reference/commands)
- [Stable release notes](https://docs.devin.ai/cli/changelog/stable)
- [Cloud sessions](https://docs.devin.ai/cli/cloud)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options)
