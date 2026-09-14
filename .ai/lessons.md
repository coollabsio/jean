# Lessons

## Use stable, owner-aware resource identities

- Values, query keys, command arguments, and persisted references must include a stable resource ID and its owner when IDs are not globally unique.
- Register ownership at adapter boundaries so path-only commands and remote assets route through the correct server.
- Keep ownership visible in multi-source UI and test duplicate display names.
- Do not persist temporary session context under a broader worktree or project identity.

## Keep multi-server behavior at the correct boundary

- Native desktop can aggregate enabled remote servers, but Web Access must use only its serving origin.
- Treat remote profiles as parallel adapters. Do not replace the native app's local core with a global backend switch.
- A server can remain connected and selectable while excluded from aggregate dashboard results.
- Gate native-only connections, aggregation, routing, caches, and ownership labels with `isNativeApp()`.

## Make state transitions atomic and observable

- Update durable storage and the active query cache before closing setup UI, or stale cache data can reopen it.
- Subscribe Zustand components to the data that controls rendering, not to stable getter functions.
- Guard Zustand mutations against no-op updates so unchanged values do not notify all subscribers.
- Test timing-sensitive close, reopen, refresh, and restoration paths, not only the persistence call.

## Verify behavior at system boundaries

- Read backend selection and ownership logic before relying on a command name or frontend callback.
- Test the real boundary contract: command arguments, CLI values, generated configuration, serialized data, and restored history.
- Verify every responsive UI branch and each supported runtime: native desktop, Web Access, and mobile where applicable.
- Keep long-running jobs backend-owned when they must survive client disconnects.

## Normalize external backend behavior end to end

- Classify a backend by its current documented transport and capabilities before integration. Do not keep old transport assumptions after a product migration.
- Normalize exact tool names and parameter shapes at the display boundary, with readable fallbacks for known native tools.
- Add live-stream and persisted-history parsers together, and route history by the per-run backend before generic fallback logic.
- Resolve default, custom, and empty prompts consistently on every backend; backend mode instructions must augment the shared prompt.
- A capability is complete only when preferences, every send path, persistence, rendering, cancellation, and tests all support it.

## Verify external tools from authoritative sources

- Check the current official site, migration guide, installer, release manifest, and binary help before designing an integration.
- Do not use an old registry entry or similarly named third-party package as proof of the supported product path.
- Check Jean-managed binary locations before declaring a tool unavailable; distinguish “not on PATH” from “not installed.”
- Verify installed skills through each harness's real discovery path. File presence alone does not prove discovery or invocation.

## Make setup actions produce a usable result

- If a feature needs dependent configuration, make its primary install action complete the safe required steps.
- Do not add a second setup action when Jean can configure the dependency automatically.
- Update default agent guidance when installation alone does not expose the intended workflow.

## Keep user-facing output explicit

- Discovery results must show a visible state for every result type, such as open, closed, or merged.
- Background actions should use one toast lifecycle: loading, then success or error with the same ID.
- Show persistent context such as resource ownership where the user needs it to understand later actions.

## Treat fresh-session creation as a backend contract

- Confirm that a “start” command explicitly creates a fresh session when the UI promises one.
- Wait for the returned session ID, select that exact session, and then open its view.
- Put one-shot investigation context on the created session so it cannot leak into later sessions.
- Test backend session selection and restoration, not only that the UI callback runs.

## Design cross-platform affordances explicitly

- Hide and disable keyboard-only actions outside native desktop unless they are useful in that runtime.
- Do not assume Unicode modifier glyphs render in browser fonts; use explicit labels such as `Ctrl` in Web Access.
- Test click or tap behavior separately from native keyboard shortcuts.

## Keep task tracking proportional

- Reset `.ai/todo.md` for each task and keep its checklist proportional to the work.
- For small fixes, record a short plan, verification, and result instead of a duplicate implementation report.
- Explain that `.ai/todo.md` is internal task tracking when a user asks why it changes.

## Separate implementation limits from external limits

- For production-readiness reviews, classify every gap as either implementable in Jean or unavailable in the external backend.
- Do not mark work complete while implementable items remain.
- Report verification limits separately from implementation limits.
