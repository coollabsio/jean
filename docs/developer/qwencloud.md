# QwenCloud

[QwenCloud](https://www.qwencloud.com/) exposes Qwen models through OpenAI-compatible,
Anthropic-compatible, and DashScope endpoints. Jean does not ship a dedicated
`qwencloud` CLI backend. Instead, it ships one-click provider presets for the
three existing custom-provider paths:

| Jean backend | Preset                                      | Endpoint                                |
| ------------ | ------------------------------------------- | --------------------------------------- |
| Claude CLI   | `QwenCloud` (Settings → Providers → Claude) | Anthropic-compatible `/apps/anthropic`  |
| Codex        | `QwenCloud` (Settings → Providers → Codex)  | OpenAI-compatible `/compatible-mode/v1` |
| Pi           | `qwencloud` (Settings → Providers → Pi)     | OpenAI-compatible `/compatible-mode/v1` |

Presets live in `src/types/preferences.ts` (`PREDEFINED_CLI_PROFILES`,
`PREDEFINED_CODEX_PROVIDERS`, `PREDEFINED_PI_PROVIDERS`). Adding a preset only
pre-fills the form; it never changes the user's default provider and never
rewrites `~/.codex/config.toml`.

## Setup

1. Create an API key in the [QwenCloud console](https://home.qwencloud.com/api-keys).
2. Export it as `DASHSCOPE_API_KEY` (Jean passes the environment variable name,
   not the secret, to Codex and Pi):

   ```bash
   export DASHSCOPE_API_KEY="sk-ws-..."
   ```

   The variable must be visible to the **Jean process** (restart the app / server
   after exporting it). This is the same environment variable used by model
   autofetch.

3. Settings → Providers, click the `QwenCloud` / `qwencloud` template, choose
   your region in the picker, and save. For the Claude CLI profile, replace
   `<your-qwencloud-api-key>` in the JSON with your key (or point
   `ANTHROPIC_AUTH_TOKEN` at a shell-expanded secret).
4. Pick the provider for a session, or set it as the default for that backend.

Do not commit API keys. The Claude profile writes a settings file under
`~/.claude/`, so treat it as secret material.

## Using native subscriptions and QwenCloud side by side

**Yes — they coexist.** A custom provider is additive, not a replacement:

- The session provider picker always keeps the native entry (`Anthropic` for
  Claude, `Default (OpenAI / ChatGPT)` for Codex) alongside every configured
  custom profile. The "default provider" preference only decides what **new**
  sessions start with; it does not disable the native subscription.
- Claude custom profiles are passed as a `--settings` file per session, and
  Codex custom `model_provider` entries are injected per session.
  `~/.codex/config.toml` and Claude's own login are left untouched. Pi custom
  providers are merged into `~/.pi/agent/models.json` under their own provider
  id, so built-in Pi providers remain available as `<provider>/<model>`.
- Magic Prompts resolve their own provider per prompt, so a code-review prompt
  can use the native Claude subscription while regular chats use QwenCloud.
- Switching the provider mid-session starts a fresh CLI session with a handoff.

One Codex caveat: Jean validates an inherited model against Codex app-server's
`model/list` catalog, but deliberately **skips that check when a custom
provider is active** (`jean-core/src/chat/codex.rs`), because the catalog
belongs to the CLI's current account, not to QwenCloud. Explicit model choices
are still passed through and validated by the CLI.

## Regions

Pay-as-you-go endpoints are region-scoped, and **an API key only works with the
base URL of the region it was created in**. Presets default to Singapore
(`ap-southeast-1`), which is the region QwenCloud's docs use.

You do not have to hand-edit URLs. A **QwenCloud region** picker appears in the
provider form whenever the base URL (or the Claude settings JSON) points at a
QwenCloud domain. Selecting a region rewrites the URL for all six regions plus
Token Plan, and re-fetches the Pi model list for that region:

| Region                  | Domain                                 |
| ----------------------- | -------------------------------------- |
| Singapore               | `ap-southeast-1.maas.qwencloudapi.com` |
| China North 2 (Beijing) | `cn-beijing.maas.qwencloudapi.com`     |
| Germany (Frankfurt)     | `eu-central-1.maas.qwencloudapi.com`   |
| China (Hong Kong)       | `cn-hongkong.maas.qwencloudapi.com`    |
| Japan (Tokyo)           | `ap-northeast-1.maas.qwencloudapi.com` |
| US (Virginia)           | `us-east-1.maas.qwencloudapi.com`      |

`maas.qwencloudapi.com` without a region prefix is an alias for Singapore and
is recognised as such. Model availability and prices differ by region.

**Token Plan** is a separate Singapore-only product with its own `sk-sp-` API
key and endpoint — it is listed in the picker, but replacing the base URL alone
is not enough:

- OpenAI compatible: `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1`
- Anthropic compatible: `https://token-plan.maas.qwencloudapi.com/apps/anthropic`

## Model lists and autofetch

Jean has several independent model-list sources; only the Pi one is fetched
from QwenCloud at runtime:

| Source                    | How it is populated                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global model catalog      | Static `coollabs-cdn/jean/models.json`, fetched hourly by the frontend, cached in localStorage, bundled fallback. Fixed backend whitelist. See [Model Catalog](./model-catalog.md). |
| Claude CLI custom profile | Fixed `opus` / `sonnet` / `haiku` aliases mapped by `ANTHROPIC_DEFAULT_*_MODEL` env vars. Jean never calls a provider's `/v1/models`.                                               |
| Codex                     | Local app-server `model/list` JSON-RPC. Skipped for custom providers (see above).                                                                                                   |
| Pi custom provider        | `models[]` array written into `~/.pi/agent/models.json`, shown as `<provider>/<model>`.                                                                                             |

QwenCloud's **OpenAI-compatible** endpoint does expose
`GET {base_url}/models` (it returns 401 without a key, i.e. the route exists),
while the Anthropic-compatible endpoint returns 404 for `/v1/models`. Jean uses
the former:

- When the `qwencloud` Pi preset is selected, Jean **automatically fetches**
  the region's model list and replaces the curated fallback list. Selecting a
  different region re-fetches, because availability differs per region.
- A **Fetch models from QwenCloud** button lets you refresh it manually.
- The `fetch_qwencloud_models` command
  (`jean-core/src/qwencloud.rs`) reads `DASHSCOPE_API_KEY` (or the configured
  env var) from the **Jean process environment**. The key is never stored in
  preferences and never sent over the Web Access WebSocket. The command
  validates that the base URL is an `https://` QwenCloud host before attaching
  the key, so a crafted URL cannot exfiltrate it.
- If the key is missing, invalid, or the region has no access, autofetch fails
  silently and the curated list stays. The manual button shows the full error.

The curated fallback list, used when autofetch is unavailable:

| Model id        | Use                                                     |
| --------------- | ------------------------------------------------------- |
| `qwen3.8-max`   | Complex reasoning and coding; also vision               |
| `qwen3.7-plus`  | Balanced quality, speed, and cost; also the coder model |
| `qwen3.8-flash` | Fast and cost-effective                                 |

Fetched ids are passed through unchanged, so any QwenCloud model id can be
used. Note that Claude and Codex keep their own native model pickers; making
those fetch QwenCloud models would require changing Jean's backend-specific
catalog logic and is not part of this integration.

## Wire formats and limitations

- Codex uses `wire_api: 'responses'`. QwenCloud supports both the Responses API
  (recommended for new integrations) and Chat Completions on the same base URL.
- Pi uses `openai-completions` because that is the format its custom provider
  registry expects.
- The Anthropic-compatible endpoint only implements `/v1/messages`. It has **no
  `/v1/models` endpoint**, so model discovery fails with a 404. The Claude
  preset therefore sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
  explicitly maps the `opus` / `sonnet` / `haiku` aliases to Qwen model ids.
  The base URL must end at `/apps/anthropic` — do not append `/v1/`.
- Thinking is supported by QwenCloud but `thinking.budget_tokens` is deprecated
  and behaves differently per model. The Claude preset sets
  `supports_thinking: false` to hide Jean's thinking control, matching the
  other Anthropic-compatible third-party presets (MiniMax, Z.ai, Moonshot).
- Qwen model names also appear in Jean's Command Code model picker
  (`commandcode/Qwen/...`). Those go through Command Code's own provider, not
  QwenCloud credentials.

## References

- [QwenCloud docs](https://docs.qwencloud.com/)
- [Regions and endpoints](https://docs.qwencloud.com/developer-guides/getting-started/regions)
- [Model selection](https://docs.qwencloud.com/developer-guides/getting-started/model-selection)
- [Anthropic-compatible API](https://docs.qwencloud.com/api-reference/chat/anthropic)
