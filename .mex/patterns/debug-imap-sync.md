---
name: debug-imap-sync
description: Sync is failing or fetching nothing — diagnose IMAP auth, the OAuth re-consent loop, the UID watermark, and stuck SyncState rows.
triggers:
  - "sync failing"
  - "imap error"
  - "no new emails"
  - "needs re-authorization"
  - "invalid_grant"
  - "SYNCING"
  - "lastSyncedUid"
  - "authentication failed"
edges:
  - target: context/credentials.md
    condition: always — credential resolution and the re-auth loop live there
  - target: context/pipeline.md
    condition: when confirming what stage 1 does and does not write
  - target: patterns/debug-pipeline-stall.md
    condition: when sync is fine and the stall is downstream
grounds_to:
  - node: "method:efd8143865e919dd229b149ab5736020"
    fingerprint: "mh:64:7b226d696e68617368223a5b313336333738322c313037323836332c31363231393837352c333437383039392c31323833313539342c32313837393434392c32393738303138392c343137323934392c31303732373536352c33303339393233352c343136333032372c333135343831372c31313935343539322c383637363138382c31333137393237352c32353536373834312c34323138313935332c32363836363630392c393230383837362c31343739333537382c34333832323439322c31353830313837312c313830393030342c32313833393533372c343935373133332c34323533363137332c323034383432372c32333239363630332c31343332303431322c313634363838322c31313137393535322c31333237353231322c383035373739312c32313131343039342c31343237343234332c313934333631382c323232363838322c323430343634392c32343839343034332c373030313734352c343031343031302c33353832353131302c3832363536312c31353735353635332c353630353534392c383038393933302c32363234373734362c383539323535342c323639343539392c31313037342c31363132323235332c31353232313031332c33373738363738342c31313931323733372c313432303235342c31353033333735322c31353038393935392c32303038333238312c31333235333739312c31323932333335322c34363731393130372c393134333130362c373132303139352c323831373337375d2c226e65696768626f7273223a5b226d6574686f643a3063306263623836346535316134393161343238343962663036323939376132222c226d6574686f643a3463623331666534653766663533303136306466313634323730356534383035222c226d6574686f643a3732633138306632343839373065343435303939333464616433303933313635222c226d6574686f643a3864623265613938383536386434326135613238353439616233623332626633222c226d6574686f643a6330343065623933396662343734633138393238393862663934393333656635225d2c22746f6b656e436f756e74223a3831307d"
  - node: "method:8db2ea988568d42a5a28549ab3b32bf3"
    fingerprint: "mh:64:7b226d696e68617368223a5b31303137383634342c323737393737382c37323036373631342c333437383039392c31323833313539342c33373530313137302c33303639373738302c343137323934392c31303732373536352c35343033343739302c31373931303839362c343937393136322c35373339363331382c32343837333139332c31333137393237352c32353536373834312c35353932303535372c353835303039302c31303035363839332c34393330303139322c33383137363739372c31353830313837312c34353831393735362c32383332313438382c343935373133332c33353630303631322c323034383432372c393938373439322c36323239323832362c3130313933303030352c31313137393535322c31333237353231322c383035373739312c36303432373937332c34333235323031372c313934333631382c31393239333031372c3132313738313635372c33353231363831392c373030313734352c34323339333634342c35373637333135312c34363737363635332c37333530373734342c353630353534392c31313832323530302c38373330343132352c35313139333435372c34303434373932392c32323332343235392c38323531313430312c32333736373130352c31353430383632322c35343535343034372c32353231383733312c31353033333735322c39343437353539312c38353831353633392c34343930383434392c37333137323638362c32363136333833312c393134333130362c373132303139352c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a6438333035373735383465363836613962353733646262316562323733306137222c226d6574686f643a3036383165663034643933316435633866663339643937363439623534636361222c226d6574686f643a3161613065383734636661633635376137343530303938663533396130663436222c226d6574686f643a3535643537303036346635663733363739646630633334616333643039373830222c226d6574686f643a3566626131643861376636646137616664383936653366646335346461333461222c226d6574686f643a6566643831343338363565393139646432323962313439616235373336303230225d2c22746f6b656e436f756e74223a3234367d"
last_updated: 2026-08-10
---

# Debug an IMAP Sync

## Context

Load `context/credentials.md`.
[`syncAccount()`](mex://method:efd8143865e919dd229b149ab5736020) fails fast in a fixed order —
account missing → `isActive: false` → `needsReauth: true` → credential resolution → connect →
fetch. The error message tells you which gate you hit, so read it before doing anything else.

Both IMAP paths resolve credentials through
[`getImapCredentials()`](mex://method:8db2ea988568d42a5a28549ab3b32bf3), which is the
only place that decrypts. Run `mex impact getImapCredentials` before changing it — it has two
direct callers because of the duplicated sync/ingest paths.

## Steps

1. **Read the error verbatim.** `EmailAccount <id> is inactive`, `... needs re-authorization`,
   and `... has no password` are all pre-flight refusals that never touched the network.
2. **Check the account and its sync state:**
   ```sh
   curl localhost:3000/email-accounts
   curl localhost:3000/email-sync/<accountId>/states
   ```
   `states` gives you `lastSyncedUid`, `lastSyncedAt`, and `status` per mailbox.
3. **Run one account explicitly, not the batch:**
   `curl -X POST "localhost:3000/email-sync/<id>/run?dryRun=true"`. A dry run connects and
   counts without writing — the cheapest way to prove credentials and connectivity.
4. **Compare `fetchedCount` and `storedCount`.** Non-zero fetched with zero stored is a dry run.
   Zero fetched means the UID watermark is already at the top of the mailbox.
5. **For a Gmail/OAuth account showing `needsReauth`**, re-consent:
   `POST /email-accounts/oauth/google/start` with the `accountId`, open the returned `authUrl`,
   and complete the callback. Clearing the flag in the database without re-consenting just
   reproduces the failure one layer deeper.

## Gotchas

- **`needsReauth` is set as a side effect of a failed sync**, when Google reports
  `invalid_grant` and `getImapCredentials` catches `OAuthRevokedError`. The account then refuses
  *before* the network on every subsequent run, so the underlying Google error appears only in
  the first failure's log.
- **A consent screen in "Testing" status expires refresh tokens after 7 days.** If Gmail accounts
  break roughly weekly, that is the cause — publish the consent screen.
- **`exchangeCode` throws when Google returns no refresh token**, which happens when the app
  already holds a grant. The fix is to revoke access in the user's Google account settings and
  restart the flow, not to retry.
- **OAuth connect state is an in-memory `Map` with a 10-minute TTL.** An API restart mid-flow —
  and launchd restarts the API whenever Postgres blips — invalidates the pending state and the
  callback fails with "state unknown or expired". Just restart the flow.
- **A changed `ENCRYPTION_KEY` breaks every account at once** with a GCM auth-tag failure from
  `decrypt`, not with an IMAP error. If *all* accounts fail simultaneously after a config change,
  suspect the key (and remember there are two `.env` files: repo root and `apps/api/`).
- **The watermark only advances for stored messages.** A long run of dry runs leaves
  `lastSyncedUid` where it was; the next real run then fetches everything since that point.
- **A `SyncState` stuck at `SYNCING`** means the process died between the status write and the
  `finally` block. It is cosmetic — nothing reads the status as a lock — but it is a reliable
  sign of a crash or a killed launchd job.
- **`syncAll` never throws for a single bad account**; it collects `{accountId, error}` into an
  `errors[]` array. Read the response body, not just the HTTP status.
- Do not "fix" a sync bug in `ImapIngestionService` — it is the parallel `EmailMessage` path
  that no downstream stage reads. Changes there have no effect on the pipeline.

## Verify

- [ ] `curl -X POST "localhost:3000/email-sync/<id>/run?dryRun=true"` returns a non-zero
      `fetchedCount` with no error.
- [ ] A real run with `?dryRun=false` returns a non-zero `storedCount` and
      `GET /email-sync/<id>/states` shows an advanced `lastSyncedUid` and a fresh `lastSyncedAt`.
- [ ] `status` is back to `IDLE`, not `SYNCING` or `ERROR`.
- [ ] `POST /email-parser/run` now finds work — the rows really did land in `RawEmail`.
- [ ] For an OAuth account, `needsReauth` is `false` after a successful run.

## Debug

- `EmailAccount <id> needs re-authorization` → run the Google connect flow with `accountId`.
- `Invalid ciphertext format` or a GCM auth-tag error → wrong or changed `ENCRYPTION_KEY`, or a
  hand-edited encrypted column.
- `EmailAccount <id> has no password` / `has no OAuth refresh token` → the account row was
  created without a credential for its `authType`.
- Connect-level IMAP errors (auth rejected, TLS) → verify `host` / `port` / `secure` on the
  account; `imapflow` is constructed with `logger: false`, so raise verbosity there temporarily
  if you need protocol detail.
- Under launchd, the useful logs are `~/.local/state/email-ai/api.log` and
  `hourly-sync.log` — not the terminal.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
