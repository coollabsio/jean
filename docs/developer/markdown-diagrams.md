# Mermaid diagrams in messages

The shared `Markdown` component recognizes fenced code blocks with the
`mermaid` language. Unfenced text and other code blocks are unchanged.
This applies to desktop, Web Access, compact/mobile, and tool-call Markdown.

`MermaidBlock` is lazy-loaded only for completed messages containing diagrams.
During streaming, the original code block stays visible; incomplete diagrams
are not parsed. Completed diagrams provide a single-selection Diagram/Code segmented control,
icon actions with tooltips and accessible names for clipboard copy through the
shared native/web helper, and an accessible enlarged dialog. Icon actions use
44px targets on mobile.
Invalid syntax falls back to readable source without breaking the message.

Mermaid rendering is serialized because its configuration is global. Rendering
uses a temporary off-screen container removed on success or failure. Each render
uses a new ID because Mermaid removes existing elements with that ID. Stale
results are ignored after source/theme changes or unmount. Successful SVGs are
cached by theme and source (bounded), so remounts such as session switches do
not run the layout again or change message height. Failures are not cached. The applied root
`dark` class drives theme changes, including system theme changes.

Treat diagram source as untrusted: retain strict Mermaid security, disallow
message overrides of security limits and custom theme CSS/fonts, and sanitize
the SVG with DOMPurify before insertion. Do not enable Mermaid click callbacks
or bind its interactive functions. Scripts, links, embedded frames, and external
images and SVG foreignObjects are disallowed. Labels use pure SVG text instead
of HTML integration points, so sanitization retains their content and line breaks.

Mermaid strips `secure` keys at every config depth, so locking `htmlLabels`
also locks `flowchart.htmlLabels`. Do not lock whole diagram sections such as
`flowchart`: that blocks harmless directives (for example `curve`).

Tests: `markdown-mermaid.test.tsx` covers routing and streaming;
`mermaid-block.test.tsx` covers controls, failures, sanitization, themes,
caching, and stale render handling; `mermaid-config.test.ts` runs the real
Mermaid directive pipeline against the locked config. These mock Mermaid and do not replace real-browser
checks of diagram layout.

Native macOS page zoom: WKWebView scales `em`-based SVG text positions
inconsistently with node geometry. After sanitization, font-relative text
coordinates are resolved to SVG user units in the attached off-screen container.
This preserves text/node alignment across zoom changes without rerendering the
diagram or enabling HTML labels. Verify layout with actual WKWebView `pageZoom`,
not CSS zoom alone; mocked Mermaid tests only cover the normalization contract.
