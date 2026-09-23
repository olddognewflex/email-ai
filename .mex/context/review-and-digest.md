---
name: review-and-digest
description: The human loop — review queue selection, approve/reject/recategorize decisions, the three front ends, digest grouping and Obsidian export, and the launchd automation that drives it. Load when working past classification.
triggers:
  - "review queue"
  - "approve"
  - "reject"
  - "recategorize"
  - "digest"
  - "obsidian"
  - "tui"
  - "launchd"
  - "daily-digest"
edges:
  - target: context/pipeline.md
    condition: when tracing back to how a classification was produced
  - target: context/architecture.md
    condition: when placing the review and digest surfaces in the wider system
  - target: context/setup.md
    condition: when running the pipeline or the TUI locally
  - target: patterns/debug-pipeline-stall.md
    condition: when the digest or queue is empty and the cause is upstream
grounds_to:
  - node: "method:6362abbd926799663c9557bc578f1450"
    fingerprint: "mh:64:7b226d696e68617368223a5b32393538343533312c323737393737382c37323036373631342c333437383039392c31323833313539342c373533343539302c38383932353238392c343137323934392c31303732373536352c36383839353732322c33353836333839392c3232343333303335322c36303336323334302c32343837333139332c31333137393237352c32383539313638322c34323138313935332c33303130323934322c393230383837362c34393330303139322c35323736373931302c31353830313837312c35323038383939342c32313833393533372c343935373133332c34323533363137332c323034383432372c32333239363630332c33323435303830362c3130313933303030352c31313339323038332c33313732343036362c32373733383333372c35323236383432392c34333235323031372c313934333631382c31393239333031372c3132313738313635372c37343137343530332c373030313734352c343031343031302c34383535313237302c34363737363635332c37333530373734342c353630353534392c383038393933302c38373330343132352c35313139333435372c34303434373932392c37383738303537322c34353934333130312c3130383534353235312c33373738363738342c31313931323733372c32383433303136362c31353033333735322c35383232363436322c3131353132343738382c31333235333739312c38393032353935302c3130323539343134302c393134333130362c32323333383536342c33303335353938375d2c226e65696768626f7273223a5b226d6574686f643a3339346631663637373763336138653330363832653637636430653364353539222c226d6574686f643a6136363562666635353462326264656363323265366231333039626638636562225d2c22746f6b656e436f756e74223a3138327d"
  - node: "method:f59e9a88f0099b423c133a50ae9c2334"
    fingerprint: "mh:64:7b226d696e68617368223a5b32393538343533312c323737393737382c36373433363836362c333437383039392c31323833313539342c373533343539302c38383932353238392c343137323934392c31303732373536352c36383839353732322c33353836333839392c3131323331303031302c36303336323334302c32313034343836352c31333137393237352c32383539313638322c34323138313935332c33303130323934322c393230383837362c34393330303139322c35323736373931302c31353830313837312c35323038383939342c32313833393533372c343935373133332c34323533363137332c323034383432372c32333239363630332c33323435303830362c3130313933303030352c31313339323038332c33313732343036362c32373733383333372c35323236383432392c34333235323031372c313934333631382c31393239333031372c3132313738313635372c37343137343530332c373030313734352c343031343031302c34313738343932362c34363737363635332c37333530373734342c353630353534392c383038393933302c38373330343132352c35313139333435372c34303434373932392c37383738303537322c34353934333130312c3130383534353235312c33373738363738342c31313931323733372c32373139323736362c31353033333735322c35383232363436322c3131353132343738382c31333235333739312c36363337313232302c3130323539343134302c393134333130362c32323333383536342c33303335353938375d2c226e65696768626f7273223a5b226d6574686f643a3061363637643136643635313230313766363736316532323433366430616135222c226d6574686f643a6333356331356331373738366562303538303537333331393762383064663565225d2c22746f6b656e436f756e74223a3231307d"
  - node: "method:81490ad636cc525ae5c613ae0226b2d8"
    fingerprint: "mh:64:7b226d696e68617368223a5b38303530373238352c3137303333313539362c37333137333233312c32353136363235312c32323234353431302c35303737343134352c34343535333035312c333032303636332c35303932373039332c32353530383838352c31373931303839362c3237353136383539372c3137383035373838322c3132323137353830362c3130393937383739372c3136383635372c333935373632332c343931373939362c363637343437312c37303639303733342c31343335393735372c38393934353737312c38323438323039332c363736383239302c3234323134352c31363836393236352c31333837343037362c32393137303230332c38383038363032362c3130313933303030352c323633383732302c3135333935333439382c32393438303633372c34333037333938362c38363130303934392c31333537313331322c31383433383939352c34373936323638392c3132323033373336302c36363239383932352c3232383532363536332c3132333431363239322c3131363131383537302c39343334303633382c36363438323832322c39333838383936352c34333935303832352c3132313339353330332c323235303637312c3132373732313836362c31353130383138322c36353938363536382c3135363932313031372c33313839363634352c37343937393130382c32323836303935362c38333632333831372c3130313830323732342c31373434373134362c35343633353138322c36343935353138392c33313832383534362c3136343531393238312c34333836363238385d2c226e65696768626f7273223a5b226d6574686f643a3539373532393031623363306534373738343736636537643534643662616237225d2c22746f6b656e436f756e74223a3230377d"
  - node: "method:c3552f9e32c80185c621423a751bd44e"
    fingerprint: "mh:64:7b226d696e68617368223a5b35383730353130342c32313036363539332c37323036373631342c313733353730352c31323833313539342c35343034383637302c34343535333035312c31333530393139342c31323732353739302c31313130393635372c36353635333233362c363734383038362c36303336323334302c32343837333139332c31363131323538342c38323938313936372c34323138313935332c33303130323934322c3635333636352c3232363733362c33303733313930342c31353830313837312c31303338313436342c34383139353833382c34373338303537342c34323533363137332c31353234393032372c313134303036392c31343332303431322c363332363430302c323633383732302c33313732343036362c32373733383333372c33323433363235352c31343237343234332c313934333631382c323232363838322c333336353038332c37343137343530332c383431393834362c34323339333634342c32393232323236382c34363737363635332c37333530373734342c353630353534392c32383934373634372c38373330343132352c35313139333435372c373832383038302c32323934333537332c32313432353833352c35333536323533322c33383036353439382c3133303631333433392c32313334363639322c31353033333735322c38323234363333392c313130363330332c31333235333739312c31303831393534332c32363235333133302c393134333130362c35383633343432362c31313732363932355d2c226e65696768626f7273223a5b226d6574686f643a3234336133363463306135663261646364623862633461303237316266343339222c226d6574686f643a3539373532393031623363306534373738343736636537643534643662616237222c226d6574686f643a3736626436323733616234326130383563393461646335633738326631373938222c226d6574686f643a6363326138366134383161656164313731653162613738333230616135343363225d2c22746f6b656e436f756e74223a3433367d"
last_updated: 2026-08-10
---

# Review and Digest

Classification is a recommendation, never an action. Everything downstream of it is about
getting a human to confirm or correct that recommendation, and about summarising the day.

## What lands in the review queue

`getReviewQueue()` selects classifications where `needsReview: true` **OR** confidence falls at
or below a threshold (default `"medium"`, so `low` and `medium` qualify), and always requires
`reviewDecision: null`. A decision — approve *or* reject — is therefore what removes an item
from the queue; there is no separate "reviewed" flag.

`getActionableQueue()` is a different cut over the same data: emails worth acting on rather
than emails whose classification is doubtful. Both share `runQueue()`, which paginates,
orders by `createdAt desc`, and flattens the four-level Prisma include
(`classification → normalizedEmail → parsedEmail → rawEmail → account`) into the
`{ classification, email }` item shape the TUI and the HTML UI both consume. The account
`label` is surfaced there so a multi-account user can tell mailboxes apart.

Both lists are also limited by a **received-date window** so old mail stays out of them.
`runQueue()` ANDs `normalizedEmail.parsedEmail.rawEmail.internalDate >= since` onto the view's
own filter. It narrows the needsReview/confidence and actionable filters and never replaces
them. The default is the last `DEFAULT_REVIEW_WINDOW_DAYS` (14) days, counted from local
midnight. `resolveReviewWindow()` in `review-window.ts` reads the `?days=N`,
`?since=YYYY-MM-DD` (local midnight, same parsing as the digest's `?date`) and `?all=true`
query params, in that order of precedence: all, then since, then days, then the default.
Invalid values return 400. The JSON responses include `window: { since, days }`. The HTML
pages say "Showing mail received since …" with a show-all link. The TUI shows the window
label in its header, and its `w` key switches between the default window and all mail. The
JSON detail and decision endpoints are not windowed. The HTML UI carries a non-default window
(`all`/`since`/`days`) through row links, the detail page's back, approve, reject and image
links, and the approve/reject-and-next redirects. `getNextPendingId(window)` takes the active
window, so "next" stays inside the window the user is working.

## Decisions

[`approveClassification()`](mex://method:6362abbd926799663c9557bc578f1450) and
[`rejectClassification()`](mex://method:f59e9a88f0099b423c133a50ae9c2334) both create a
`ReviewDecision` row keyed one-to-one on the classification. Reject optionally carries a
`correctedCategory`, which is the corpus of human-labelled corrections.

Both **delete an existing decision and create a new one** rather than updating, logging a
warning when they do. Two consequences: the decision id changes when a reviewer changes their
mind, and `decidedAt` reflects the latest decision only — the earlier one is gone, so this
table is not a full audit trail of reviewer changes.

Neither method touches the classification row itself. A rejected classification keeps its
original `category`; the correction lives only on the decision. Any consumer that wants "the
final category" has to prefer `reviewDecision.correctedCategory` over
`classification.category` for itself.

## Three front ends, one API

- **`/review-queue` JSON** — the API surface all of the below use.
- **`ReviewController`** — server-rendered HTML pages (`queuePage`, `detailPage`,
  `approveAndNext`, `rejectAndNext`) that build markup with template strings and hand-rolled
  `esc()` / `escAttr()` helpers. There is no template engine and no client framework. Email
  bodies are rendered into a sandboxed iframe `srcdoc`. Any new markup here must escape
  through those helpers — email content is attacker-controlled.
- **`apps/tui`** — an Ink/React keyboard TUI launched by the `eai` shim, which defaults to
  `PORT=3100` to match the launchd deployment while the app's own default is 3000.

Approve/reject links embedded in the digest markdown hit the GET-based `*ViaLink` endpoints so
they work from a plain Obsidian note; `DIGEST_LINK_BASE_URL` sets their host.

## Digest

[`generateDigest()`](mex://method:c3552f9e32c80185c621423a751bd44e) selects classifications by the
email's **received** date (`rawEmail.internalDate` between local start and end of day), not by
when it was classified. That is deliberate: the hourly job may classify yesterday's mail this
morning, and it should still appear in yesterday's digest. `parseLocalDate` in the controller
parses `?date=YYYY-MM-DD` in local time so a UTC-parsed date cannot shift the window by a day.

[`determineActionabilityGroup()`](mex://method:81490ad636cc525ae5c613ae0226b2d8) sorts
each email into one of three buckets, checked in order:

1. **actionable** — `needs_attention`; or `personal` with high/critical importance; or a
   `reply_needed` / `read_now` action; or immediate/today urgency at high importance.
2. **lowValue** — `archive`, `delete`, `marketing`, `social`, or `unknown`; or low importance
   with a `no_action` / `mark_read` / `delete` action.
3. **fyi** — everything else.

The order matters: the actionable test wins ties, so a `personal` critical email is never
demoted. Adding a category to `EmailCategorySchema` without adding it here silently lands it in
**fyi**, which is why `marketing` had to be added to the lowValue branch when that category was
introduced.

`generateAndSaveDigest()` writes `email-digest-<digest.date>.md` into the requested
`outputPath`, creating the directory if needed. The filename derives from the digest's own
date, so regenerating a day overwrites the same file — safe to re-run.

## Scheduled operation

`scripts/daily-digest.sh` is the real orchestrator and the best executable description of the
whole system. Three launchd jobs drive it:

- `com.odnf.email-ai.api` — always-on API, `KeepAlive` with a 30s `ThrottleInterval` so it
  retries while Docker/Postgres come up.
- `com.odnf.email-ai.hourly-sync` — the `sync` stage every hour on the hour.
- `com.odnf.email-ai.daily-digest` — the `digest` stage at 07:30.

The script waits for `/health` to report `status: ok` and `db: ok` before doing anything,
classifies with `?since=<yesterday>` to catch overnight mail the default cutoff would drop,
regenerates **both** yesterday's and today's digest each run, and pipes actionable emails into
the `qi` CLI — deduplicated by classification id in
`~/.local/state/email-ai/captured-ids.txt`. Delete a line from that file to allow a re-capture.

All three plists hardcode absolute `/Users/raymonddoran/...` paths and macOS-only `date -v-1d`
arithmetic, and logs go to `~/.local/state/email-ai/*.log`. This deployment is not portable as
written.
