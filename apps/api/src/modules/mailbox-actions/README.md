# mailbox-actions

The only module that changes a mailbox. It does one thing: an IMAP
`UID MOVE` from INBOX to the server-advertised `\Trash` folder, plus the
reverse move for undo. Nothing here flags `\Deleted`, expunges, or deletes
permanently.

## Files

| File | Role |
| ---- | ---- |
| `mailbox-writer.service.ts` | `moveToTrash()` and `restore()`: the only `messageMove` calls in the repo |
| `mailbox-reconcile.service.ts` | Resolves `pending`/`unknown` rows. **Read-only on IMAP**: never imports the writer or calls `messageMove` |
| `imap-lookup.ts` | Read-only IMAP helpers (Trash detection, envelope fetch, Message-ID search, presence re-check) and the RawEmail relink |
| `mailbox-actions.service.ts` | Audit-log listing, kill-switch status, undo (delegates to the writer), reconcile |
| `mailbox-actions.controller.ts` | `GET /mailbox-actions`, `GET /mailbox-actions/status`, `POST /mailbox-actions/:id/undo`, `POST /mailbox-actions/reconcile` |
| `message-id.ts` | Message-ID extraction from stored raw headers, and normalized comparison |
| `no-destructive-imap.guard.spec.ts` | Static guard (see below) |

`POST /sender-rules/apply` (in `sender-rules/sender-rules-apply.service.ts`)
picks the candidates and calls `moveToTrash()`. It acts only when the
**winning** sender rule (the same precedence as classification) is an
enabled `trash` rule. It skips mail whose classification was rejected or
recategorized in review, and mail whose Message-ID was trashed before.

## Access control

- The kill switch: `MAILBOX_WRITES_ENABLED` must be exactly `"true"` (read at
  boot) for moves, undo and reconcile.
- The API binds to `127.0.0.1` (override with `EMAIL_AI_HOST`), and
  rejects any request whose `Host` header is not its own local address
  (DNS rebinding).
- Every non-GET request (undo, reconcile, apply, rule edits, …) needs the
  `X-Email-AI-Client` header, enforced by a global guard (403 without it).
  The header forces a CORS preflight, which the API never grants, so a
  page on another origin cannot send these requests through a browser.
  Local processes can still call the API.

## Guards in `moveToTrash`, in order

1. **Kill switch.** Throws 403 before the account, credentials, or an IMAP
   client are touched.
2. **Account.** Must be active and not `needsReauth`.
3. **UIDs.** Positive integers, no duplicates. They are passed to imapflow as
   `number[]`, never as range strings.
4. **MOVE capability.** Required. Without it imapflow silently emulates MOVE
   with copy + `\Deleted` + expunge, so the account is refused. All targets
   are `failed` with `server lacks MOVE`, and no rows are written. MOVE is
   re-asserted immediately before each `messageMove`.
5. **Trash folder.** Exactly one LIST entry with `specialUse === "\\Trash"`
   and `specialUseSource === "extension"` (advertised by the server).
6. **Lock INBOX.** If the stored `uidValidity` is known and differs, the
   target is skipped (`uidvalidity_changed`).
7. **Identity.** Envelope fetch (plus `X-GM-LABELS` on Gmail). Skip reasons:
   - `messageid_mismatch`: the stored Message-ID differs from the server's.
   - `identity_unverified`: neither a Message-ID nor a UIDVALIDITY is stored.
   - `not_found_in_source`: the UID is no longer in INBOX.
8. **History.** Checked against the audit log.
   - Skipped with no row: `already_in_progress` when there is an active
     move (pending, succeeded or unknown) for the same RawEmail, or for
     the same UID under this UIDVALIDITY.
   - Skipped with a row: `previously_trashed` when a succeeded or undone
     move exists for the same Message-ID on the account. The message was
     taken back out of Trash by undo or by hand, and is never re-trashed.

## Write path (per chunk of 50, one connection)

1. Skipped rows are written.
2. `pending` rows are inserted **one at a time**. The partial unique
   indexes from migration `20260923162327_mailbox_action_unknown_restrict_one_active`
   allow one active move per (account, UIDVALIDITY, UID) and per RawEmail.
   A P2002 on insert means another process holds the message, so only
   that target is skipped as `already_in_progress`. Any other insert error
   closes the rows already written (`failed`, "not moved") and aborts.
3. `UID MOVE`.
4. The outcome is decided per UID:
   - A UID in the COPYUID map → `succeeded` with its `destUid`.
   - A UID missing from a reported map → `failed`.
   - No COPYUID, `false`, or a thrown MOVE → the writer re-checks what is
     still in INBOX. imapflow returns `false` for a lost connection too.
     - Still there → `failed`.
     - Gone after `false` or a throw, or after an OK from a server without
       UIDPLUS → `succeeded` with `destUid` null.
     - Gone after an OK without COPYUID from a UIDPLUS server → `failed`.
     - **The re-check itself fails → `unknown`.**
5. Outcomes are written in one transaction. If that write fails, the rows
   stay `pending`.

A thrown MOVE aborts the rest of the run. The lock is released and the
client logged out in `finally`. An in-process lock per account returns 409
for overlapping writes.

## Undo

`restore(actionId)`:

1. Kill switch first.
2. 404 for an unknown id. 409 unless the action is a `succeeded`
   `move_to_trash`.
3. The original is claimed atomically: `updateMany` where
   `{id, status: succeeded}` sets it to `pending`, and a count of 0 is a 409.
4. The writer locks the Trash folder and finds the message:
   - at `destUid`, only if that UID is valid, the Trash UIDVALIDITY is
     unchanged, and the Message-ID matches;
   - otherwise by searching the Message-ID header and re-verifying each hit.
   - Not found → 502, and the claim is released.
5. It writes a `pending` `restore` row, **linked with `undoOfId` from the
   start**, then moves the message back to INBOX.
   - Unclear outcome: the writer re-checks Trash.
     - Still there → 502. The restore row becomes `failed` and is
       unlinked, and the claim is released.
     - Gone → the restore is recorded.
     - Re-check fails → the restore row becomes `unknown` and the
       original stays `pending`, both waiting for reconcile.
6. On success the restore row becomes `succeeded`, and the original
   becomes `undone`.
7. The original `RawEmail.uid` is re-pointed at the restored UID, but only
   if no other RawEmail already holds that UID.

Gmail labels recorded at move time are **not** re-applied.

## Reconcile

`POST /mailbox-actions/reconcile?accountId=` (kill switch and header
required). It handles `pending` and `unknown` rows older than 10 minutes;
younger rows may still be in flight.

**The exact stored UID is checked first.** This is only possible while the
folder's current UIDVALIDITY equals the stored one, and a UID is never
reused within one, so the answer is definitive:

- **move_to_trash:**
  - `sourceUid` still in INBOX → `failed`: it was not moved. This works
    even for rows with no Message-ID.
  - A known `destUid` present in Trash → `succeeded`.
- **restore** (and the `pending` original it links to via `undoOfId`):
  - `sourceUid` still in Trash → restore `failed` and unlinked, original
    back to `succeeded` (undo can be retried).
  - A known `destUid` present in INBOX → restore `succeeded`, original
    `undone`.

**Message-ID is only the fallback,** used when the UID check is impossible
or inconclusive. All verified hits in both folders are collected, and any
ambiguity leaves the row unresolved:
- the Message-ID is found in both folders;
- it is found more than once in one folder;
- the stored UID is gone but another copy with the same Message-ID is in
  that same folder.

Otherwise:
- **move_to_trash:** exactly one hit in Trash → `succeeded` with that
  `destUid` (undoable). Exactly one hit in INBOX → `failed`.
- **restore:** exactly one hit in INBOX → restore `succeeded`, original
  `undone`, RawEmail relinked. Exactly one hit in Trash → restore
  `failed`, original `succeeded`.

Anything else, including no Message-ID with an inconclusive UID check, is
left unresolved to check by hand.

All updates are conditional on the status that was read, so a concurrent
change is reported rather than overwritten. Reconcile only lists, locks,
searches and fetches on IMAP. It cannot reach `messageMove`, and the
guard spec asserts that `mailbox-reconcile.service.ts` and `imap-lookup.ts`
never mention it or the writer.

## Static guard

`no-destructive-imap.guard.spec.ts` scans every `.ts`/`.tsx` file under
`apps/<name>/src` and `packages/<name>/src` (api, tui, mail-client,
shared). It fails on any of these:

- `messageDelete`, `messageFlagsAdd`, `messageFlagsSet`, `messageFlagsRemove`
- `messageCopy`, `mailboxDelete`, `mailboxRename`
- `\Deleted`, `expunge(`, `append(`
- a quoted `EXPUNGE` / `STORE` command
- `run('MOVE'|'COPY'|'DELETE'|'RENAME'|'EXPUNGE'|'STORE'…`

It also fails if any non-spec file other than `mailbox-writer.service.ts`
reaches `messageMove`, including `['messageMove']` bracket access.

## Known limitations

- **Cross-process lock is database-only.** The per-account write lock is
  in-process. Across processes (the dev and launchd APIs), only the
  partial unique indexes prevent a double move. Two processes can still
  both connect and run identity checks for the same account at once; the
  second one's inserts are skipped as `already_in_progress`.
- **Duplicate Message-IDs.** Some senders reuse Message-IDs. Two such
  messages count as one for `previously_trashed`, so the second one is
  never trashed. Reconcile leaves them unresolved when both are present.
- **Unresolvable rows.** A `pending`/`unknown` row with neither a
  conclusive UID check nor a unique Message-ID hit stays unresolved and
  needs a manual look. Rows stay in their status until fixed by hand.
- **Only INBOX is a source; restore goes to INBOX only.** Gmail labels are
  recorded but not re-applied.
- **Trash purge.** After the server purges Trash, the message is gone and
  undo returns 502.
- **Reconcile vs. an in-flight undo.** The 10-minute age filter uses
  `createdAt`, so a move row that undo has just claimed (`pending`) looks
  old to reconcile. If reconcile runs while that undo is still connecting
  and before its restore row exists, it can flip the claimed original back
  to `succeeded`. No mail is at risk (the unique `undoOfId` and the final
  update to `undone` win), but the audit trail can briefly disagree. Don't
  run reconcile while an undo is in progress.
- **`previously_trashed` side effects.** A duplicate copy that shares a
  Message-ID with an already-trashed message gets a permanent skip and
  stays in INBOX; a spammer who reuses one Message-ID across campaigns is
  trashed only once. Both fail safe. Separately, if reconcile marks a move
  `failed` because the message was found in INBOX (for example you dragged
  it back by hand before reconcile ran), that Message-ID is not in the
  `previously_trashed` set, so a re-ingested copy can be trashed again.

## Operational notes

- The kill switch is read at boot. Restart the API after changing it:
  `launchctl kickstart -k gui/$(id -u)/com.odnf.email-ai.api`.
- `pending` or `unknown` rows: run reconcile. What it cannot place needs a
  look in the mailbox by hand.
- `skipped` moves are never retried. `failed` ones are retried on the next
  apply run. `unknown` ones are never retried.
- An EmailAccount with MailboxAction rows cannot be deleted (FK `RESTRICT`,
  409 from `DELETE /email-accounts/:id`).
- Gmail purges Trash after 30 days; other servers may purge sooner. After
  that, undo returns 502.
- Dry runs (`POST /sender-rules/apply`, the default) never reach this
  service and write no rows.
