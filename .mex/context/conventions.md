---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
  - target: context/stack.md
    condition: when the convention is really a library choice (Zod, Prisma, Jest)
  - target: patterns/add-api-module.md
    condition: when applying these conventions to a brand-new module or endpoint
grounds_to:
  - node: "method:7de6b0889b3cfb0e461eaa8fea048205"
    fingerprint: "mh:64:7b226d696e68617368223a5b313336333738322c313037323836332c35333638373230322c333437383039392c31323833313539342c31323738343838362c38383932353238392c3237303539323939342c31323732353739302c36383839353732322c36353435333139302c3130343031373739302c383538303636352c33323732323635302c31393336353234342c37333039353333382c39303332323230392c34363433333738352c393230383837362c34393330303139322c3136383232343631332c33363231303432362c313830393030342c33333936333732352c32383237383038372c31373038393935332c323034383432372c3135353932393737372c33323435303830362c3130313933303030352c373838333833362c31333537373834382c31333839393137312c35323236383432392c3136333837383038302c313934333631382c31393239333031372c3132313738313635372c35313731343136382c39373230303432352c39303538363132342c3135333333353634322c393738333334312c35393038333832322c32353134353335302c383038393933302c31323638313633362c36333334393834332c31303235343439332c32393135323035322c34353934333130312c35333337313736392c3133323933343135342c31313931323733372c313432303235342c353632373638362c32323735333834372c3131353132343738382c31333530373433322c37333137323638362c3130323539343134302c393134333130362c3230353838383330392c32353530343830325d2c226e65696768626f7273223a5b226d6574686f643a3662363531396637376336393236623036626336383530313934333463373465222c226d6574686f643a3934306564313665333666313964633537616464666136613230643436626535225d2c22746f6b656e436f756e74223a3131387d"
  - node: "method:940ed16e36f19dc57addfa6a20d46be5"
    fingerprint: "mh:64:7b226d696e68617368223a5b33333830393232392c323737393737382c37323036373631342c393435353339312c31323833313539342c373533343539302c33343637393232332c343137323934392c31323732353739302c35303332323230372c323933383438332c343937393136322c31363733383936342c32343837333139332c31333137393237352c35313139373838332c36313931303933352c353835303039302c3135343637373033322c33363334333539352c35323736373931302c31303636353633342c31393238303735392c383330333233312c343935373133332c36383732393532372c33323134323732312c32333239363630332c33323435303830362c313639323235392c31313339323038332c31333237353231322c313332393431382c34303134313533302c34333235323031372c313934333631382c323232363838322c31313330323138382c32343839343034332c37323535373038362c343031343031302c34313738343932362c34363737363635332c313236393130392c353630353534392c31383038393735392c31303939322c35313139333435372c323639343539392c32323332343235392c31363132323235332c37383138343436302c39323435363536352c35353537333335302c32383433303136362c353632373638362c33323230373433352c38353831353633392c333435383637392c36363337313232302c32363235333133302c393134333130362c373132303139352c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a6137316331383934663062653534303662643637343638333839363165346661222c226d6574686f643a3764653662303838396233636662306534363165616138666561303438323035222c226d6574686f643a6162653639343861646638623232646430333737333764633334653261383963225d2c22746f6b656e436f756e74223a3232397d"
last_updated: 2026-09-23
---

# Conventions

## Naming

- Files: kebab-case with a role suffix — `email-sync.service.ts`, `email-sync.controller.ts`,
  `email-sync.module.ts`, `email-sync.types.ts`, `dto/create-email-account.dto.ts`.
- The directory name, the file prefix, and the `@Controller('...')` route all match:
  `modules/email-sync/` → `email-sync.*.ts` → `@Controller("email-sync")`.
- Tests are `*.spec.ts` colocated with the file under test (`crypto.util.ts` →
  `crypto.util.spec.ts`). Jest only discovers files matching that regex under `src`.
- Zod schemas are PascalCase ending in `Schema`, exported alongside an inferred type of the
  same name minus the suffix: `EmailClassificationOutputSchema` / `EmailClassificationOutput`.
- Prisma models are PascalCase singular (`NormalizedEmail`), fields are camelCase. Prisma
  maps to the database itself — do **not** hand-write `snake_case` `@map` attributes; nothing
  in `schema.prisma` uses them.
- Batch/one-shot endpoint pairs are named `run` (all pending) and `<verb>One`/`:id/<verb>`
  (single record): `POST /normalization/run` vs `POST /normalization/:id/normalize`.

## Structure

- Business logic lives in `*.service.ts`. Controllers are thin: they read `@Param`/`@Query`,
  coerce, and return the service call directly — most are one-liners.
- Persistence goes through the injected `DatabaseService` (`extends PrismaClient`). Never
  construct a `PrismaClient`, and never add a repository layer.
- Anything shared between the API and the TUI belongs in `packages/shared` and must be
  re-exported from `packages/shared/src/index.ts`.
- A new module needs `{name}.module.ts` and registration in `AppModule`'s `imports` array;
  a module that is not listed there simply never loads.
- Cross-module use is via `exports` on the providing module plus `imports` on the consumer
  (e.g. `EmailSyncModule` imports `EmailAccountsModule`). There is no global service registry
  apart from `ConfigModule`, which is `@Global()`.
- Query-string booleans are decoded as `dryRun !== "false"` — the flag defaults to *on*
  and only the literal string `"false"` turns it off.

## Patterns

**Batch stage = loop over one-record method, count, never abort.** Every pipeline stage
exposes a single-record method and a batch driver that finds unprocessed rows by a null
relation, catches per-record errors, and returns a count object. Follow this shape exactly
for a new stage:

```ts
// Correct — one bad email cannot stop the batch
const unparsed = await this.db.rawEmail.findMany({ where: { parsed: null }, select: { id: true } });
let processed = 0, errors = 0;
for (const { id } of unparsed) {
  try { await this.parseRawEmail(id); processed++; }
  catch (error) { this.logger.error(`Failed to parse raw email ${id}`, error); errors++; }
}
return { processed, errors };

// Wrong — Promise.all aborts the batch and hammers the backend concurrently
await Promise.all(unparsed.map((r) => this.parseRawEmail(r.id)));
```

**Write with `upsert` keyed on the natural unique constraint, not `create`.** Stages are
re-run constantly (hourly launchd job, manual retries) and must be idempotent.
`parseRawEmail` upserts on `rawEmailId`; sync upserts on
`accountId_mailbox_uid`. When re-running should *not* clobber existing data, pass
`update: {}` — that is the deliberate "insert if absent, otherwise leave alone" idiom.

**Throw Nest HTTP exceptions from services, not generic `Error`.** Services raise
`NotFoundException` / `BadRequestException` directly (`EmailSyncService`,
`EmailParserService`, `EmailAccountsService`) so the controller needs no error mapping.
There is no `Result` type in this codebase.

**Validate every external string with Zod before it reaches the database.** LLM output goes
through `EmailClassificationOutputSchema.safeParse`; the environment goes through
`envSchema.parse` at boot. Never trust an LLM reply enough to spread it into a Prisma call.

## Verify Checklist

Before presenting any code:

- [ ] `pnpm typecheck` passes (this builds `@email-ai/shared` first — required after schema
      or shared-package edits).
- [ ] `pnpm test` passes. If the Prisma schema changed, `pnpm --filter @email-ai/api db:generate`
      ran first, or the types are stale.
- [ ] New module is registered in `AppModule`'s `imports`; new shared symbol is re-exported
      from `packages/shared/src/index.ts`.
- [ ] Any new batch endpoint follows the loop-and-count shape and uses `upsert`, not `create`.
- [ ] Database writes go through the injected `DatabaseService` only.
- [ ] Nothing mutates the mailbox (no delete/flag/reply; the only MOVE is in
      `MailboxWriterService`) and any sync- or apply-shaped operation still defaults to
      `dryRun` on. The static guard spec `no-destructive-imap.guard.spec.ts` must pass.
- [ ] No secret, API key, decrypted password, or access token is logged or returned in a
      response body (`AiProviderController.sanitizeConfig` is the reference for stripping `apiKey`).
- [ ] Do not cite `pnpm lint` as evidence of anything — it is a stub `echo`.
