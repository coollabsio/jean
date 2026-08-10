# Lessons

## Keep task tracking proportional

- The project instructions require work to be tracked in `.ai/todo.md`, but do not expand it with excessive implementation detail.
- For small follow-up fixes, add only a short checklist and result instead of a long duplicate report.
- Explain that `.ai/todo.md` is internal task tracking when the user asks why it changes.

## Normalize backend tool vocabularies at the display boundary

- Do not assume similar tools share names or parameter casing across backends.
- Capture real stream events, map exact backend names and keys to Jean's common renderer contract, and keep an explicit readable fallback for known native tools.
- Test both live-looking tool inputs and persisted inputs so reload does not reintroduce unhandled labels.

## Wire backend capability semantics end to end

- A backend flag is not supported until the frontend selects the correct setting type and every send path forwards it.
- For persistent-only MCP backends, add discovery and installers, but do not show a per-session switch that the CLI cannot honor.
- Test the exact CLI value set and the generated persistent config, not only the low-level command builder.

## Do not confuse incomplete work with upstream limits

- When the user asks for production readiness, classify each gap as either implementable in Jean or unavailable in the external backend.
- Do not call work complete while implementable checklist items remain.
- Do not use an upstream limitation to excuse adjacent Jean work that is still possible.
- State verification limits separately from implementation limits.

## Verify product migrations against the current official CLI

- Do not treat an old package registry entry as proof that a product is still the supported user path.
- Check the official product site, migration guide, installer, release manifest, and downloaded binary help before designing an integration.
- Do not rename an integration while keeping the old transport assumptions. Reclassify the backend from its current documented protocol.
- Do not install similarly named third-party packages. For Antigravity, use Google's official native installer and release manifest, not the unrelated npm package.

## Register live and history parsers together

- A new streaming backend needs two parser paths: the live response parser and the run-log reconstruction parser.
- Route persisted runs by the per-run backend or model prefix before using a generic fallback parser.
- Test history reload with the backend's real NDJSON format. Live streaming success does not prove that the response survives a query refresh or app reload.
