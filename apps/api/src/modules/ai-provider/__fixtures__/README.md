# AI-provider HTTP fixtures

Captured/representative HTTP responses used by the ai-provider unit tests.

| File | Provenance |
|------|-----------|
| `moonshot-401-auth.json` | **Live-captured** from `api.moonshot.cn` on 2026-07-17 (real `Invalid Authentication` 401). |
| `ratelimit-429-retry-after.json` | Representative OpenAI-compatible 429 with a short `Retry-After` (transient rate-limit). |
| `ratelimit-429-quota.json` | Representative 429 with a long `x-ratelimit-reset-*` (weekly quota exhausted). |
| `ratelimit-429-no-headers.json` | Representative 429 with no reset hint (falls back to persisted exp backoff). |
| `server-500.json` | Representative upstream 5xx (transient). |

Each fixture is `{ status, headers, body }`; tests build a `Response` from it and
feed it to a mocked `fetch`. Live capture of a real 429 was not possible while
writing these — the account's Kimi/ollama-cloud keys are quota-exhausted *and*
the valid keys live in a Postgres instance that was down — so the 429 shapes are
modelled on the documented OpenAI-compatible header contract that both
`api.moonshot.cn` and `ollama.com` implement.
