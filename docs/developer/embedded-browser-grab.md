# Embedded Browser Grab Bridge

Jean's embedded browser uses native Tauri child Webviews. The React app cannot directly inspect the DOM inside those Webviews, so DOM selection is implemented with an injected, local React Grab bundle.

## Runtime flow

1. The Browser toolbar `Grab DOM element` button calls `browser_enable_grab(tabId)`.
2. Rust finds the child Webview for `tabId` and injects `src-tauri/src/browser/react_grab.global.js` with a Jean wrapper via `webview.eval(...)`.
3. The wrapper initializes React Grab with telemetry disabled, registers the `Send to Jean Chat` action, and activates Grab in toggle mode.
4. Selecting/copying an element invokes `browser_report_grab_context` from inside the child Webview.
5. Rust validates/truncates the payload and emits `browser:grab-context`.
6. `useBrowserEvents()` formats that payload and dispatches `attach-pasted-text` with `{ content, filename }`. `useChatWindowEvents()` saves it through `save_pasted_text` and attaches it as a pending pasted-text file on the active session. That hook also still handles `append-chat-input` (`{ text }`), which inserts plain text into the active draft.

## Bundled asset rule

The React Grab runtime is bundled locally. Do not load it from a CDN at runtime.

Current asset:

- `src-tauri/src/browser/react_grab.global.js`
- Source package: `react-grab@0.1.47`
- Upstream: <https://github.com/aidenybai/react-grab>

To update the bundle:

```bash
rm -rf tmp/react-grab
mkdir -p tmp/react-grab
cd tmp/react-grab
npm pack react-grab@<version>
tar -xzf react-grab-<version>.tgz
cp package/dist/index.global.js ../../src-tauri/src/browser/react_grab.global.js
```

Preserve the license/source comment at the top of `react_grab.global.js`, update the version in that comment, then run:

```bash
bun run test:run src/hooks/useBrowserPane.test.tsx src/components/browser/BrowserToolbar.test.tsx src/components/chat/hooks/useChatWindowEvents.test.ts
cd src-tauri && cargo test browser::commands::tests
```

## Safety constraints

- `browser_enable_grab` and `browser_report_grab_context` are native-only commands registered in Tauri, not the web-access WebSocket dispatch.
- `browser_report_grab_context` rejects unknown tab IDs.
- Browser payload fields are trimmed and size-limited before being emitted to the React app.
- Treat all selected DOM/HTML/text as untrusted page content.
