# Model Catalog

Jean loads model metadata from the coolLabs CDN and falls back to metadata
bundled in `src/services/model-catalog.ts` when the network or cache is
unavailable.

Remote entries are keyed by backend and model ID. For Codex a remote catalog
replaces the bundled model list. For Claude the two lists are **merged**: CDN
entries come first and bundled entries missing from the CDN are appended, so a
model shipped in this build stays visible while the CDN file is behind. The CDN
can still remove a bundled model by marking it `hidden: true`. Other backends
merge CDN entries ahead of models discovered from their CLI. Fast variants
inherit their base model's reasoning capability.

## Claude models newer than this build

The CDN file is maintained by hand, so it can lag a release by days or weeks.
Claude also offers no way to discover models from the installed CLI: there is
no `claude model list` command, and Claude Code's OAuth token is rejected by
`GET /v1/models` ("OAuth authentication is currently not supported"). Jean
therefore cannot autofetch a subscription's model list.

Two mechanisms keep the picker usable in the meantime:

- The Claude merge described above, so a model bundled in the release appears
  even when the CDN is stale.
- Settings → Providers → Claude → **Custom model IDs**, stored in the
  `custom_claude_models` preference. Any plausible `claude-*` id can be added;
  it is shown at the top of the Claude picker with a `(custom)` suffix and is
  passed straight to `claude --model`. `normalizeClaudeModel` already accepts
  unknown `claude-*` ids, so no extra plumbing is needed.

When the CDN catches up, remove the custom entry — the catalog entry replaces
it automatically because the picker de-duplicates by id.

## Inherited Codex defaults

Before saving a new Codex chat session, the shared backend checks the inherited
model against the current CLI account's `model/list` catalog. It keeps an
available preference (including its Fast variant), or selects the catalog's
visible default, then its first visible model. Pagination is followed before
rejecting a preferred model. The resolved model is saved in the session, so
MCP, native desktop, Web Access, and mobile use the same selection. Empty
sessions without a saved model use the same check on their first send, including
sessions reused by MCP.

This check does not rewrite global preferences, explicit session or turn
choices, terminal sessions, or custom provider models. If catalog discovery
fails or returns no visible models, session creation keeps the preference.
The CLI remains responsible for validating explicit model selections.

Protocol: https://developers.openai.com/codex/app-server (`model/list`).

## Applying a model to all Magic Prompts

Settings → Magic Prompts has an **All prompts** row: a searchable model
picker grouped by installed backend, a **Fast** switch, a **Mode** select
(Plan/Yolo), and an **Apply to all prompts** button. The picker uses the same
catalog/discovered model options as the individual prompt controls, but lists
only base models; the Fast switch picks the fast variant when the selected
model has one. Do not add model-specific presets to this menu.

Apply updates every configurable prompt's backend, model, execution mode, and
supported default reasoning level, and replaces the Code Review runners with
one matching runner (its fix mode uses the selected mode). It clears provider
overrides so a custom Claude profile cannot redirect the selected first-party
model. Prompt text is not changed.

## Reasoning capability

Each model can declare at most one reasoning control:

```json
{
  "reasoning": {
    "type": "effort",
    "default": "high",
    "levels": [
      {
        "value": "high",
        "label": "High",
        "description": "Greater reasoning depth"
      }
    ]
  }
}
```

- `type` is `effort` or `thinking`.
- `default` must match one level's `value`.
- `levels` controls ordering, labels, descriptions, and available values in
  desktop, mobile, and Settings UI, including each configurable Magic Prompt.
- Magic Prompts present an explicit supported level. The catalog default is
  selected when no valid override exists and is persisted when the prompt's
  backend or model changes; no separate "model default" option is shown.
- Each configured Code Review runner persists its own reasoning level. Its
  options are resolved from that row's backend/model and the selected Claude
  provider, and that value is sent only to the matching review job.
- Custom Claude providers hide the control unless provider-specific model
  metadata is available, because aliases such as `opus` may map to models with
  different reasoning capabilities.
- Effort values are passed through to the selected backend, so the CDN can add
  backend-native values without a Jean release.
- Codex effort values must match the values advertised by app-server
  `model/list`. GPT-5.6 Sol and Terra advertise native `max` and `ultra`
  (`ultra` includes automatic task delegation); GPT-5.6 Luna advertises `max`
  but not `ultra`. Claude's separate workflow value remains `ultracode`.
- Traditional Claude thinking uses `off`, `think`, `megathink`, and
  `ultrathink`. A numeric value such as `16000` defines a custom
  `MAX_THINKING_TOKENS` budget.
- Jean injects an `adaptive` option (UI label **Adaptive/Default**) only for
  **Gemini** model ids (name contains `gemini`). When selected, Jean omits the
  thinking/effort parameter so Gemini can use its native adaptive/default depth
  (e.g. Gemini 3.5 Flash). The wire value remains `adaptive`. Non-Gemini models
  never show this option. Note: Command Code and Cursor hide the reasoning
  control entirely, so Adaptive/Default is only visible when a Gemini model is
  used on a backend that shows effort/thinking (e.g. OpenCode).
- Omit `reasoning` for models without a control. Set `reasoning` to `null` to
  explicitly remove a bundled capability.

Invalid reasoning metadata is ignored without dropping the model. Jean keeps a
bundled copy of supported capabilities so offline startup has the same controls
until newer CDN metadata is fetched.

The deployed catalog source is
`coollabs-cdn/json/jean/models.json` in the linked coolLabs CDN repository.
