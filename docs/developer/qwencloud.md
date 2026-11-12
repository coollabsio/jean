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
2. Export the key for your billing mode (Jean passes the environment variable
   name, not the secret, to Codex and Pi):

   ```bash
   # Pay-as-you-go (sk-ws- key)
   export DASHSCOPE_API_KEY="sk-ws-..."

   # Token Plan (sk-sp- key) - separate variable, so both can coexist
   export QWENCLOUD_TOKEN_PLAN_API_KEY="sk-sp-..."
   ```

   The variable must be visible to the **Jean process** (restart the app / server
   after exporting it). These are the same variables used by model autofetch.

3. Settings → Providers, click the `QwenCloud` / `qwencloud` template, choose
   your region **and billing mode** in the picker, and save. Switching between
   Pay-as-you-go and Token Plan rewrites the base URL and the API key env var
   together. For the Claude CLI profile, replace `<your-qwencloud-api-key>` in
   the JSON with your key (or point `ANTHROPIC_AUTH_TOKEN` at a shell-expanded
   secret) — Claude profiles hold the token inline, so swap it manually when
   changing modes.
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

## Two billing modes (not interchangeable)

QwenCloud has two completely separate billing modes. **Keys and endpoints must
not be mixed** — a `sk-sp-` key fails against a regional endpoint and vice
versa:

|                     | Pay-as-you-go                     | Token Plan                               |
| ------------------- | --------------------------------- | ---------------------------------------- |
| Key prefix          | `sk-ws-` (older keys `sk-`)       | `sk-sp-`                                 |
| Key env var in Jean | `DASHSCOPE_API_KEY`               | `QWENCLOUD_TOKEN_PLAN_API_KEY`           |
| Base URL host       | `{region}.maas.qwencloudapi.com`  | `token-plan.maas.qwencloudapi.com`       |
| Regions             | all six, key scoped to its region | Singapore only, no region ID             |
| Billing             | per call                          | monthly Credits quota                    |
| Model catalogue     | full region/workspace catalogue   | smaller plan-specific list, incl. `auto` |

Both modes expose the same two protocol paths (`/compatible-mode/v1` and
`/apps/anthropic`) and both expose `GET {base_url}/models` (401 without a key,
404 on the Anthropic `/v1/models`). Token Plan covers only the models listed
for the Individual or Team edition, and its terms restrict use to interactive
programming/agent tools rather than custom backends.

The provider picker groups endpoints by billing mode. Switching mode rewrites
the base URL **and** the API key env var for Codex/Pi, and re-fetches the Pi
model list. For the Claude CLI profile the key is inline in the settings JSON,
so replace it when switching modes.

## Pay-as-you-go regions

Regional keys only work with the endpoint of the region where they were
created. Presets default to Singapore (`ap-southeast-1`), the region used in
QwenCloud's docs. The picker rewrites the URL automatically:

| Region                  | Domain                                 |
| ----------------------- | -------------------------------------- |
| Singapore               | `ap-southeast-1.maas.qwencloudapi.com` |
| China North 2 (Beijing) | `cn-beijing.maas.qwencloudapi.com`     |
| Germany (Frankfurt)     | `eu-central-1.maas.qwencloudapi.com`   |
| China (Hong Kong)       | `cn-hongkong.maas.qwencloudapi.com`    |
| Japan (Tokyo)           | `ap-northeast-1.maas.qwencloudapi.com` |
| US (Virginia)           | `us-east-1.maas.qwencloudapi.com`      |

`maas.qwencloudapi.com` without a region prefix is a Singapore alias and is
recognised as such. Model availability and prices also differ by region and by
workspace: a key in a sub-workspace only sees models granted to that workspace,
which autofetch reflects automatically.

## Model lists and autofetch

Jean has several independent model-list sources; only the Pi one is fetched
from QwenCloud at runtime:

| Source                    | How it is populated                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global model catalog      | Static `coollabs-cdn/jean/models.json`, fetched hourly by the frontend, cached in localStorage, bundled fallback. Fixed backend whitelist. See [Model Catalog](./model-catalog.md). |
| Claude CLI custom profile | Fixed `opus` / `sonnet` / `haiku` aliases mapped by `ANTHROPIC_DEFAULT_*_MODEL` env vars. Jean never calls a provider's `/v1/models`.                                               |
| Codex                     | Local app-server `model/list` JSON-RPC. Skipped for custom providers (see above).                                                                                                   |
| Pi custom provider        | `models[]` array written into `~/.pi/agent/models.json`, shown as `<provider>/<model>`.                                                                                             |

QwenCloud's **OpenAI-compatible** endpoint exposes `GET {base_url}/models` on
both billing modes (401 without a key, i.e. the route exists — verified on the
Singapore regional host and on `token-plan.maas.qwencloudapi.com`). The
Anthropic-compatible endpoint returns 404 for `/v1/models`. Jean uses the
former:

### What the fetched list contains

**All model IDs your key can access on that endpoint — not just Qwen-branded
ones.** QwenCloud documents its third-party text models as "Same API format as
Qwen models", so the list normally includes DeepSeek, Kimi, GLM and MiniMax ids
alongside `qwen3.8-max` / `qwen3.7-plus` / `qwen3.8-flash`. The exact set is
scoped by:

- **Region** — models and prices differ per region.
- **Workspace** — a sub-workspace key only sees models granted to it.
- **Billing mode** — Token Plan returns its smaller plan catalogue, which
  includes `auto`, `qwen3.8-max`, `qwen3.8-flash`, `glm-5.3`,
  `deepseek-v4-pro`, etc. It does not include every pay-as-you-go model.
- **Capability** — QwenCloud's marketplace also lists image, video, speech and
  embedding models. If `/models` includes any of those, they will appear in the
  list too, but they are not callable through the chat completions endpoint
  (Token Plan even gives them dedicated endpoints). Remove them in the models
  textarea, or narrow the list with the switch below.

An **Only Qwen-branded models** switch filters the fetched list to ids starting
with `qwen`, without another network call. It is off by default so third-party
coding models stay available. The list is always editable before saving.

### How the fetch works

- Selecting the `qwencloud` Pi preset **autofetches** the model list. Changing
  the region **or billing mode** re-fetches, because availability differs for
  both. A **Fetch models from QwenCloud** button refreshes manually.
- The `fetch_qwencloud_models` command (`jean-core/src/qwencloud.rs`) reads the
  key env var for the selected mode (`DASHSCOPE_API_KEY` or
  `QWENCLOUD_TOKEN_PLAN_API_KEY`) from the **Jean process environment**. The key
  is never stored in preferences and never crosses the Web Access WebSocket.
  The command validates that the base URL is an `https://` QwenCloud host before
  attaching the key, so a crafted URL cannot exfiltrate it.
- If the key is missing, invalid, or the endpoint has no access, autofetch fails
  silently and the curated list stays. The manual button shows the full error.

The curated fallback list, used when autofetch is unavailable:

| Model id        | Use                                                     |
| --------------- | ------------------------------------------------------- |
| `qwen3.8-max`   | Complex reasoning and coding; also vision               |
| `qwen3.7-plus`  | Balanced quality, speed, and cost; also the coder model |
| `qwen3.8-flash` | Fast and cost-effective                                 |

Fetched ids are passed through unchanged. Claude and Codex keep their own
native model pickers; making those consume QwenCloud's `/models` would require
backend-specific catalog changes and is not part of this integration.

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
- Token Plan's terms of use limit it to interactive use inside programming and
  agent tools (not automation scripts or custom app backends). Jean is such a
  tool, but check the plan terms before wiring a Token Plan key into
  non-interactive workflows.

## References

- [QwenCloud docs](https://docs.qwencloud.com/)
- [Regions and endpoints](https://docs.qwencloud.com/developer-guides/getting-started/regions)
- [API keys: Pay-as-you-go vs Token Plan](https://docs.qwencloud.com/developer-guides/administration/api-keys)
- [Model selection](https://docs.qwencloud.com/developer-guides/getting-started/model-selection)
- [Token Plan Individual quickstart](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart)
- [Token Plan supported models](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview)
- [Anthropic-compatible API](https://docs.qwencloud.com/api-reference/chat/anthropic)
