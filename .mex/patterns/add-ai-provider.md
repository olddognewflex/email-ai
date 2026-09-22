---
name: add-ai-provider
description: Add or modify an LLM provider adapter. Six registration points must all be updated or the provider silently falls back to mock.
triggers:
  - "add provider"
  - "new llm"
  - "provider adapter"
  - "openai"
  - "anthropic"
  - "gemini"
  - "deepseek"
  - "kimi"
edges:
  - target: context/ai-providers.md
    condition: always — the adapter contract, error taxonomy, and breaker semantics live there
  - target: context/conventions.md
    condition: when checking naming and the Verify Checklist
  - target: patterns/debug-pipeline-stall.md
    condition: when the new provider trips the breaker or produces fallback rows
grounds_to:
  - node: "method:4bf356fe515ec5c34c41b9949c14d1b7"
    fingerprint: "mh:64:7b226d696e68617368223a5b38323335383239362c31373331333535382c35303732333734382c34363734323436342c34373830363431312c35343034383637302c3135313431343531372c343137323934392c36313539343433332c35303332323230372c37363135313431302c31363031383335382c36303336323334302c32343837333139332c36373138363934312c3130393434393032372c3135363939333132302c33303130323934322c393230383837362c3132373139343932322c35323331333632372c33363231303432362c31303338313436342c31393238343430312c34373338303537342c34323533363137332c3132303732313034342c3139373139333339322c31383536383933332c3134393937313532362c33363436383430372c33313732343036362c34373938353437312c33323433363235352c3131333434323831332c313934333631382c34313836363337352c3235353139333336312c32343839343034332c383431393834362c34313839393036372c35383538323031332c31333332303938352c31303137373432342c39373531363434342c33373830343637332c35363937363538362c35313139333435372c35333833313035372c31393135323535342c37363534343731382c3130383534353235312c363633363733392c3230383337353737342c32313334363639322c31353033333735322c36353736353130392c31333034303838372c31383032383334372c39373737343533382c3131383733353536302c393134333130362c373435303735342c31313732363932355d2c226e65696768626f7273223a5b226d6574686f643a3864393137366238383433653439613233343266633034613363633732653639225d2c22746f6b656e436f756e74223a3139377d"
  - node: "function:1e1073e0c8f762a22096b51fb3b8f3c8"
    fingerprint: "mh:64:7b226d696e68617368223a5b32313037323131302c32313036363539332c37323036373631342c3130383538333939332c33383331363439372c383330373439392c34343535333035312c343137323934392c31323732353739302c31313130393635372c31353832343036372c36313432313439312c35373339363331382c32313034343836352c3131393432323736322c31373432393235382c3136303430383035352c33303130323934322c3131313435303934312c34353039333438372c35323331333632372c333135363131332c313830393030342c3133303438383336332c343935373133332c36383732393532372c37383333383237322c313134303036392c33323435303830362c3130313933303030352c32383736313331342c33323530353337392c383035373739312c33323433363235352c313731393038382c313934333631382c31383433383939352c32343335393730302c39363232383530372c383431393834362c39303538363132342c35333434313037392c3832363536312c3131313339393435382c353630353534392c35343635303630342c32363234373734362c35313139333435372c363837393436372c32393135323035322c34353934333130312c31353232313031332c33363335393437342c31323530363532332c32313334363639322c31353033333735322c31353038393935392c31333034303838372c31373434373134362c34333833313432332c3130323539343134302c393830373839362c32333032383630312c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a3835626638376131343535376537326662343038353738313762653664633565222c226d6574686f643a3336666634636231633434346363373935386338353737306162383866636335222c226d6574686f643a3362663362376535636633396331303763653964383130613563653665623937222c226d6574686f643a3532306662633736356331363338616237396133623866313435323039666233222c226d6574686f643a6238316439616263396137396139316531343962633230393566616162623836222c226d6574686f643a6434316132306663346136643439303935663266353135383864323661333639222c226d6574686f643a6639386366663832666139636638383164623233656631313137383861626236225d2c22746f6b656e436f756e74223a3131347d"
  - node: "function:b9cb582082755a9ef30d830ef347b285"
    fingerprint: "mh:64:7b226d696e68617368223a5b31353737393431342c34393533323430392c3133393933353836392c39343636323635382c33383331363439372c35343034383637302c36363830343830382c35303232353939342c3136333339343834342c32333232373733322c3339323234372c33383834363732362c35373339363331382c32343837333139332c38353033373536332c31383133353038362c35353736363634342c32303232303533322c313739363232322c3139333830313634352c31343034393835392c3131343830343532322c38343436363135382c363736383239302c33353934353230322c31363836393236352c323034383432372c313134303036392c37323730323135352c3131373931363636302c35323730373134382c3136353231323938352c31353131373936302c35363434373436342c3130353833333336392c39343439303633362c38333437393334342c34373936323638392c3230303035363937382c36363239383932352c36353530383733302c32393232323236382c3832363536312c33353039363733342c313133353535372c35343635303630342c34333439333638352c39383035343233352c363837393436372c32393135323035322c33373931353232342c36313039373436382c33363335393437342c33313839363634352c32353231383733312c31343139343035362c36343230393034372c36303932353238382c35333937353530322c38303636353635392c32343935373832312c393830373839362c32323333383536342c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a3739616631656564346164613932633633313237363263383634383537373966222c226d6574686f643a3830383333306231373334336538343031303534316465663166326162363835222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936225d2c22746f6b656e436f756e74223a3134307d"
last_updated: 2026-08-10
---

# Add an AI Provider

## Context

Load `context/ai-providers.md`. An adapter is a class implementing the one-method
`BaseLlmProvider` interface with a hand-written `fetch` — there are no vendor SDKs in this
repo, deliberately. `openai.provider.ts` is the reference implementation; `google.provider.ts`
is the reference for a vendor whose request/response shape is not OpenAI-compatible.

The registration point is the `switch` in
[`createProviderInstance()`](mex://method:4bf356fe515ec5c34c41b9949c14d1b7), and the
failure mode for missing registration is silent: an unrecognised provider string logs a warning
and returns `MockLlmProvider`.

## Steps

1. Create `apps/api/src/modules/ai-provider/providers/<name>.provider.ts` exporting
   `class <Name>Provider implements BaseLlmProvider`. Constructor takes
   `(apiKey, model, apiEndpoint?)`, defaulting the endpoint if the vendor requires a fixed base.
2. In `complete()`: build the request body, `fetch`, then **immediately**
   `await throwIfNotOk(response, "<name>")` before touching the body. Only then parse and map
   into `LlmResponse` (`content`, optional `usage` with `promptTokens` / `completionTokens` /
   `totalTokens`).
3. Export the class from `providers/index.ts`.
4. Add a `case "<name>":` to the `switch` in `createProviderInstance`.
5. Add the literal to `AiProviderTypeSchema` in
   `packages/shared/src/schemas/ai-provider.schemas.ts`, **and** an entry in the
   `AI_PROVIDER_METADATA` record — it is typed `Record<AiProviderType, ...>`, so a missing entry
   is a compile error but a stale one is not.
6. Add a row to the provider tables in `README.md` and
   `apps/api/src/modules/ai-provider/README.md`.
7. Add a `<name>.provider.spec.ts` next to the adapter. Follow `kimi.provider.spec.ts`, which
   drives the error paths from the JSON fixtures in `__fixtures__/` (401 auth, 429 with
   `Retry-After`, 429 quota, 429 with no headers, 500) rather than hitting the network.

## Gotchas

- **Skipping `throwIfNotOk` breaks everything downstream.** It is what turns an HTTP failure
  into an `AiProviderError` carrying `status`, `retryAfterMs`, and `resetAt`; without it a 429
  becomes a JSON parse error, [`categorizeError()`](mex://function:b9cb582082755a9ef30d830ef347b285) returns
  `unknown`, and neither the retry logic nor the breaker behaves correctly.
- **Any 4xx that is not 429/408 is categorized `auth` and holds the breaker for 12 hours.** A
  provider that answers a malformed request with 400 will stop *all* AI work for the rest of the
  day. Test a bad-request path before shipping.
- Adapter instances are cached per `AiProviderConfig.id` in `providerInstances`. Editing a
  config row does not evict a cached adapter within a running process — restart the API after
  changing an endpoint or key, or expect stale behaviour.
- `temperature` and `maxTokens` on the request come from `ClassificationService`, not from the
  active config row: it hardcodes `temperature: 0.3` and reads `AI_MAX_TOKENS` from the
  environment. The `maxTokens` column is effectively unused for classification.
- Reasoning models spend hidden thinking tokens from the same output budget. Too low an
  `AI_MAX_TOKENS` truncates the JSON mid-string, which surfaces as a `fallback` classification
  rather than an error.
- The API key is stored in Postgres in plaintext; never echo it into a log line or a response.

## Verify

- [ ] `pnpm typecheck` and `pnpm test` pass.
- [ ] `curl localhost:3000/ai-providers/available` lists the new provider.
- [ ] Create + activate a config, run `POST /classification/:id/classify` on one email, and
      confirm `GET /classification/stats` shows the new name under `byProvider` — **not**
      `mock` or `fallback`.
- [ ] Point the adapter at a bad key once and confirm the breaker opens with
      `reason: "auth"`, then clear it (`~/.local/state/email-ai/ai-breaker.json`).
- [ ] `apiKey` does not appear in any `/ai-providers` response.

## Debug

- Classifications say `providerUsed: "mock"` → no active config row, or the `switch` case is
  missing so the default branch returned mock. Check the warning in the API log.
- Classifications say `providerUsed: "fallback"` → the model answered but the JSON failed
  `EmailClassificationOutputSchema`. Read `classificationError` and `rawResponse` on the row.
- Everything is skipped → breaker is open. `getBreakerStatus()`, or inspect the state file.
- 429s are not being retried → the adapter is not calling `throwIfNotOk`, so `retryAfterMs`
  never reaches the rate limiter.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
