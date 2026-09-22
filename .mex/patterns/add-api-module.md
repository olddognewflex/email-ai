---
name: add-api-module
description: Add a new NestJS module, endpoint, or pipeline stage to apps/api — the most common task in this repo. Covers wiring, the batch-endpoint shape, and shared-type placement.
triggers:
  - "add endpoint"
  - "new module"
  - "new controller"
  - "new service"
  - "add route"
  - "new pipeline stage"
edges:
  - target: context/conventions.md
    condition: always — naming, structure, and the Verify Checklist live there
  - target: context/architecture.md
    condition: when deciding where the new module fits and what it may depend on
  - target: context/pipeline.md
    condition: when the new module is another processing stage over emails
  - target: patterns/change-prisma-schema.md
    condition: when the module needs a new table or column
grounds_to:
  - node: "method:7de6b0889b3cfb0e461eaa8fea048205"
    fingerprint: "mh:64:7b226d696e68617368223a5b313336333738322c313037323836332c35333638373230322c333437383039392c31323833313539342c31323738343838362c38383932353238392c3237303539323939342c31323732353739302c36383839353732322c36353435333139302c3130343031373739302c383538303636352c33323732323635302c31393336353234342c37333039353333382c39303332323230392c34363433333738352c393230383837362c34393330303139322c3136383232343631332c33363231303432362c313830393030342c33333936333732352c32383237383038372c31373038393935332c323034383432372c3135353932393737372c33323435303830362c3130313933303030352c373838333833362c31333537373834382c31333839393137312c35323236383432392c3136333837383038302c313934333631382c31393239333031372c3132313738313635372c35313731343136382c39373230303432352c39303538363132342c3135333333353634322c393738333334312c35393038333832322c32353134353335302c383038393933302c31323638313633362c36333334393834332c31303235343439332c32393135323035322c34353934333130312c35333337313736392c3133323933343135342c31313931323733372c313432303235342c353632373638362c32323735333834372c3131353132343738382c31333530373433322c37333137323638362c3130323539343134302c393134333130362c3230353838383330392c32353530343830325d2c226e65696768626f7273223a5b226d6574686f643a3662363531396637376336393236623036626336383530313934333463373465222c226d6574686f643a3934306564313665333666313964633537616464666136613230643436626535225d2c22746f6b656e436f756e74223a3131387d"
  - node: "method:940ed16e36f19dc57addfa6a20d46be5"
    fingerprint: "mh:64:7b226d696e68617368223a5b33333830393232392c323737393737382c37323036373631342c393435353339312c31323833313539342c373533343539302c33343637393232332c343137323934392c31323732353739302c35303332323230372c323933383438332c343937393136322c31363733383936342c32343837333139332c31333137393237352c35313139373838332c36313931303933352c353835303039302c3135343637373033322c33363334333539352c35323736373931302c31303636353633342c31393238303735392c383330333233312c343935373133332c36383732393532372c33323134323732312c32333239363630332c33323435303830362c313639323235392c31313339323038332c31333237353231322c313332393431382c34303134313533302c34333235323031372c313934333631382c323232363838322c31313330323138382c32343839343034332c37323535373038362c343031343031302c34313738343932362c34363737363635332c313236393130392c353630353534392c31383038393735392c31303939322c35313139333435372c323639343539392c32323332343235392c31363132323235332c37383138343436302c39323435363536352c35353537333335302c32383433303136362c353632373638362c33323230373433352c38353831353633392c333435383637392c36363337313232302c32363235333133302c393134333130362c373132303139352c31313732363932355d2c226e65696768626f7273223a5b2266756e6374696f6e3a6137316331383934663062653534303662643637343638333839363165346661222c226d6574686f643a3764653662303838396233636662306534363165616138666561303438323035222c226d6574686f643a6162653639343861646638623232646430333737333764633334653261383963225d2c22746f6b656e436f756e74223a3232397d"
last_updated: 2026-08-10
---

# Add an API Module or Endpoint

## Context

Load `context/conventions.md`. Every module in `apps/api/src/modules/` follows the same
shape, and `email-parser/` is the smallest complete example of a pipeline-stage module —
[`parseRawEmail()`](mex://method:940ed16e36f19dc57addfa6a20d46be5) for one record,
[`processUnparsed()`](mex://method:7de6b0889b3cfb0e461eaa8fea048205) for the batch, a
three-line controller, and a module file. `health/` is the minimal example of a module with a
controller and no service of its own.

Before editing an existing symbol, run `mex impact <symbol>` — several services have two
callers because of the duplicated sync/ingest paths.

## Steps

1. Create `apps/api/src/modules/<kebab-name>/` with `<kebab-name>.module.ts`,
   `<kebab-name>.service.ts`, and `<kebab-name>.controller.ts` (controller only if it exposes
   HTTP). The directory name, file prefix, and `@Controller("<kebab-name>")` route must all match.
2. Inject `DatabaseService` for persistence and `AppConfigService` for env-derived values.
   `ConfigModule` is `@Global()` so it needs no import; anything else you consume needs its
   module in your `imports` and the provider in that module's `exports`.
3. Put the business logic in the service. Keep the controller to reading `@Param`/`@Query`,
   coercing, and returning the service call.
4. If it is a pipeline stage, implement the pair: a single-record method that upserts on the
   natural unique key, and a batch driver that queries the null downstream relation, loops with
   a per-record `try/catch`, and returns `{ processed, errors }`. Expose them as
   `POST /<name>/run` and `POST /<name>/:id/<verb>`.
5. Register the module in `AppModule`'s `imports` array in `apps/api/src/app.module.ts`.
   **A module not listed there never loads and its routes silently 404.**
6. Any type or schema the TUI also needs goes in `packages/shared/src/schemas/` or
   `types/` and must be re-exported from `packages/shared/src/index.ts`.
7. Add a colocated `<name>.service.spec.ts`. Jest only picks up `*.spec.ts` under `src`.
8. If the stage should run on schedule, add a `curl` line to `scripts/daily-digest.sh` —
   nothing chains stages automatically.

## Gotchas

- **Query-string booleans**: the project idiom is `flag !== "false"`, which defaults to *on*.
  For anything that touches a mailbox this default must be the safe one (`dryRun`).
- **`update: {}` vs a real update body** in an upsert is a semantic choice, not boilerplate.
  Empty means "insert if absent, never overwrite" (parse, sync). A populated `update` means the
  stage is intended to be re-runnable in place (normalize). Pick deliberately.
- **Never `Promise.all` a batch.** One bad record must not abort the run, and concurrent IMAP
  or LLM calls defeat the rate limiter.
- Services throw `NotFoundException` / `BadRequestException` directly. There is no `Result`
  type and controllers do no error mapping.
- Adding a `dto/*.dto.ts` with `class-validator` decorators matches some older modules, but new
  validation should be a Zod schema in `packages/shared` plus `ZodValidationPipe`.
- Nothing may write to a mailbox, and no endpoint may assume an authenticated user — there is
  no auth layer at all.

## Verify

- [ ] `pnpm typecheck` passes (rebuilds `@email-ai/shared` first).
- [ ] `pnpm test` passes.
- [ ] The module appears in `AppModule.imports`; hit the route with `curl` and confirm it is
      not a 404.
- [ ] New shared symbols are re-exported from `packages/shared/src/index.ts`.
- [ ] Batch endpoint returns a count object and survives a deliberately broken record.
- [ ] No secret is logged or returned; nothing mutates a mailbox.

## Debug

- Route 404s → the module is missing from `AppModule.imports`, or the `@Controller` prefix does
  not match the path you are calling.
- `Nest can't resolve dependencies of X` → the provider is not `exports`-ed by its own module,
  or the consuming module does not `imports` it.
- `Cannot find module '@email-ai/shared'` → run `pnpm --filter @email-ai/shared build`.
- New Prisma field is missing from the typed client → `pnpm --filter @email-ai/api db:generate`.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
