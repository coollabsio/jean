# Issue 724: Windows WebView focus recovery

- [x] Confirm the issue context, focus event path, and relevant platform/runtime constraints.
- [x] Identify the root cause and regression history.
- [x] Add failing tests for safe focus-recovery decisions.
- [x] Implement the smallest Windows native focus fix.
- [x] Run focused tests and quality checks.
- [x] Record the investigation and verification result.

## Review

- Root cause: the prior issue #602 fix listened only for the DOM `window.focus`
  event. WebView2 can restore the native Tauri window without delivering that
  event to the DOM, so no restoration runs and document key handlers stay cut
  off until a click.
- Fix: also subscribe to Tauri's native `onFocusChanged` event and route a
  focused event through the existing deferred restoration logic. Keep the DOM
  listener as a fallback and preserve overlay, terminal, browser, and active
  control focus behavior.
- Tests: added red-green coverage for native focus gain/loss, native listener
  cleanup, and a queued native event after cleanup. The focused 63 tests pass;
  TypeScript, ESLint, formatting, and diff checks pass.
- Full `bun run check:all` reached 351 frontend files / 2,392 passing tests, but
  the existing Rust suite cannot compile because `jean-core/src/projects/commands.rs:15299`
  initializes `Project` without the required `sentry_base_url` field. This is
  outside the focus change.
- Manual Windows WebView2 verification is still required because this Linux
  environment cannot reproduce native Windows Alt+Tab focus handoff.
