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

3. Settings → Providers, click the `QwenCloud` / `qwencloud` template, and save.
   For the Claude CLI profile, replace `<your-qwencloud-api-key>` in the JSON
   with your key (or point `ANTHROPIC_AUTH_TOKEN` at a shell-expanded secret).
4. Pick the provider for a session, or set it as the default for that backend.

Do not commit API keys. The Claude profile writes a settings file under
`~/.claude/`, so treat it as secret material.

## Regions

Pay-as-you-go endpoints are region-scoped, and **an API key only works with the
base URL of the region it was created in**. Presets default to Singapore
(`ap-southeast-1`), which is what the QwenCloud docs use. To use another region,
replace `ap-southeast-1` in both the base URL and create a key in that region:

| Region                  | Domain                                 |
| ----------------------- | -------------------------------------- |
| Singapore               | `ap-southeast-1.maas.qwencloudapi.com` |
| China North 2 (Beijing) | `cn-beijing.maas.qwencloudapi.com`     |
| Germany (Frankfurt)     | `eu-central-1.maas.qwencloudapi.com`   |
| China (Hong Kong)       | `cn-hongkong.maas.qwencloudapi.com`    |
| Japan (Tokyo)           | `ap-northeast-1.maas.qwencloudapi.com` |
| US (Virginia)           | `us-east-1.maas.qwencloudapi.com`      |

`maas.qwencloudapi.com` without a region prefix is an alias for Singapore.
Model availability and prices differ by region; check the region's model list
before selecting a model id.

**Token Plan** is a separate Singapore-only product with its own API key and
endpoint. Replacing the base URL alone is not enough:

- OpenAI compatible: `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1`
- Anthropic compatible: `https://token-plan.maas.qwencloudapi.com/apps/anthropic`

## Models

The presets list the current general-purpose text models:

| Model id        | Use                                                     |
| --------------- | ------------------------------------------------------- |
| `qwen3.8-max`   | Complex reasoning and coding; also vision               |
| `qwen3.7-plus`  | Balanced quality, speed, and cost; also the coder model |
| `qwen3.8-flash` | Fast and cost-effective                                 |

Model ids are passed through unchanged, so you can add other QwenCloud ids
(for example `qwen3-coder-flash`) in the Pi provider editor or via the CDN
model catalog. See [Model Catalog](./model-catalog.md) for how Jean merges
remote metadata.

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
