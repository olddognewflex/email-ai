---
name: ai-providers
description: The LLM provider abstraction — adapter contract, error taxonomy, in-run rate limiting, and the persisted circuit breaker. Load before touching anything that calls a model.
triggers:
  - "ai provider"
  - "llm"
  - "openai"
  - "anthropic"
  - "model"
  - "rate limit"
  - "circuit breaker"
  - "429"
  - "quota"
edges:
  - target: context/pipeline.md
    condition: when tracing how classification consumes a completion
  - target: context/decisions.md
    condition: when the reasoning behind the persisted breaker or db-stored config is needed
  - target: context/architecture.md
    condition: when placing this module in the wider system
  - target: patterns/add-ai-provider.md
    condition: when adding or modifying a provider adapter
  - target: patterns/debug-pipeline-stall.md
    condition: when classification is skipping emails or producing fallback rows
grounds_to:
  - node: "method:d15fc631a3e5febb0e19d93ab4021f96"
    fingerprint: "mh:64:7b226d696e68617368223a5b31303137383634342c323737393737382c31393938353832332c33343631303534322c31323833313539342c33313235313232372c34343535333035312c343137323934392c31303732373536352c32353530383838352c31303630303733392c363734383038362c36303336323334302c32343837333139332c31333137393237352c32353536373834312c34323138313935332c33303130323934322c393230383837362c31343739333537382c33383137363739372c31353830313837312c313830393030342c33303035373132362c31353639383132392c36383732393532372c323034383432372c32333239363630332c31383536383933332c37343130343137372c31313137393535322c33313732343036362c32373733383333372c33323433363235352c323634323537392c313934333631382c31383433383939352c3135353833373931362c35313731343136382c373030313734352c35333139363435342c34383535313237302c34363737363635332c31303137373432342c353630353534392c383038393933302c38373330343132352c35313139333435372c35333833313035372c37383738303537322c32383735383133322c35323232373835342c3130303133323139382c31313931323733372c32313334363639322c31323939303330362c32343133323430332c31333034303838372c31333235333739312c31303831393534332c34383536313233342c393134333130362c383934343635322c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a6239636235383230383237353561396566333064383330656633343762323835222c226d6574686f643a3561336339383832363266643330316335616635363936323463393534636536222c226d6574686f643a3564376437653037373332323166346265356432313438313065353732363964222c226d6574686f643a3830383333306231373334336538343031303534316465663166326162363835222c226d6574686f643a3834663861306531343366346639353264393564613739646438656363383537222c226d6574686f643a3864393137366238383433653439613233343266633034613363633732653639222c226d6574686f643a6361643836336438306664633361653339623762616430353030653161363138222c226d6574686f643a6531303436326463633839336231306138633838316665386439643965366561225d2c22746f6b656e436f756e74223a3238377d"
  - node: "function:b9cb582082755a9ef30d830ef347b285"
    fingerprint: "mh:64:7b226d696e68617368223a5b31353737393431342c34393533323430392c3133393933353836392c39343636323635382c33383331363439372c35343034383637302c36363830343830382c35303232353939342c3136333339343834342c32333232373733322c3339323234372c33383834363732362c35373339363331382c32343837333139332c38353033373536332c31383133353038362c35353736363634342c32303232303533322c313739363232322c3139333830313634352c31343034393835392c3131343830343532322c38343436363135382c363736383239302c33353934353230322c31363836393236352c323034383432372c313134303036392c37323730323135352c3131373931363636302c35323730373134382c3136353231323938352c31353131373936302c35363434373436342c3130353833333336392c39343439303633362c38333437393334342c34373936323638392c3230303035363937382c36363239383932352c36353530383733302c32393232323236382c3832363536312c33353039363733342c313133353535372c35343635303630342c34333439333638352c39383035343233352c363837393436372c32393135323035322c33373931353232342c36313039373436382c33363335393437342c33313839363634352c32353231383733312c31343139343035362c36343230393034372c36303932353238382c35333937353530322c38303636353635392c32343935373832312c393830373839362c32323333383536342c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a3739616631656564346164613932633633313237363263383634383537373966222c226d6574686f643a3830383333306231373334336538343031303534316465663166326162363835222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936225d2c22746f6b656e436f756e74223a3134307d"
  - node: "method:808330b17343e84010541def1f2ab685"
    fingerprint: "mh:64:7b226d696e68617368223a5b34393639333836342c313037323836332c35333638373230322c38353731373332302c31323833313539342c33303235383631342c34343535333035312c343137323934392c31323732353739302c35313039363337352c333631343330342c363734383038362c36303336323334302c32343837333139332c31393336353234342c31383133353038362c38333533323639382c34363433333738352c363637343437312c34353138303431312c34323039323131322c31353830313837312c363431383635332c343238363238372c31363232383835372c32353530313530392c323034383432372c33383434393737322c31383536383933332c33383738363536332c373838333833362c31333537373834382c32373733383333372c37303634383735302c34333235323031372c313934333631382c31383433383939352c353638393334352c35313731343136382c3133393736383033392c323430393433382c3130343135323531302c34313533393636302c33303737363834342c32353134353335302c33373830343637332c34343433333932362c35393035323332332c32343634303634332c39323830333639382c33373931353232342c35333536323533322c36393033363636322c37343438393630392c313432303235342c31353033333735322c3130393534343635352c33393334303630372c31333530373433322c33303933383534342c3130323539343134302c393134333130362c32323333383536342c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a3634383836306237396561306537363537383135376663333039616334353862222c2266756e6374696f6e3a6239636235383230383237353561396566333064383330656633343762323835222c226d6574686f643a3034316665333138306433633633666464663631353563376433313032376664222c226d6574686f643a3630323263363237336333303538366337316631653633656362326139653362222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936225d2c22746f6b656e436f756e74223a3136327d"
  - node: "method:5d7d7e0773221f4be5d214810e57269d"
    fingerprint: "mh:64:7b226d696e68617368223a5b32393538343533312c32313036363539332c37323036373631342c333437383039392c31363438363832342c33303133353032342c34313735343830312c31363137323133332c31303732373536352c32353530383838352c31373931303839362c35383132383035332c3132313139383432332c32343837333139332c31363131323538342c39373733353238392c3132393438323036312c33303130323934322c36383330383239392c33363837333032362c3132313731353230312c36313432383531352c31303338313436342c39303930393132392c33353934353230322c33353630303631322c323034383432372c393938373439322c37303237313637332c36323538383930332c36363032303931382c32383136363532372c31333839393137312c37303634383735302c31343237343234332c313934333631382c313432323733382c34373835313530342c35333436343834372c373030313734352c343031343031302c3130383733313131342c393738333334312c34393132363637342c32333330343039302c39333838383936352c3230393730343732322c35313139333435372c31373538303632312c33383536373838342c3132333935323235362c39343839383930362c32383432313835312c32313331353230302c31393031393135362c31353033333735322c32323735333834372c36323233303033322c3131313230343736322c34303633323130372c31303230303337322c33313832383534362c32333032383630312c32353530343830325d2c226e65696768626f7273223a5b2266756e6374696f6e3a3634383836306237396561306537363537383135376663333039616334353862222c226d6574686f643a3131663536306261393531383639616331363639383533356263303238623431222c226d6574686f643a3464323039616238653530343436353435353163336166343838393732326137222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936225d2c22746f6b656e436f756e74223a3135367d"
  - node: "method:5a3c988262fd301c5af569624c954ce6"
    fingerprint: "mh:64:7b226d696e68617368223a5b37353838353835312c32313036363539332c33323736303233312c31373431363930342c33333437303234392c33313235313232372c34313437333639392c343137323934392c31303732373536352c32353530383838352c373634373836332c363734383038362c313832373633392c32343837333139332c31363131323538342c35313139373838332c34323138313935332c33303130323934322c38373032323639322c38303934333634362c31393339373834312c32313038383935302c31303338313436342c32383332313438382c33353934353230322c3135303135313137312c323034383432372c32333239363630332c31343332303431322c31373935353234322c36363032303931382c31333537373834382c37313439343234302c37303634383735302c31343237343234332c313934333631382c323232363838322c31333730383630332c32343839343034332c373030313734352c38373634333437372c33353832353131302c3832363536312c34393132363637342c353630353534392c32353237313537392c38373431363535382c35313139333435372c33323433343238312c32323934333537332c32313432353833352c32333736373130352c33373233303131322c35343535343034372c31343731313631312c31353033333735322c3232343639373636352c36353432343036302c31333235333739312c31303831393534332c32363235333133302c33313832383534362c32333032383630312c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a3634383836306237396561306537363537383135376663333039616334353862222c226d6574686f643a3066643433643336306263323762363066613735373937306465346436373362222c226d6574686f643a3131663536306261393531383639616331363639383533356263303238623431222c226d6574686f643a3464323039616238653530343436353435353163336166343838393732326137222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936225d2c22746f6b656e436f756e74223a3233397d"
  - node: "method:4bf356fe515ec5c34c41b9949c14d1b7"
    fingerprint: "mh:64:7b226d696e68617368223a5b38323335383239362c31373331333535382c35303732333734382c34363734323436342c34373830363431312c35343034383637302c3135313431343531372c343137323934392c36313539343433332c35303332323230372c37363135313431302c31363031383335382c36303336323334302c32343837333139332c36373138363934312c3130393434393032372c3135363939333132302c33303130323934322c393230383837362c3132373139343932322c35323331333632372c33363231303432362c31303338313436342c31393238343430312c34373338303537342c34323533363137332c3132303732313034342c3139373139333339322c31383536383933332c3134393937313532362c33363436383430372c33313732343036362c34373938353437312c33323433363235352c3131333434323831332c313934333631382c34313836363337352c3235353139333336312c32343839343034332c383431393834362c34313839393036372c35383538323031332c31333332303938352c31303137373432342c39373531363434342c33373830343637332c35363937363538362c35313139333435372c35333833313035372c31393135323535342c37363534343731382c3130383534353235312c363633363733392c3230383337353737342c32313334363639322c31353033333735322c36353736353130392c31333034303838372c31383032383334372c39373737343533382c3131383733353536302c393134333130362c373435303735342c31313732363932355d2c226e65696768626f7273223a5b226d6574686f643a3864393137366238383433653439613233343266633034613363633732653639225d2c22746f6b656e436f756e74223a3139377d"
last_updated: 2026-08-10
---

# AI Providers

`AiProviderService` is the only code in the repo that calls a model. Everything else asks it
for a completion and gets back an `LlmResponse` or an exception — or, when the active
provider is TypeSafe, for a typed judgment via `judge()` (see below).

## The three layers of one call

[`complete()`](mex://method:d15fc631a3e5febb0e19d93ab4021f96) composes them in a fixed order, and
the order is the design:

```
complete(request)
  1. getActiveConfig()         → active AiProviderConfig row (one DB read, no network);
                                 typesafe → AiProviderConfigError, breaker untouched
  2. getProviderInstance()     → cached adapter (or MockLlmProvider when none is active)
  3. breaker.canAttempt()      → across processes; throws BreakerOpenError without any network call
  4. rateLimiter.execute(fn)   → within this process; spacing + transient-only retry
  5. provider.complete(fn)     → one fetch() to the vendor
  → success: breaker.recordSuccess()   → failure: categorizeError() then breaker.recordFailure()
```

The breaker is consulted before any **network** call; an open breaker costs one DB read plus a
single file read. (It used to be checked before the config lookup; the config is now validated
first so a wiring error never consumes a half-open probe.) The rate limiter sits **inside** the
breaker, not outside it — in-run retries never re-check the breaker.

Step 1 and the success/failure bookkeeping live in a private generic `guarded<T>(providerType, fn)`
helper; `complete()` and `judge()` are thin wrappers around it that do steps 1–2 first. With no
active config `complete()` still uses the mock provider behind the breaker (an open breaker still
throws `BreakerOpenError`); `judge()` with no or a non-typesafe config throws
`AiProviderConfigError`.

`InvalidProviderResponseError` carries a `kind`. `unparseable` (the 2xx body is not JSON — wrong
`apiEndpoint` returning 200 HTML, a proxy) is systemic: an ordinary failure → `unknown` → short
hold. `invalid_shape` (JSON that fails the schema, or answers `interpret` can't map) can be
specific to one email — holding the breaker would stop every run at that email and starve the rest
— so, like a TypeSafe **422** (rethrown as `ProviderRequestRejectedError`; see the error taxonomy
below), it records a breaker **success** and is rethrown. Neither per-request case records success
when the call was the half-open probe of a **quota** breaker; the 30s probe guard just expires.

Consequence: a *systemic* 422 or invalid-shape problem (broken question set, API contract change)
never shows in `GET /ai-providers/breaker`. The signal is the classification error log
"… consecutive per-email failures … question set or API contract is probably broken" and a
non-zero `errors` (plus `skipped`) in the `POST /classification/run` response.

## Adapter contract

`BaseLlmProvider` is a one-method interface: `complete(request: LlmRequest): Promise<LlmResponse>`.
Each adapter is a hand-written `fetch` against the vendor's REST API — there are no vendor
SDKs. Every adapter must call `throwIfNotOk(response, "<provider>")` before reading the body;
that is what converts an HTTP failure into an `AiProviderError` carrying `status`,
`retryAfterMs`, and `resetAt` parsed from the rate-limit headers. An adapter that skips it
turns a 429 into a JSON parse error and defeats the entire backoff design.

[`createProviderInstance()`](mex://method:4bf356fe515ec5c34c41b9949c14d1b7) is a
`switch` over `config.provider` — the registration point for a new provider. Kimi and DeepSeek
supply a default `apiEndpoint` there; Google accepts none. An unknown provider string falls
back to `MockLlmProvider` with a warning rather than throwing. The one deliberate exception is
`typesafe`, which throws `AiProviderConfigError` from `complete()` — it cannot answer a
free-text prompt, and silently producing mock classifications would hide that.

## TypeSafe — a judgment API, not a completion

TypeSafe ("System One", model family Jev) takes structured `state` plus typed questions
(`choice` / `score` / `noul`) and returns typed answers with probabilities — no free text. So it
does **not** implement `BaseLlmProvider`. `TypeSafeClient.judge()` (`providers/typesafe.client.ts`)
is a hand-written `fetch` to `POST {baseURL}/v1/systemone` (default `https://api.typesafe.ai`,
overridable via the config's `apiEndpoint`) that calls `throwIfNotOk(response, "typesafe")`
before reading the body and Zod-validates the result with `TypeSafeResponseSchema` from
`@email-ai/shared`, returning `{ response, rawBody }` (the exact body text, for audit). No fetch
timeout, matching the other adapters.

`AiProviderService.judge(request)` requires the **active** config to be `typesafe`, caches one
client per config id in its own map (dropped on update/delete like `providerInstances`), and
runs through the same `guarded()` path, so 429 → rate limiter / breaker and 529 (overloaded,
a 5xx) → transient in-run retry behave exactly as for LLM providers. `judgeWith(request,
interpret)` additionally runs `interpret` inside the guard and rethrows its failure as
`InvalidProviderResponseError` (`invalid_shape`); classification uses it so an unmappable answer is
handled exactly like a schema-invalid body.

Activate with `POST /ai-providers { "provider": "typesafe", "apiKey": "…", "model": "jev-latest" }`
then `POST /ai-providers/:id/activate`; the create DTO validates `provider` against
`AiProviderTypeSchema`, which now includes `typesafe`. `temperature` / `maxTokens` are accepted
but unused.

`MockLlmProvider` returns keyword-based classifications with no network call, and is also what
`getProviderInstance()` returns when **no config row is active** — so an unconfigured system
produces plausible-looking classifications instead of erroring. Check
`GET /classification/stats` `byProvider` if results look suspiciously uniform.

## Error taxonomy

[`categorizeError()`](mex://function:b9cb582082755a9ef30d830ef347b285) maps an `AiProviderError` to one of
`transient` | `quota` | `auth` | `unknown`, and every backoff decision keys off that:

| Signal | Category | Effect |
|--------|----------|--------|
| 429 with `retryAfterMs` <= transient cap (60s default) | `transient` | retried in-run |
| 429 with a long hint or no hint | `quota` | breaker opens for the hint, or exponential backoff, capped at 12h |
| 408, any 5xx, network error | `transient` | retried in-run |
| 401, 403, **any other 4xx** | `auth` | breaker held for the full `AI_QUOTA_MAX_DELAY_MS` (12h) |
| anything else | `unknown` | short transient hold |

Note the sharp edge: a 400 from a malformed request is classified `auth`, so a bad prompt or
an invalid model name stops all AI work for twelve hours. When the breaker trips right after a
provider or prompt change, suspect this before suspecting quota.

TypeSafe **422** (request validation — this state or question set was rejected) is carved out:
`categorizeError` still calls it `auth`, so the rate limiter rethrows it at once, but `guarded()`
then records a breaker success and throws `ProviderRequestRejectedError` (status + truncated
body) instead of holding for twelve hours. One oversized email should not stall the pipeline;
`processUnclassified` counts it (and any `invalid_shape` response) as an error and moves on,
stopping only after three consecutive per-email failures (a bad question set or API contract). 401/403 and other providers' 4xx keep the `auth` behavior.

## Rate limiter — in-run, transient only

[`RateLimiter.execute()`](mex://method:808330b17343e84010541def1f2ab685) spaces requests to
`60000 / requestsPerMinute` ms and retries **only** `transient` failures, up to `maxRetries`,
preferring the provider's own `retryAfterMs` hint when it fits under `maxDelayMs` and falling
back to exponential backoff with jitter. Quota and auth errors are rethrown on first
occurrence so the breaker can open — retrying those in-run just burns more doomed calls.

Defaults come from the environment in the service constructor:
`AI_REQUESTS_PER_MINUTE` (20), `AI_MAX_RETRIES` (3), `AI_TRANSIENT_MAX_DELAY_MS` (60000).
That last value doubles as the 429 short-vs-quota threshold in `categorizeError`.

## Circuit breaker — cross-process, file-backed

State lives at `~/.local/state/email-ai/ai-breaker.json` (`AI_BREAKER_STATE_PATH`), because
launchd starts a fresh process every hour and an in-memory counter would reset each time.

- [`canAttempt()`](mex://method:5d7d7e0773221f4be5d214810e57269d) returns `allowed` immediately when
  closed. When the open window has elapsed it transitions to `half_open` and **persists a 30s
  probe guard before returning**, so exactly one probe fires even across a crash.
- [`recordFailure()`](mex://method:5a3c988262fd301c5af569624c954ce6) picks the open window by
  category: `auth` → the full max delay; `quota` → `resetAt`, else `retryAfterMs`, else
  exponential backoff, capped at max; anything else → backoff capped at the short transient hold.
- A missing or corrupt state file is treated as closed.

Inspect with `getBreakerStatus()` / clear with `resetBreaker()`, or just delete the state file.
`peek()` is side-effect free and safe for status checks; `canAttempt()` is not — it writes.

## Configuration lives in two places

Provider identity (type, API key, model, endpoint, temperature, `maxTokens`) is a row in the
`AiProviderConfig` table, managed over `/ai-providers` and activated with
`POST /ai-providers/:id/activate`. Behaviour knobs (`AI_REQUESTS_PER_MINUTE`, `AI_MAX_TOKENS`,
breaker timings) are environment variables read straight from `process.env` and **not** covered
by `envSchema`, so a typo in one of them silently takes the default.

API keys are stored in Postgres **in plaintext** — unlike IMAP credentials they do not go
through `crypto.util`. Any response that returns a config must go through
`AiProviderController.sanitizeConfig`, which allowlists fields and drops `apiKey` and
`apiEndpoint`.

Note also that `ClassificationService` reads `AI_MAX_TOKENS` itself rather than using the
`maxTokens` stored on the config row, so the database value is not what governs a
classification call.
