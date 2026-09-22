---
name: debug-pipeline-stall
description: Emails are not appearing in the review queue or digest. Walk the four stages back to front and find which boundary is holding them.
triggers:
  - "no emails"
  - "not classified"
  - "empty digest"
  - "empty queue"
  - "pipeline stuck"
  - "skipped"
  - "breaker open"
  - "fallback"
edges:
  - target: context/pipeline.md
    condition: always — the stage contracts and find-work queries live there
  - target: context/ai-providers.md
    condition: when the stall is at the classification stage
  - target: context/review-and-digest.md
    condition: when classification succeeded but the queue or digest is still empty
  - target: patterns/debug-imap-sync.md
    condition: when the stall is at stage 1 and no RawEmail rows are arriving
grounds_to:
  - node: "method:82aa62e49f39025ac1dff75ffd88c693"
    fingerprint: "mh:64:7b226d696e68617368223a5b31303137383634342c313037323836332c35333638373230322c333437383039392c31323833313539342c31323738343838362c34383730393537302c31323034313635312c31323732353739302c33303339393233352c31373931303839362c34313337323433312c383538303636352c32343837333139332c31393336353234342c35313139373838332c31373535303838312c34363433333738352c373231393032342c31383030393038302c34333935383833332c33363231303432362c313830393030342c33333936333732352c32383237383038372c31373038393935332c323034383432372c32333239363630332c33323036383836302c3130313933303030352c323633383732302c31333537373834382c31333839393137312c33323433363235352c32303139373232382c313934333631382c31393239333031372c32343335393730302c32343839343034332c383431393834362c343031343031302c37353939383437392c393738333334312c31303137373432342c353630353534392c383038393933302c31323638313633362c31323537313736372c373832383038302c32323934333537332c34353934333130312c35333337313736392c33373233303131322c31313931323733372c313432303235342c353632373638362c32323735333834372c3131353132343738382c333435383637392c35373734353633332c34303039373537382c393134333130362c383934343635322c31323237333938315d2c226e65696768626f7273223a5b226d6574686f643a3532343565663730623634386431616563383166663736313639636137643162222c226d6574686f643a6131656366393263353732346364333365363834623361323761623935343132222c226d6574686f643a6531303436326463633839336231306138633838316665386439643965366561225d2c22746f6b656e436f756e74223a3334377d"
  - node: "method:e10462dcc893b10a8c881fe8d9d9e6ea"
    fingerprint: "mh:64:7b226d696e68617368223a5b33333830393232392c323737393737382c31303837393738312c313733353730352c31323833313539342c373533343539302c34343535333035312c343137323934392c31303732373536352c35303332323230372c373634373836332c343937393136322c36303336323334302c32343837333139332c31333137393237352c35313139373838332c34323138313935332c353835303039302c393230383837362c34393330303139322c33383137363739372c31353830313837312c31333336353136342c363736383239302c343935373133332c33353630303631322c323034383432372c393938373439322c33323435303830362c35363236363639382c323633383732302c31333537373834382c32373733383333372c353938373530332c32303139373232382c313934333631382c31383433383939352c31323335313838362c35313731343136382c373030313734352c343031343031302c32313435373832362c34363737363635332c34323237323937362c353630353534392c343439393438302c38373330343132352c35313139333435372c373832383038302c37383738303537322c383838353332332c35333536323533322c33373738363738342c31313931323733372c31343731313631312c31353033333735322c32343133323430332c36323233303033322c31333235333739312c36363337313232302c31313733333131302c393134333130362c32323333383536342c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a6663336565656134646363396534393035333835653866363037363161376332222c226d6574686f643a3164316462326562366566633033646536366539316237323036623037333236222c226d6574686f643a3832616136326534396633393032356163316466663735666664383863363933222c226d6574686f643a6231363534303239636464653138393634613864636135323133353639646639222c226d6574686f643a6361643836336438306664633361653339623762616430353030653161363138222c226d6574686f643a6362626363653964346337326439663735643637326135343864373463663130222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936222c226d6574686f643a6438623638313866386562383739396237383536303933396330623363663363222c226d6574686f643a6564353931643862323366343135393061656234366235636532646531383537225d2c22746f6b656e436f756e74223a3431357d"
last_updated: 2026-08-10
---

# Debug a Pipeline Stall

## Context

Load `context/pipeline.md`. Stages are chained only by data, so a stall is always "table N has
rows, table N+1 does not". Each stage is safe to invoke by hand, so the fastest diagnosis is to
run them one at a time and read the count objects.

## Steps

1. **Confirm the stack is up.** `curl localhost:3000/health` must return
   `{"status":"ok","db":"ok",...}`. Under launchd, also check
   `~/.local/state/email-ai/api.log`.
2. **Walk the stages forward, reading each count.** Every one of these is idempotent:
   ```sh
   curl -X POST "localhost:3000/email-sync/run-all?dryRun=false"
   curl -X POST "localhost:3000/email-parser/run"        # {processed, errors}
   curl -X POST "localhost:3000/normalization/run"       # {processed, errors}
   curl -X POST "localhost:3000/classification/run?all=true"  # {processed, errors, needsReview, skipped}
   ```
   The first stage whose `processed` is 0 while the previous one produced rows is the stall.
3. **If the stall is at classification, read `skipped` first.**
   [`processUnclassified()`](mex://method:82aa62e49f39025ac1dff75ffd88c693) checks the
   circuit breaker before the loop and returns `{processed: 0, skipped: n}` without attempting
   anything. That is a breaker event, not a failure. Confirm with the API log line naming
   `nextAllowedAttempt`, or read `~/.local/state/email-ai/ai-breaker.json`.
4. **Check what is actually classifying:** `curl localhost:3000/classification/stats`.
   `byProvider` showing `mock` means no active provider config; showing `fallback` means the
   model replied but the reply failed Zod validation.
5. **If classifications exist but the queue is empty**, remember the queue only shows items with
   `reviewDecision: null` and either `needsReview: true` or confidence at/below the threshold.
   A confident, already-decided classification correctly does not appear.
6. **If the queue has items but the digest is empty**, the digest window is keyed on the email's
   **received** date (`rawEmail.internalDate`), not the classification date. Ask for the right
   day: `curl "localhost:3000/digest?date=YYYY-MM-DD"`.

## Gotchas

- **`POST /classification/run` defaults to today's mail only.** Older normalized emails are
  invisible to it. Use `?since=YYYY-MM-DD` or `?all=true` when investigating.
  `scripts/daily-digest.sh` passes `?since=<yesterday>` for exactly this reason.
- **A dry-run sync looks like a successful sync.** `fetchedCount` is non-zero and
  `storedCount` is 0. `dryRun` is on unless the query string is literally `dryRun=false`.
- **An open breaker persists across restarts** — it is a file, not process memory. Restarting
  the API changes nothing. Delete the state file or call `resetBreaker()`.
- **A 400 from the provider opens the breaker as `auth` for 12 hours.** If the breaker tripped
  right after a prompt, model, or endpoint change, that is the likely cause, not quota.
- **Errors are swallowed per record by design.** A batch reporting `{processed: 40, errors: 5}`
  means five records failed and were logged — read the API log, they are not in the response.
- **A propagated provider failure leaves no row**, which is intentional: the email is retried
  next run. Only unparseable *responses* are written as `fallback` rows. So an outage looks like
  "nothing happened", not like a pile of bad classifications.
- `POST /normalization/reprocess` re-runs the normalizer and rules engine over already-normalized
  emails in place. It does **not** invalidate existing classifications, so it will not cause a
  re-classification.

## Verify

- [ ] Each stage endpoint returns a non-zero `processed` (or a legitimate zero because there is
      genuinely nothing pending).
- [ ] `GET /classification/stats` shows a real provider name under `byProvider`.
- [ ] `~/.local/state/email-ai/ai-breaker.json` reports `status: "closed"` (or the file is absent).
- [ ] `GET /review-queue` returns items, and `GET /digest?date=<the right day>` has non-zero counts.

## Debug

Boundary-by-boundary, what to look at when a stage produces nothing:

| Stage | Nothing produced means |
|-------|------------------------|
| Sync | dry run, `needsReauth`, inactive account, or the `lastSyncedUid` watermark is already at the top — see `patterns/debug-imap-sync.md` |
| Parse | no `RawEmail` with `parsed: null`; if `errors` is high, `simpleParser` is choking — check the log |
| Normalize | no `ParsedEmail` with `normalized: null` |
| Classify | breaker open (`skipped`), or the default today-only cutoff excluded the mail |
| Queue | items exist but all are confident and already decided |
| Digest | wrong date, or grouping put everything in a bucket you were not reading |

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
