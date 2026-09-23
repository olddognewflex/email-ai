---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
  - target: context/ai-providers.md
    condition: when the decision is about LLM calls, backoff, or the circuit breaker
  - target: context/pipeline.md
    condition: when the decision is about how a pipeline stage finds and writes work
grounds_to:
  - node: "method:5a3c988262fd301c5af569624c954ce6"
    fingerprint: "mh:64:7b226d696e68617368223a5b37353838353835312c32313036363539332c33323736303233312c31373431363930342c33333437303234392c33313235313232372c34313437333639392c343137323934392c31303732373536352c32353530383838352c373634373836332c363734383038362c313832373633392c32343837333139332c31363131323538342c35313139373838332c34323138313935332c33303130323934322c38373032323639322c38303934333634362c31393339373834312c32313038383935302c31303338313436342c32383332313438382c33353934353230322c3135303135313137312c323034383432372c32333239363630332c31343332303431322c31373935353234322c36363032303931382c31333537373834382c37313439343234302c37303634383735302c31343237343234332c313934333631382c323232363838322c31333730383630332c32343839343034332c373030313734352c38373634333437372c33353832353131302c3832363536312c34393132363637342c353630353534392c32353237313537392c38373431363535382c35313139333435372c33323433343238312c32323934333537332c32313432353833352c32333736373130352c33373233303131322c35343535343034372c31343731313631312c31353033333735322c3232343639373636352c36353432343036302c31333235333739312c31303831393534332c32363235333133302c33313832383534362c32333032383630312c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a3634383836306237396561306537363537383135376663333039616334353862222c226d6574686f643a3066643433643336306263323762363066613735373937306465346436373362222c226d6574686f643a3131663536306261393531383639616331363639383533356263303238623431222c226d6574686f643a3464323039616238653530343436353435353163336166343838393732326137222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936225d2c22746f6b656e436f756e74223a3233397d"
  - node: "method:e10462dcc893b10a8c881fe8d9d9e6ea"
    fingerprint: "mh:64:7b226d696e68617368223a5b33333830393232392c323737393737382c31303837393738312c313733353730352c31323833313539342c373533343539302c34343535333035312c343137323934392c31303732373536352c35303332323230372c373634373836332c343937393136322c36303336323334302c32343837333139332c31333137393237352c35313139373838332c34323138313935332c353835303039302c393230383837362c34393330303139322c33383137363739372c31353830313837312c31333336353136342c363736383239302c343935373133332c33353630303631322c323034383432372c393938373439322c33323435303830362c35363236363639382c323633383732302c31333537373834382c32373733383333372c353938373530332c32303139373232382c313934333631382c31383433383939352c31323335313838362c35313731343136382c373030313734352c343031343031302c32313435373832362c34363737363635332c34323237323937362c353630353534392c343439393438302c38373330343132352c35313139333435372c373832383038302c37383738303537322c383838353332332c35333536323533322c33373738363738342c31313931323733372c31343731313631312c31353033333735322c32343133323430332c36323233303033322c31333235333739312c36363337313232302c31313733333131302c393134333130362c32323333383536342c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a6663336565656134646363396534393035333835653866363037363161376332222c226d6574686f643a3164316462326562366566633033646536366539316237323036623037333236222c226d6574686f643a3832616136326534396633393032356163316466663735666664383863363933222c226d6574686f643a6231363534303239636464653138393634613864636135323133353639646639222c226d6574686f643a6361643836336438306664633361653339623762616430353030653161363138222c226d6574686f643a6362626363653964346337326439663735643637326135343864373463663130222c226d6574686f643a6431356663363331613365356665626230653139643933616234303231663936222c226d6574686f643a6438623638313866386562383739396237383536303933396330623363663363222c226d6574686f643a6564353931643862323366343135393061656234366235636532646531383537225d2c22746f6b656e436f756e74223a3431357d"
last_updated: 2026-09-23
---

# Decisions

## Decision Log

### Allow exactly one mailbox write: an audited, reversible MOVE to \Trash
**Date:** 2026-09-23
**Status:** Active
**Decision:** `trash` sender rules may move INBOX mail to the server-advertised `\Trash`
folder. All of it goes through `MailboxWriterService` (`modules/mailbox-actions/`), which
checks, in order: the `MAILBOX_WRITES_ENABLED` kill switch (exactly `"true"`, read at boot);
the account is active and not `needsReauth`; UIDs are positive integers; the server has the
`MOVE` capability; exactly one `\Trash` folder whose special-use came from the server
(`specialUseSource: "extension"`, not a name match). It then locks INBOX and re-checks each
message's UIDVALIDITY and Message-ID. It writes `pending` `MailboxAction` rows, issues
`UID MOVE` in chunks of 50 on one connection, and records `succeeded` / `failed` with the
destination UID. Undo moves the message back to INBOX after an atomic
`updateMany({status: succeeded})` claim, and re-points the `RawEmail` at the restored UID.
`POST /sender-rules/apply` is a DB-only dry run unless `dryRun=false`. `dryRun=false`
with the kill switch off is a 403, never a silent downgrade. Dry runs write no rows.
**Reasoning:** About 75% of the mail comes from bulk senders that rotate look-alike domains,
so classifying without moving leaves the INBOX unusable. Trash (not delete) keeps every move
recoverable: Gmail keeps Trash for 30 days, and undo restores it. imapflow 1.2.18 silently
emulates `messageMove` with copy + `\Deleted` + expunge when the server lacks `MOVE`, so
the capability check is what keeps the path free of permanent deletion.
**Alternatives considered:** Flag `\Deleted` and expunge (rejected — permanent, not
undoable); an advisory lock per account instead of the partial index
(not needed: Prisma leaves the index alone, and the index also survives a
crash); move to a named "Trash" folder (rejected — the name differs by provider and
locale, and a wrong guess moves mail somewhere unexpected); rows for dry runs (rejected —
the user chose report-only); re-applying Gmail labels on undo (rejected — restore to INBOX
only; labels are recorded but not re-applied).
**Consequences:** The kill switch needs an API restart to change.
- **Audit trail.** `MailboxAction.accountId` is `ON DELETE RESTRICT`, so an
  account with write history cannot be deleted. `DELETE /email-accounts/:id`
  returns 409.
- **One active move per message.** The database enforces it with two
  hand-written partial unique indexes in migration
  `20260923162327_mailbox_action_unknown_restrict_one_active`. They cover
  `(accountId, sourceUidValidity, sourceUid)` and `(rawEmailId)`, where
  `action = 'move_to_trash' AND status NOT IN ('failed','skipped','undone')`.
  So the dev and launchd APIs can never both move one message; a P2002 on
  insert is recorded as `already_in_progress`. Prisma 6.19 does not drop
  these indexes: `migrate diff` against a deployed throwaway database is
  empty, while a hand-added plain index is dropped. Re-check after any
  Prisma upgrade.
- **`unknown` outcomes.** A lost MOVE response whose follow-up presence check
  also fails is recorded as `unknown`, never retried.
  `POST /mailbox-actions/reconcile` resolves `pending`/`unknown` rows by
  Message-ID lookup in INBOX and Trash. It is read-only on IMAP.
- **Winning rule only.** Apply acts only when the sender's winning rule
  (classification precedence) is a `trash` rule. It skips mail the user
  rejected or recategorized in review.
- **Never re-trash.** A Message-ID that was trashed before (succeeded or
  undone) is never trashed again (`previously_trashed`). That covers mail
  dragged back by hand.
- **Network exposure.**
  - The API binds to 127.0.0.1 (`EMAIL_AI_HOST` overrides it, with a WARN
    if the address is not loopback).
  - A Host-header middleware in `main.ts` rejects anything but
    `127.0.0.1:<PORT>`/`localhost:<PORT>` (DNS rebinding).
  - A global `APP_GUARD` requires `X-Email-AI-Client` on every
    non-GET/HEAD/OPTIONS request (CSRF).
  - Known residual: the GET approve/reject links of the HTML review UI.
- **Reconcile** checks the exact stored UID first (definitive under an
  unchanged UIDVALIDITY), and falls back to Message-ID only when that is
  impossible. It leaves the row unresolved if the Message-ID is in both
  folders or more than once in one.
- **Static guard.** `no-destructive-imap.guard.spec.ts` scans every
  `apps/<name>/src` and `packages/<name>/src` `.ts`/`.tsx` file. It fails
  on `messageDelete`, `messageFlagsAdd`, `messageFlagsSet`,
  `messageFlagsRemove`, `messageCopy`, `mailboxDelete`, `mailboxRename`,
  `\Deleted`, `expunge(`, `append(`, a quoted `EXPUNGE`/`STORE` command,
  or `run('MOVE'|'COPY'|'DELETE'|'RENAME'|'EXPUNGE'|'STORE'…`. It also fails
  if anything but the writer reaches `messageMove` (including bracket
  access), or if the reconcile service or `imap-lookup.ts` mentions
  `messageMove` or the writer.

### Persist the AI circuit breaker to disk instead of memory
**Date:** 2026-07-17
**Status:** Active
**Decision:** `CircuitBreaker` reads and writes its state as JSON at
`~/.local/state/email-ai/ai-breaker.json` (override with `AI_BREAKER_STATE_PATH`), and
[`recordFailure()`](mex://method:5a3c988262fd301c5af569624c954ce6) chooses the open window by
error category: `auth` holds for the full `AI_QUOTA_MAX_DELAY_MS` (12h default), `quota`
honours the provider's `resetAt`/`Retry-After` hint or exponential backoff, and anything
transient gets a short `AI_TRANSIENT_HOLD_MS` hold.
**Reasoning:** The pipeline is launched by launchd, which starts a **fresh process every
hour**. An in-memory failure counter resets to zero on every wake, so a spent daily quota
would be re-discovered by firing one doomed request per email, every hour, all day.
**Alternatives considered:** In-memory breaker (rejected — resets each launchd wake);
storing breaker state in Postgres (rejected — the breaker must be consultable before, and
independently of, database health).
**Consequences:** Breaker state survives restarts and is shared by every process pointing
at the same state file. Tests must inject `statePath`/`now` rather than relying on process
lifetime. A stuck breaker is cleared by deleting that file or calling `resetBreaker()`.

### Fall back to a placeholder classification only for unparseable replies
**Date:** 2026-07-17
**Status:** Active
**Decision:** In [`classifyEmail()`](mex://method:e10462dcc893b10a8c881fe8d9d9e6ea) a
provider error, breaker-open, or rate-limit failure **propagates** and leaves the email
unclassified. Only a response that arrived but failed `JSON.parse` or Zod validation is
written as the `unknown` / `needsReview: true` fallback row with `providerUsed: "fallback"`.
**Reasoning:** `EmailClassification` rows are the pipeline's "done" marker — the batch query
selects `classification: null`. Writing a fallback row for a transport failure permanently
marks the email as processed and it is never retried.
**Alternatives considered:** Fallback on every failure (rejected — silently poisons the
corpus with `unknown` and hides outages); a separate retry table (rejected — the null-relation
query already gives free retry semantics).
**Consequences:** After an outage the same emails are simply picked up by the next run. A
rising `fallbackClassified` count in `GET /classification/stats` means bad model output,
not a network problem.

### Sync operations default to dry-run
**Date:** 2026-04-09
**Status:** Active
**Decision:** `POST /email-sync/:id/run`, `/email-sync/run-all`, and `/email-sync/:id/ingest`
all read `dryRun` as `dryRun !== "false"` — omitting the parameter means dry-run. A dry run
connects to IMAP, counts messages, and writes nothing except the `SyncState` status reset.
**Reasoning:** This is a safety-critical boundary against a live mailbox. The default had to
be the harmless one, and the check had to fail closed for typos (`?dryRun=0` is still a dry run).
**Alternatives considered:** Default to persisting with an explicit `--confirm` (rejected —
inverts the safe default); a global env kill switch (rejected — too coarse for per-call use).
**Consequences:** `scripts/daily-digest.sh` must pass `?dryRun=false` explicitly. Any new
mailbox-touching endpoint is expected to adopt the same default and the same string check.

### Encrypt IMAP credentials at rest with AES-256-GCM and a hashed key
**Date:** 2026-04-09
**Status:** Active
**Decision:** `common/crypto.util.ts` stores `iv:ciphertext:authTag` (base64, colon-joined)
using `aes-256-gcm`, with the key derived as `sha256(ENCRYPTION_KEY)`. Both
`encryptedPassword` and `encryptedRefreshToken` use it.
**Reasoning:** Hashing the raw env value to 32 bytes means `ENCRYPTION_KEY` can be any
string, which removes a whole class of "invalid key length" setup failures. GCM gives
tamper detection for free.
**Alternatives considered:** A KDF with a salt such as scrypt/PBKDF2 (rejected — would need
per-record salt storage for a single-user self-hosted app); OS keychain (rejected — not
portable to a headless deployment).
**Consequences:** `ENCRYPTION_KEY` is not rotatable without re-encrypting every row, and
changing it makes all stored credentials undecryptable. There is no salt, so identical
passwords under the same key produce distinct ciphertexts only because the IV is random.

### Store AI provider configuration in the database, not the environment
**Date:** 2026-04-12
**Status:** Active
**Decision:** Provider type, API key, model, endpoint, and temperature live in the
`AiProviderConfig` table with a unique constraint on `provider` and an `isActive` flag;
`AiProviderService` reads the active row per call and caches the instantiated adapter by
config id.
**Reasoning:** Providers are swapped experimentally (quota exhaustion, model comparison) and
a REST-driven switch beats editing `.env` and restarting a launchd service.
**Alternatives considered:** Env vars per provider (rejected — restart required, no
multi-provider comparison); a config file (rejected — no atomic activate operation).
**Consequences:** API keys sit in Postgres in plaintext — unlike IMAP credentials they are
*not* run through `crypto.util`. Every response path must strip them
(`AiProviderController.sanitizeConfig`). Behaviour knobs that are *not* per-provider
(`AI_REQUESTS_PER_MINUTE`, `AI_MAX_TOKENS`, breaker timings) stayed in the environment, so
configuration is split across two places.

### Drive the pipeline from launchd over HTTP rather than an in-process scheduler
**Date:** 2026-06-12
**Status:** Active
**Decision:** Each stage is a POST endpoint. `scripts/daily-digest.sh` chains them; three
launchd plists run the API always-on (`KeepAlive`), the `sync` stage hourly, and the
`digest` stage at 07:30.
**Reasoning:** Every stage is already idempotent and finds its own work by null-relation
query, so an external caller needs no state. It also keeps each stage independently
runnable by hand with `curl` during debugging.
**Alternatives considered:** `@nestjs/schedule` (rejected — couples the schedule to process
uptime, and the API is restarted by launchd whenever Postgres is down); a queue such as
BullMQ (rejected — adds Redis for a single-user workload).
**Consequences:** The schedule is invisible from inside the codebase. Timing bugs are
diagnosed with `launchctl list` and the logs in `~/.local/state/email-ai/`, not application
logs. The plists hardcode absolute `/Users/raymonddoran/...` paths and are not portable.

### Two IMAP ingestion paths coexist; only one feeds the pipeline
**Date:** 2026-04-09
**Status:** Active — **[TO DETERMINE]** whether `ImapIngestionService` should be removed
**Decision:** `EmailSyncService.syncAccount` (`imapflow` directly → `RawEmail`) is the
production path. `ImapIngestionService.ingestAccount` (`@email-ai/mail-client` →
`EmailMessage`) remains behind `POST /email-sync/:id/ingest`.
**Reasoning:** Not recoverable from the code or commit history. The `EmailMessage` table has
no reader anywhere in the repo, so the second path is either an abandoned first attempt or a
deliberately kept raw-capture facility.
**Alternatives considered:** Unknown.
**Consequences:** Two near-identical credential/connect/watermark blocks must be kept in
sync by hand, and a change made in the wrong one is silently ineffective. **To resolve this
entry, ask the maintainer whether `/email-sync/:id/ingest`, `EmailMessage`, and
`@email-ai/mail-client` are still wanted**; if not, deleting them removes the ambiguity.
