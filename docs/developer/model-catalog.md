# Model Catalog

Jean loads model metadata from the coolLabs CDN and falls back to metadata
bundled in `src/services/model-catalog.ts` when the network or cache is
unavailable.

Remote entries are keyed by backend and model ID. A remote model replaces the
bundled model list for Claude and Codex; other backends merge CDN entries ahead
of models discovered from their CLI. Fast variants inherit their base model's
reasoning capability.

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
