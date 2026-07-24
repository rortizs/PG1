# Apply Progress — MVP Vertical Slice (Upload → CAG Review → Persist → UI)

## Workload / PR Boundary

- Completed slices: **PR A — Compose + live migration** (Work Units 1–2) and **PR B — Real NestJS transport + Angular upload scaffold** (Work Units 3–4).
- Review budget: 400 changed lines target (stacked-to-main chain per `tasks.md` forecast); PR B alone exceeds it — see PR B budget note below, consistent with the forecast's own `400-line budget risk: High` / `Decision needed before apply: No` (pre-approved chained delivery).
- PR A estimated authored change: ~239 lines (`migrate.mjs` 108, `migrate-runner.test.mjs` 107, `docker-compose.yml` 21, `apps/api/package.json` diff 3) — well inside budget. `pnpm-lock.yaml` (117 lines) is generated and excluded from the authored count.
- PR A scope guard: touched only `infra/docker-compose.yml`, `apps/api/src/db/migrate.mjs`, `apps/api/tests/migrate-runner.test.mjs`, and `apps/api/package.json` (+ lockfile).
- PR B scope guard: touched only real NestJS transport wiring (`apps/api/src/main.ts`, `app.module.ts`, `*.controller.ts`, `http-types.ts`, `tsconfig.json`, `package.json`, `tests/smoke.test.mjs`) and the real Angular CLI scaffold (`apps/web/**`, root `pnpm-workspace.yaml` for native build approvals). No FastAPI/Claude/CAG (PR C) or Postgres/docker-compose (PR A, already done) work was touched in this pass.
- Chained strategy: stacked-to-main per `tasks.md` forecast (`Delivery strategy: auto-chain`, `Chain strategy: stacked-to-main`, `Decision needed before apply: No`).

## PR B — Real NestJS Transport + Angular Upload Scaffold (Work Units 3–4)

### Line Budget — Honest Boilerplate vs. Authored Breakdown

PR B's diff clearly exceeds the 400-line default budget. This was expected and pre-approved by `tasks.md`'s Review Workload Forecast (`400-line budget risk: High`, `Chained PRs recommended: Yes`, `Delivery strategy: auto-chain`, `Decision needed before apply: No` — no further confirmation gate required before apply). Breakdown:

| Category | Files | Approx. lines | Notes |
|---|---|---|---|
| Tracked-file diff (existing files modified) | `apps/api/{package.json,src/main.ts,src/app.module.ts,src/review-runs/review-runs.controller.ts,src/thesis-documents/thesis-documents.controller.ts,tests/smoke.test.mjs,tsconfig.json}`, `apps/web/{package.json,src/app/app.ts,tests/smoke.test.mjs,tsconfig.json}`, `pnpm-workspace.yaml` | 327 insertions / 63 deletions (390 changed) | `git diff --stat HEAD` |
| New authored logic (untracked) | `apps/api/src/http-types.ts` (17), `apps/web/src/app/app.routes.ts` (9), `apps/web/src/app/results/results-page.ts` (77), `apps/web/src/app/thesis-api-client.ts` (87), `apps/web/src/app/upload/upload-page.ts` (97), `apps/web/src/app/upload/upload-validation.ts` (42), `apps/web/tests/upload-validation.test.mjs` (38), `apps/web/.gitignore` (3) | ~370 lines | Hand-authored product/test code |
| Angular CLI generated boilerplate (untracked, near-verbatim `ng new` output) | `apps/web/angular.json` (103), `apps/web/src/index.html` (13), `apps/web/src/styles.css` (1), `apps/web/tsconfig.app.json` (15), `apps/web/src/main.ts` (6, unmodified from `ng new`), `apps/web/src/app/app.config.ts` (18, +1 line for `provideHttpClient` over generated default), `apps/web/public/favicon.ico` (binary) | ~156 lines + 1 binary asset | Standard Angular CLI scaffold overhead — not hand-authored, not hand-reviewable line-by-line the way product code is |
| Generated lockfile (excluded from authored budget per policy) | `pnpm-lock.yaml` | +4841 / -48 | New `@nestjs/*`, `tsx`, and full Angular toolchain dependency tree |

**Total real diff excluding `pnpm-lock.yaml`: ~916 lines** (390 tracked + ~370 new authored + ~156 CLI boilerplate). This is honestly reported as over budget for a single PR, but matches the magnitude `tasks.md` itself forecast for PR B (part of a 2,000–3,200-line total across the 4-PR chain) and was pre-approved via `Decision needed before apply: No` — no additional maintainer confirmation was required before proceeding. If the reviewing maintainer wants PR B split further (e.g., NestJS transport as its own PR before Angular scaffold), that is a valid follow-up, not something this apply pass silently decided against; both work units were assigned together as "PR B" by the tasks artifact.

### Work Unit 3 — Real NestJS Transport

**Design decision honored**: controllers are thin adapters — every route handler delegates to the **existing, unmodified** `handleApiRequest` (`api-contract.mjs`), which in turn delegates to the existing `upload-service.mjs` / `review-run-lifecycle.mjs`. Zero business logic was rewritten.

Key implementation choices:
- **Runtime**: no `tsc` build step exists in this repo. Real NestJS decorators (`@Module`, `@Controller`, `@Post`, `@Get`, etc.) need `experimentalDecorators: true` at minimum. Added `tsx` (esbuild-based, dev dependency) as the TS/decorator runtime loader for both `apps/api`'s `test` and new `start` scripts (`node --import tsx ...`). No constructor-based dependency injection is used in these controllers (no `emitDecoratorMetadata`-dependent parameter reflection needed), keeping the esbuild-based transform path simple and low-risk.
- **`tsconfig.json`**: added `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields: false`, `allowJs: true` (needed because controllers import the existing `.mjs` pure-logic files directly). Verified fully clean with `npx tsc --noEmit` (zero errors) — all relative TS imports use explicit `.js` extensions per `NodeNext` module resolution convention (resolves correctly to the `.ts` source files under both `tsc` and `tsx`).
- **`main.ts`**: real `NestFactory.create(Pg1ApiModule)` + `app.listen(port, '127.0.0.1')` — bound to localhost only (REFACTOR guard from `tasks.md`/design's process-integration note: "bind worker to localhost only"). Guarded by an `import.meta.url` check so importing `bootstrapApi()` from tests never triggers a real `.listen()` as a side effect.
- **`app.module.ts`**: real `@Module({ controllers: [ThesisDocumentsController, ReviewRunsController] })`.
- **Controllers**: `ThesisDocumentsController` uses `@nestjs/platform-express`'s `FilesInterceptor('file')` + `@UploadedFiles()` to parse real multipart uploads into the `{filename, contentType, content, size}` shape `upload-service.mjs` already expects — **always** passing a real (possibly empty) `files` array so zero-file and multi-file submissions hit the existing "exactly one file" 422 validation instead of the pure-handler's separate no-body contract-stub branch (verified live with `curl`, see Manual Runtime Verification below). `ReviewRunsController` wires the three GET routes. Both import `handleApiRequest` and map `{status, body}` → `res.status(status).json(body)`.
- **`http-types.ts`** (new): minimal structural `HttpRequest`/`HttpResponse` interfaces used by `@Req()`/`@Res()` parameters instead of importing full Express types — avoids adding an `@types/express` dependency while keeping strict typing (no `any`).
- **`contract.test.mjs` intentionally left unchanged** (all 13 cases still call `handleApiRequest`/`listApiRoutes` directly). This follows `design.md` decision #1's explicit rationale ("Preserves `contract.test.mjs` seam assertions + pure-handler unit tests; additive transport") over a more loosely worded `tasks.md` RED instruction that named both `contract.test.mjs` and `smoke.test.mjs` — `smoke.test.mjs` alone became the new real-HTTP-boot RED/GREEN test, since duplicating all 13 pure-handler cases as live HTTP calls would re-test the same logic twice for no additional coverage and would conflict with the design's explicit intent to preserve that seam. Documented here rather than silently deviating.

### Work Unit 4 — Angular Upload Scaffold

Scaffolded with the real `@angular/cli` (v20.3.2, globally available in this environment) via `ng new web --routing --style=css --strict --standalone --minimal --package-manager=pnpm` into a scratch directory, then merged the generated `angular.json`, `tsconfig.json`/`tsconfig.app.json`, `src/index.html`, `src/styles.css`, `src/main.ts`, `public/favicon.ico` into `apps/web`, replacing the old placeholder `src/app/app.ts` / `src/app/routes.ts` / `src/app/features/review-dashboard/`. `--minimal` was chosen to skip Karma/Jasmine scaffolding since this repo's own convention is `node:test`-based tests (matching `apps/api`), not a browser test runner.

New feature code (all standalone, OnPush, signals, per the Angular guidance in scope):
- **`thesis-api-client.ts`** — `@Injectable({ providedIn: 'root' })` typed HTTP client wrapping `HttpClient` for `uploadThesisDocument`, `triggerReviewRun`, `getReviewRun`, `getReviewRunFindings`. Fully typed response interfaces, no `any`.
- **`upload/upload-validation.ts`** — pure, framework-free validation function (`validateSelectedFiles`) mirroring the API's own "exactly one PDF/DOCX file" contract, used for immediate client-side feedback (never replacing server-side validation). Directly unit-testable with `node:test` (no Angular runtime/TestBed needed) — this is what Work Unit 4's TRIANGULATE step (valid-PDF, unsupported-type, zero/multi-file) actually exercises.
- **`upload/upload-page.ts`** — standalone component, `ChangeDetectionStrategy.OnPush`, Reactive Forms (`FormControl<File[]>`), signals for `status`/`errorMessage`. On submit: validates client-side, POSTs the file to `/api/v1/thesis-documents`, then (on success) triggers a review run via `/api/v1/thesis-documents/{id}/review-runs` and navigates to `/runs/:runId` — this exercises the **entire real Work-Unit-3 backend chain** end to end, not a mocked/stubbed call.
- **`results/results-page.ts`** — standalone component, OnPush, reads `runId` from the route, calls the real `GET /api/v1/review-runs/{id}` and `GET .../findings` endpoints. Per PR B's explicit scope ("results page can show placeholder/empty state for now — PR D wires it to real data"), it renders the real API's current status/stage and a "No findings yet" empty state — genuinely correct today because `review-repository.mjs`/persistence (Work Unit 7, PR C) doesn't exist yet, so `findings` is always empty; PR D will not need to change this component's data-fetching, only its data.
- **`app.routes.ts`** — `''` → redirect to `upload`; `upload` → `UploadPage`; `runs/:runId` → `ResultsPage`.
- **`app.config.ts`** — added `provideHttpClient()` alongside the generated router/zone providers.

**RED-first rewrite of `apps/web/tests/smoke.test.mjs`** (per the orchestrator's explicit instruction — this was a consciously tracked change, not an accidental regression): the old test asserted the placeholder symbols `Pg1AdminApp` / `features/review-dashboard` against `src/app/app.ts`. It was rewritten first to assert the real app shape (`bootstrapApplication` in `main.ts`, `provideRouter`/`provideHttpClient` in `app.config.ts`, `upload`/`runs/:runId` routes, and the real `UploadPage`/`ResultsPage` component classes) — run and confirmed failing (`ENOENT`/module-not-found) against the pre-scaffold tree, then made to pass by scaffolding.

**Environment note (pnpm build-script approvals)**: this pnpm setup (v11.2.2, this machine's fork/config) requires explicit `allowBuilds`/`onlyBuiltDependencies` entries in `pnpm-workspace.yaml` for native postinstall scripts (`esbuild` for `tsx`; `@parcel/watcher`, `lmdb`, `msgpackr-extract` for the Angular CLI dev-server toolchain) — interactive `pnpm approve-builds` did not complete non-interactively in this tool environment, so these were added explicitly and verified (`pnpm install` exits 0, all four packages built successfully). This is a one-time environment-level config change, not a per-PR concern.

## Completed Tasks

- [x] Work Unit 1 GREEN: created `infra/docker-compose.yml` with `pgvector/pgvector:pg16` service `db` (user `pg1` / password `pg1` / db `pg1`, port `5432`, named volume `pg1_pgdata`, `pg_isready` healthcheck).
- [x] Work Unit 1 TRIANGULATE: verified live with `docker compose up -d db` — container reached `healthy` status and the `vector` extension was confirmed installable (`CREATE EXTENSION IF NOT EXISTS vector` succeeded during the live migration run below).
- [x] Work Unit 1 Verify: `docker compose up -d db` reached healthy state (see Test Commands Run). `.env.example` content is documented below as a manual step — not written by tooling.
- [x] Work Unit 1 Rollback verified: `docker compose down -v` cleanly removed the container, network, and volume (executed twice during this pass).
- [x] Work Unit 2 RED: added `apps/api/tests/migrate-runner.test.mjs` — two always-on unit tests for `splitMigration` (parse UP/DOWN, explicit error when markers missing) plus one integration-tier test that connects to a live `DATABASE_URL` (default `postgres://pg1:pg1@localhost:5432/pg1`), running `migrateUp`/`migrateDown` and asserting all 12 tables + the `vector` extension exist after `up` and are gone after `down`. The integration test uses `t.skip(...)` with an explicit reason when Postgres is unreachable, rather than failing or silently no-op-ing.
- [x] Work Unit 2 GREEN: implemented `apps/api/src/db/migrate.mjs` — plain `pg` client, `splitMigration()` splits `0001_schema_baseline.sql` on `-- UP`/`-- DOWN` markers, `migrateUp`/`migrateDown` accept either an externally-owned `client` or a `connectionString` (opens/closes its own client), plus a CLI entrypoint (`node apps/api/src/db/migrate.mjs up|down`) reading `DATABASE_URL` from `process.env`.
- [x] Work Unit 2 TRIANGULATE: ran the live integration test and the CLI directly against dockerized Postgres — confirmed all 12 tables + `vector` extension created on `up`, and 0 tables + no `vector` extension after `down`.
- [x] Work Unit 2 REFACTOR: kept `migrate.mjs` minimal and pure where possible (`splitMigration` is a pure function, unit-tested without any DB). Deferred sharing a pg client factory with `review-repository.mjs` to Work Unit 7 (PR C) since that file does not exist yet in this pass.
- [x] Work Unit 2 Verify: `pnpm --dir apps/api test` green (see Test Commands Run); manual `migrate.mjs up`/`down` cycle against Docker pg succeeded (see below).
- [x] Work Unit 2 Rollback verified: `migrate.mjs down` CLI run + `docker compose down -v` cleanly reverted all schema/container state.
- [x] Work Unit 3 RED: rewrote `apps/api/tests/smoke.test.mjs` to boot the real `bootstrapApi()`/`app.listen()` and hit `/api/v1/thesis-documents` over real HTTP plus assert the bind address is `127.0.0.1` only; ran and confirmed both new tests failed (`app.listen is not a function`) against the pre-Nest stub.
- [x] Work Unit 3 GREEN: added `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `reflect-metadata`, `rxjs` dependencies and `tsx` dev dependency; implemented real `main.ts` (`NestFactory.create` + `app.listen(port, '127.0.0.1')`), `app.module.ts` (`@Module`), and both controllers with real decorators delegating to the existing `handleApiRequest`.
- [x] Work Unit 3 TRIANGULATE: confirmed `upload-service.mjs`/`review-run-lifecycle.mjs` signatures untouched; all 13 `contract.test.mjs` cases (which call `handleApiRequest` directly) still pass; manually curled valid-PDF upload (201), unsupported-type upload (415), zero-file upload (422), multi-file upload (422), and review-run trigger (202) against the real running server — all four upload spec scenarios verified live over real HTTP, not just via the pure-handler tests.
- [x] Work Unit 3 REFACTOR: bound `app.listen` to `127.0.0.1` only (never `0.0.0.0`); introduced `http-types.ts` to centralize the minimal request/response shape controllers depend on instead of duplicating inline types per controller.
- [x] Work Unit 3 Verify: `pnpm --dir apps/api test` → 40 pass / 1 skip / 0 fail; manual `node --import tsx src/main.ts` (via `pnpm --dir apps/api start`) + `curl` round trip on all six routes succeeded.
- [x] Work Unit 3 Rollback boundary confirmed: reverting `apps/api/src/main.ts`, `app.module.ts`, `*.controller.ts`, `http-types.ts`, `tsconfig.json`'s decorator options, and the `@nestjs/*`/`tsx` dependency additions restores the pre-Nest stub state; `api-contract.mjs`/`upload-service.mjs`/`review-run-lifecycle.mjs` are completely untouched by this rollback since no logic lives in the reverted files.
- [x] Work Unit 4 RED: rewrote `apps/web/tests/smoke.test.mjs` to assert the real Angular app shape (`bootstrapApplication` entrypoint, `provideRouter`/`provideHttpClient` providers, `upload`/`runs/:runId` routes, real `UploadPage`/`ResultsPage` classes) instead of the old placeholder symbols (`Pg1AdminApp`/`features/review-dashboard`); ran and confirmed `ENOENT`/module-not-found failures against the pre-scaffold tree — a consciously tracked, expected regression per the orchestrator's explicit instruction, not an accidental one.
- [x] Work Unit 4 GREEN: scaffolded a real Angular CLI app (`ng new` v20.3.2, standalone/routing/strict/minimal) merged into `apps/web`; implemented `/upload` (`UploadPage`, Reactive Forms + signals) posting real multipart uploads to `POST /api/v1/thesis-documents`, `/runs/:runId` (`ResultsPage`), `app.routes.ts`, `app.config.ts` (`provideHttpClient`), and the shared `ThesisApiClient` service.
- [x] Work Unit 4 TRIANGULATE: added `apps/web/tests/upload-validation.test.mjs` (5 cases: valid PDF, valid DOCX, unsupported type, zero files, multiple files) directly unit-testing the pure `validateSelectedFiles` function; all 5 pass. Also manually verified the same three scenarios end to end over real HTTP via `curl` against the live NestJS server (see Work Unit 3 TRIANGULATE).
- [x] Work Unit 4 REFACTOR: extracted `ThesisApiClient` (`@Injectable({ providedIn: 'root' })`) as the single typed HTTP boundary, reused by both `UploadPage` (upload + trigger-review-run) and `ResultsPage` (get-run + get-findings) — ready for Work Unit 8 to reuse without changes.
- [x] Work Unit 4 Verify: `pnpm --dir apps/web test` → 7 pass / 0 fail on the rewritten suite; `pnpm test` at root → apps/api 40 pass/1 skip/0 fail, apps/web 7 pass/0 fail, worker 1 pass, exit code 0. Real `ng build` succeeded; real `ng serve` (via `pnpm --dir apps/web start`) booted and served both `/upload` and `/runs/:id` routes (SPA shell, confirmed via `curl`).
- [x] Work Unit 4 Rollback boundary confirmed: reverting `apps/web/src` (app.ts/app.config.ts/app.routes.ts/thesis-api-client.ts/upload/results), `angular.json`, `tsconfig*.json`, `package.json`, and `public/` restores the prior placeholder tree plus its original smoke test; no other app or service is affected.

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `infra/docker-compose.yml` | Created | `pgvector/pgvector:pg16` service `db` exposing 5432, named volume, healthcheck. |
| `apps/api/src/db/migrate.mjs` | Created | Plain `pg`-client migration runner: `splitMigration`, `readMigration`, `migrateUp`, `migrateDown`, CLI entrypoint. |
| `apps/api/tests/migrate-runner.test.mjs` | Created | 2 always-on unit tests (`splitMigration`) + 1 live-Postgres integration test with explicit skip-if-unreachable. |
| `apps/api/package.json` | Modified | Added `pg": "^8.13.1"` dependency. |
| `pnpm-lock.yaml` | Modified | Regenerated by `pnpm install` after adding `pg`. |
| `openspec/changes/mvp-vertical-slice/tasks.md` | Modified | Marked Work Unit 1–2 checkboxes `[x]` (this pass adds Work Unit 3–4 `[x]`). |
| `openspec/changes/mvp-vertical-slice/apply-progress.md` | Created | This file (this pass merges in PR B evidence). |
| `apps/api/src/main.ts` | Modified | Real `NestFactory.create` + `app.listen(port, '127.0.0.1')` bootstrap. |
| `apps/api/src/app.module.ts` | Modified | Real `@Module({ controllers: [...] })`. |
| `apps/api/src/thesis-documents/thesis-documents.controller.ts` | Modified | Real `@Controller`/`@Post`/`@Get` with `FilesInterceptor`, delegating to `handleApiRequest`. |
| `apps/api/src/review-runs/review-runs.controller.ts` | Modified | Real `@Controller`/`@Get` routes delegating to `handleApiRequest`. |
| `apps/api/src/http-types.ts` | Created | Minimal structural `HttpRequest`/`HttpResponse` types (avoids an `@types/express` dependency). |
| `apps/api/tsconfig.json` | Modified | Added `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields: false`, `allowJs`. |
| `apps/api/package.json` | Modified | Added `@nestjs/{core,common,platform-express}`, `reflect-metadata`, `rxjs`; dev dep `tsx`; `test`/`start` scripts now run via `node --import tsx`. |
| `apps/api/tests/smoke.test.mjs` | Modified (RED→GREEN) | Real HTTP boot + localhost-bind assertions, replacing textual pattern-match assertions. |
| `apps/web/angular.json`, `tsconfig.json`, `tsconfig.app.json`, `src/index.html`, `src/styles.css`, `src/main.ts`, `public/favicon.ico` | Created/Modified | Real `ng new` scaffold output (see boilerplate breakdown above). |
| `apps/web/src/app/app.ts` | Modified | Real standalone root shell (`RouterOutlet`, OnPush) replacing the placeholder `Pg1AdminApp`. |
| `apps/web/src/app/app.config.ts` | Created | Router + `provideHttpClient` providers. |
| `apps/web/src/app/app.routes.ts` | Created | `upload` and `runs/:runId` routes. |
| `apps/web/src/app/thesis-api-client.ts` | Created | Typed `HttpClient` wrapper (`providedIn: 'root'`). |
| `apps/web/src/app/upload/upload-validation.ts` | Created | Pure client-side validation mirroring the API's file-count/content-type contract. |
| `apps/web/src/app/upload/upload-page.ts` | Created | Standalone OnPush upload component (Reactive Forms + signals). |
| `apps/web/src/app/results/results-page.ts` | Created | Standalone OnPush results component (real status/findings calls, placeholder-safe empty state). |
| `apps/web/src/app/routes.ts`, `apps/web/src/app/features/review-dashboard/review-dashboard.ts` | Deleted | Old framework-light placeholder scaffold, superseded by the real Angular app. |
| `apps/web/package.json` | Modified | `@angular/*` deps, dev deps `@angular/cli`/`@angular/build`/`typescript`/`tsx`; `start`/`build`/`watch`/`test` scripts. |
| `apps/web/tests/smoke.test.mjs` | Modified (RED→GREEN) | Real app-shape assertions replacing `Pg1AdminApp`/`features/review-dashboard` placeholder assertions. |
| `apps/web/tests/upload-validation.test.mjs` | Created | 5 unit tests for `validateSelectedFiles` (valid PDF/DOCX, unsupported type, zero files, multiple files). |
| `apps/web/.gitignore` | Created | `/dist`, `/out-tsc`, `/.angular/cache`. |
| `pnpm-workspace.yaml` | Modified | Added `allowBuilds`/`onlyBuiltDependencies` for `esbuild`, `@parcel/watcher`, `lmdb`, `msgpackr-extract` native postinstall scripts (required by `tsx`/Angular CLI dev-server toolchain in this pnpm setup). |
| `pnpm-lock.yaml` | Modified | Regenerated for the new NestJS + Angular + `tsx` dependency tree. |

## `.env.example` — Manual Step (Documented, Not Written)

Per design.md and the policy blocking `Write`/`Bash` from creating `.env*` files, the user must manually create `.env` (or `.env.example`) at the repo root with:

```
DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1
ANTHROPIC_API_KEY=sk-ant-...
WORKER_BASE_URL=http://localhost:8000
```

`DATABASE_URL`'s host/port/credentials match `infra/docker-compose.yml`'s `db` service exactly (`pg1`/`pg1`/`localhost:5432`/`pg1`). No `.env*` file was created or modified by this apply pass.

## Test Commands Run

| Phase | Command | Result |
| --- | --- | --- |
| Safety net (baseline, before any change) | `pnpm test` | Passed 37 API tests, 1 web smoke test, 1 worker unittest — matches expected pre-change baseline. |
| Work Unit 2 RED | `pnpm --dir apps/api test` | Failed as expected with `ERR_MODULE_NOT_FOUND` for missing `apps/api/src/db/migrate.mjs` (2 failing tests: `splitMigration` parse + error-marker cases); live-Postgres test auto-skipped because the `pg` import chain failed gracefully. Overall: 37 pass, 2 fail, 1 skipped. |
| Work Unit 2 GREEN (Docker down) | `pnpm --dir apps/api test` | Passed 39/40 (1 skipped: live-Postgres test skipped with explicit reason `DATABASE_URL not reachable`, since no Postgres was listening yet). 0 fail. |
| Work Unit 1 TRIANGULATE | `docker compose up -d db` (in `infra/`) | Container `pg1-db` created and reached `healthy` `pg_isready` status. |
| Work Unit 2 TRIANGULATE (live, port 5433*) | `DATABASE_URL="postgres://pg1:pg1@localhost:5433/pg1" pnpm --dir apps/api test` | Passed 40/40, 0 skipped, 0 fail. Live-Postgres integration test genuinely executed: created 12 tables + `vector` extension on `up`, dropped all of them on `down`. |
| Work Unit 2 manual CLI evidence | `DATABASE_URL="postgres://pg1:pg1@localhost:5433/pg1" node apps/api/src/db/migrate.mjs down` then `... up` then `... down` | `down` (idempotent, no-op on clean DB) → `up` created 12 tables + `vector` extension (verified via `psql` table/extension counts) → `down` dropped all 12 tables back to 0. |
| Final verification (Docker down, canonical port restored) | `pnpm test` | Exit code 0. API: 39 pass, 1 skipped (live test, no Postgres running), 0 fail. Web: 1 pass. Worker: 1 pass. |
| PR B baseline (before touching Work Unit 3/4) | `pnpm test` | 39 API pass / 1 skip / 0 fail, 1 web pass, 1 worker pass — confirms PR A's committed state as the starting point for this pass. |
| Work Unit 3 RED | `node --import tsx --test tests/smoke.test.mjs` (in `apps/api`) | 2/2 failing: `error: 'app.listen is not a function'` — confirms the pre-Nest `bootstrapApi()` stub cannot serve real HTTP. |
| Work Unit 3 GREEN | `node --import tsx --test tests/smoke.test.mjs` (in `apps/api`) | 2/2 passing — real NestJS app boots, binds to `127.0.0.1`, and serves `/api/v1/thesis-documents` with the correct paginated shape. |
| Work Unit 3 full suite | `node --import tsx --test tests/*.test.mjs` (in `apps/api`) | 40 pass / 1 skip / 0 fail (up from 39/1/0 — net +1 passing test since `smoke.test.mjs` grew from 1 to 2 real tests; all 13 `contract.test.mjs` cases still pass unchanged). |
| Work Unit 3 manual runtime harness | `pnpm --dir apps/api start` (real `node --import tsx src/main.ts`) + `curl` | `GET /api/v1/thesis-documents` → 200; `GET /api/v1/review-runs/run_manual` → 200; `POST` valid PDF (multipart) → 201 with real sha256/storage metadata; `POST` unsupported type (`text/plain`) → 415; `POST` zero files (empty multipart) → 422 `validation_error`; `POST` two files → 422 `validation_error`; `POST /api/v1/thesis-documents/doc_manual/review-runs` → 202 with lifecycle-backed `run_doc_manual`. `GET /api/v1/unknown` → Nest's default 404 JSON shape (not the pure handler's custom error shape) — see Issues Found. |
| Work Unit 3 static verification | `npx tsc --noEmit -p apps/api/tsconfig.json` | 0 errors — all new/modified TypeScript compiles cleanly under `strict`/`NodeNext` after adding explicit `.js` extensions to relative imports. |
| Work Unit 4 RED | `node --import tsx --test tests/smoke.test.mjs` (in `apps/web`) | Failing as expected: `ENOENT`/`ERR_MODULE_NOT_FOUND` for `src/app/app.config.ts`, `src/app/upload/upload-page.ts`, `src/app/results/results-page.ts` — none existed yet in the pre-scaffold tree. |
| Work Unit 4 GREEN | `node --import tsx --test tests/smoke.test.mjs` (in `apps/web`) | 2/2 passing — real Angular app shape confirmed (`bootstrapApplication`, `provideRouter`/`provideHttpClient`, `upload`/`runs/:runId` routes, real `UploadPage`/`ResultsPage` classes). |
| Work Unit 4 TRIANGULATE | `node --import tsx --test tests/upload-validation.test.mjs` (in `apps/web`) | 5/5 passing (valid PDF, valid DOCX, unsupported type, zero files, multiple files). |
| Work Unit 4 full suite | `node --import tsx --test tests/*.test.mjs` (in `apps/web`) | 7 pass / 0 fail. |
| Work Unit 4 static build harness | `pnpm --dir apps/web build` (real `ng build`) | Succeeded — `Application bundle generation complete`, output written to `apps/web/dist/web`. |
| Work Unit 4 manual runtime harness | `pnpm --dir apps/web start --port 4300 --host 127.0.0.1` (real `ng serve`) + `curl` | Dev server booted; `GET /upload` and `GET /runs/run_manual` both returned `200` with the real Angular `index.html` SPA shell (client-side routing renders `UploadPage`/`ResultsPage` in-browser). Process cleanly killed afterward (`pgrep` confirmed no leftovers). |
| PR B final full-repo verification | `pnpm test` (root) | Exit code 0. `apps/api`: 40 pass / 1 skip / 0 fail. `apps/web`: 7 pass / 0 fail. `services/worker`: 1 pass. |

\* **Environment discovery**: this development machine has a pre-existing, project-unrelated Homebrew `postgresql@17` server already bound to `127.0.0.1:5432`/`[::1]:5432` (running since before this session). Docker's own port-forwarding proxy binds `0.0.0.0:5432`, but the OS routes `localhost` connections to the more specific loopback-bound Homebrew process, not the Docker container — causing `role "pg1" does not exist` even though the container is healthy and does have that role. To get genuine live evidence without touching the user's pre-existing local Postgres, `infra/docker-compose.yml`'s host port was temporarily changed to `5433:5432` for the TRIANGULATE run only, then reverted to the canonical `5432:5432` (matching `design.md`'s documented `.env.example` contract) before finishing. **The committed `docker-compose.yml` and documented `DATABASE_URL` both use port 5432, unchanged from design.** Users on machines with a local Postgres already on 5432 will need to stop it or remap the port locally — this is a machine-specific constraint, not a design defect.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| Work Unit 2 — `splitMigration` | `apps/api/tests/migrate-runner.test.mjs` | Unit | ✅ 37/37 (pre-existing API tests, run before any change) | ✅ Written — 2 unit tests reference `splitMigration` from a `migrate.mjs` that did not exist yet, guaranteeing `ERR_MODULE_NOT_FOUND` | ✅ Passed — `pnpm --dir apps/api test` green after implementing `splitMigration`/`migrate.mjs` | ✅ 2 cases (happy-path UP/DOWN parse + malformed-markers explicit-error case) | ✅ Clean — pure function, no side effects, no further extraction needed |
| Work Unit 2 — `migrateUp`/`migrateDown` live integration | `apps/api/tests/migrate-runner.test.mjs` | Integration (live Postgres) | N/A (new file) | ✅ Written — integration test imports `migrateUp`/`migrateDown` from the not-yet-existing `migrate.mjs`, and connects to `DATABASE_URL`; explicit `t.skip(reason)` path when Postgres is unreachable (never silent no-op, never a false pass) | ✅ Passed — executed for real against dockerized Postgres (port 5433 workaround documented above): asserted exactly the 12 required tables + `vector` extension after `up`, and 0 tables + no extension after `down` | ✅ Triangulated by also running the CLI (`migrate.mjs up` / `migrate.mjs down`) manually and independently verifying table/extension counts via `psql` | ✅ Clean — `withClient()` helper extracted to avoid duplicating connect/end logic between `migrateUp` and `migrateDown` |
| Work Unit 1 — `infra/docker-compose.yml` | N/A — infra config, no test framework covers compose files (per `tasks.md`) | N/A | N/A | N/A — RED explicitly marked N/A in `tasks.md` for infra-only config | ✅ Verified operationally — `docker compose up -d db` reached `healthy`; `vector` extension present (proven transitively via Work Unit 2's live migration run) | ✅ Verified `docker compose down -v` cleanly tears down container/network/volume (rollback boundary) | N/A |
| Work Unit 3 — real NestJS transport (`smoke.test.mjs`) | `apps/api/tests/smoke.test.mjs` | Integration (real HTTP, ephemeral port) | ✅ 39/39 pre-existing API tests green before this work | ✅ Written — 2 tests boot `bootstrapApi()` and call `app.listen`, which did not exist on the pre-Nest stub, guaranteeing `TypeError: app.listen is not a function` | ✅ Passed — real `NestFactory`/`app.listen` implemented; both tests pass against a real ephemeral-port HTTP server | ✅ Manually curled all 4 upload spec scenarios (valid/unsupported/zero/multi) + review-run trigger against a live `pnpm --dir apps/api start` process | ✅ Clean — `http-types.ts` extracted to share request/response types across both controllers instead of duplicating |
| Work Unit 4 — Angular app shape (`smoke.test.mjs`) | `apps/web/tests/smoke.test.mjs` | Structural (source assertions) | ✅ 40/1/0 API green + 1 web pass before this work | ✅ Written — asserts real `bootstrapApplication`/`provideHttpClient`/routes/component classes against files that did not exist yet, guaranteeing `ENOENT` | ✅ Passed — real Angular CLI scaffold + feature components implemented | ✅ N/A at the component-shape layer — behavioral triangulation lives in `upload-validation.test.mjs` (below) | ✅ Clean — no refactor needed, scaffold matches design decision #2 exactly |
| Work Unit 4 — client-side upload validation | `apps/web/tests/upload-validation.test.mjs` | Unit (pure function, no Angular runtime) | N/A (new file) | ✅ Written — 5 tests call `validateSelectedFiles` from a not-yet-existing `upload-validation.ts` | ✅ Passed — pure function implemented, all 5 pass | ✅ 5 cases: valid PDF, valid DOCX, unsupported type, zero files, multiple files — directly mirrors the 3 spec scenarios (plus both accepted content types) | ✅ Clean — pure function, no side effects |

### Test Summary
- **PR A — Total tests written**: 3 (`splitMigration` happy path, `splitMigration` missing-markers error, live migration integration test).
- **PR A — Total tests passing**: 40/40 when Docker Postgres is reachable; 39/40 (1 explicit skip, 0 fail) when it is not — both are valid green states for this suite.
- **PR A — Layers used**: Unit (2), Integration (1, live Postgres).
- **PR A — Approval tests** (refactoring): None — no refactoring of existing files in this pass (`migrate.mjs` and its test are net-new).
- **PR A — Pure functions created**: 1 (`splitMigration`).
- **PR B — Total tests written/rewritten**: 9 (2 rewritten `apps/api/tests/smoke.test.mjs` real-HTTP tests, 2 rewritten `apps/web/tests/smoke.test.mjs` structural tests, 5 new `apps/web/tests/upload-validation.test.mjs` unit tests).
- **PR B — Total tests passing**: `apps/api` 40/40 reachable-Postgres-independent tests pass (1 unrelated live-Postgres test still explicitly skips without Docker); `apps/web` 7/7 pass.
- **PR B — Layers used**: Integration (real HTTP server, 2 tests), Structural/source (2 tests), Unit (pure function, 5 tests). Plus non-`pnpm test` manual runtime verification: `curl` against a live NestJS server (7 real HTTP calls covering all upload spec scenarios + review-run trigger), and a live `ng serve` dev server (2 real page loads).
- **PR B — Approval tests** (refactoring): None.
- **PR B — Pure functions created**: 1 (`validateSelectedFiles`).

## Work Unit Evidence

| Work Unit | Focused test command and exact result | Runtime harness command/scenario and exact result | Rollback boundary |
|---|---|---|---|
| 1 — Compose + env contract | N/A (infra only, per `tasks.md`) | `docker compose up -d db` (in `infra/`) → container `pg1-db` reached `healthy`; `docker compose down -v` → container, network, and named volume all removed cleanly (run twice this pass, both clean). | `docker compose down -v`; delete `infra/docker-compose.yml` reverts to no local Postgres infra. |
| 2 — Live migration execution | `pnpm --dir apps/api test` → 39 pass / 1 skip (explicit reason) / 0 fail with Docker down; 40 pass / 0 skip / 0 fail with Docker up on an alternate verification port. | `DATABASE_URL=postgres://pg1:pg1@localhost:5433/pg1 node apps/api/src/db/migrate.mjs up` then `... down`, against the dockerized `pgvector/pgvector:pg16` container from Work Unit 1 — `up` produced exactly 12 tables + `vector` extension (verified via `psql`), `down` reverted to 0 tables. | `node apps/api/src/db/migrate.mjs down` (idempotent `DROP ... IF EXISTS`) + `docker compose down -v`; delete `apps/api/src/db/migrate.mjs` and `apps/api/tests/migrate-runner.test.mjs` — static `schema-migration.test.mjs` coverage from `mvp-academic-review-core` remains untouched and still green. |
| 3 — Real NestJS transport | `pnpm --dir apps/api test` → 40 pass / 1 skip / 0 fail. | `pnpm --dir apps/api start` + `curl` against `127.0.0.1:3999`: valid PDF upload → 201, unsupported type → 415, zero files → 422, multi-file → 422, review-run trigger → 202, list/get routes → 200. | Revert `apps/api/src/main.ts`, `app.module.ts`, `*.controller.ts`, `http-types.ts`, `tsconfig.json` decorator options, and the `@nestjs/*`/`tsx` package.json entries → returns to the pre-Nest stub; `api-contract.mjs`/services are never touched by this rollback. |
| 4 — Angular upload scaffold | `pnpm --dir apps/web test` → 7 pass / 0 fail. | `pnpm --dir apps/web build` (real `ng build`, succeeded) and `pnpm --dir apps/web start` (real `ng serve` on `127.0.0.1:4300`) + `curl` on `/upload` and `/runs/run_manual` → both `200` with the real SPA shell. | Revert `apps/web/src`, `angular.json`, `tsconfig*.json`, `package.json`, `public/` → returns to the placeholder `Pg1AdminApp`/`features/review-dashboard` tree and its original smoke test; no other workspace package is affected. |

## Deviations From Design

- `infra/docker-compose.yml`'s host port mapping (`5432:5432`) exactly matches `design.md`'s documented `DATABASE_URL` contract — no deviation in the committed file. However, live verification on this specific development machine required a temporary port remap to `5433:5432` because a pre-existing, project-unrelated Homebrew `postgresql@17` server already occupies `127.0.0.1:5432`/`[::1]:5432` locally (discovered this session, not caused by this change). This is documented as a machine-specific environment risk below, not a design change.
- No other deviations. `migrate.mjs`'s API shape (`splitMigration`, `migrateUp`, `migrateDown`, CLI `up|down`) matches design decision #7 (`pg` client splitting `-- UP`/`-- DOWN`) exactly.
- The "REFACTOR: share pg client factory with review-repository.mjs" sub-task from `tasks.md` Work Unit 2 is explicitly deferred to Work Unit 7 (PR C), since `review-repository.mjs` does not exist yet in this pass — creating it now would be out of scope for PR A.
- **PR B**: `contract.test.mjs` was intentionally left unmodified rather than converted to real-HTTP calls, per `design.md` decision #1's explicit rationale (preserve the pure-handler seam). `tasks.md`'s RED wording named both `contract.test.mjs`/`smoke.test.mjs`; only `smoke.test.mjs` was rewritten for the real-HTTP boot assertion. See the "Work Unit 3 — Real NestJS Transport" section above for the full rationale. No other deviations in PR B — controllers delegate 100% to existing pure logic, no business logic was reimplemented, and the Angular scaffold matches design decision #2 (standalone, signals-ready, `provideHttpClient`, `/upload` + `/runs/:id` routes) exactly.

## Issues Found

- **Local port 5432 conflict (environment-specific, not a code defect)**: on this machine, a pre-existing Homebrew `postgresql@17` service binds `127.0.0.1:5432` independently of Docker, which intercepts `localhost:5432` connections ahead of Docker's own `0.0.0.0:5432` port-forward. Anyone reproducing this locally with a system Postgres already running on 5432 will see `role "pg1" does not exist` (they're hitting the wrong server) rather than a Docker/compose failure. Documented in Test Commands Run and Risks; no code change needed — this is purely a local-environment note for future contributors and does not affect the canonical `docker-compose.yml`/`DATABASE_URL` contract shipped in this PR.
- **PR B — real-HTTP 404 shape gap (known, not fixed in this pass)**: unmatched routes hit over real HTTP (e.g. `GET /api/v1/unknown`) now return Nest's default Express-style 404 JSON (`{"message":"Cannot GET ...","error":"Not Found","statusCode":404}`) instead of the pure handler's standard error shape (`{error, message, details, request_id, timestamp}`) used by `contract.test.mjs`'s "unsupported routes return the standard error shape" test. That test still passes because it calls `handleApiRequest` directly (unaffected). No spec scenario or `tasks.md` acceptance criterion in Work Unit 3 requires the real-HTTP 404 shape to match, so this was left as-is rather than adding an unscoped catch-all exception filter; flagging it here so a future PR can add a global Nest exception filter mapping unmatched routes to the standard error shape if that's desired.
- **PR B — pnpm build-script approvals required environment config**: this pnpm setup did not accept interactive `pnpm approve-builds` input in this tool environment; explicit `allowBuilds`/`onlyBuiltDependencies` entries were added to `pnpm-workspace.yaml` instead (for `esbuild`, `@parcel/watcher`, `lmdb`, `msgpackr-extract`). This is a one-time, environment-level, non-security-sensitive config change (all four are well-known dev-tooling native modules: esbuild's own binary downloader, Angular CLI's file watcher, and its dev-server cache backend) — not a per-PR concern, but noted for the next contributor who runs `pnpm install` fresh.

## Remaining Tasks

- [ ] Work Unit 5: FastAPI extraction endpoint (PR C).
- [ ] Work Unit 6: Claude CAG module behind `LLMProvider` (PR C).
- [ ] Work Unit 7: Finding/evidence persistence + inline queue orchestration (PR C).
- [ ] Work Unit 8: Angular results/status view (PR D).
- [ ] Work Unit 9: Manual end-to-end verification (PR D).

## Verification Evidence

- Safety-net verification command: `pnpm test` (before any change) → passed 37 API tests, 1 web smoke test, 1 worker unittest — confirms the baseline this pass must not break.
- Work Unit 2 RED verification command: `pnpm --dir apps/api test` → 37 pass, 2 fail (`ERR_MODULE_NOT_FOUND` for missing `migrate.mjs`), 1 skipped (live test auto-skipped).
- Work Unit 2 GREEN verification command (Docker down): `pnpm --dir apps/api test` → 39 pass, 0 fail, 1 skipped (explicit reason).
- Work Unit 1+2 TRIANGULATE verification command (Docker up, alternate port for local-conflict workaround): `DATABASE_URL="postgres://pg1:pg1@localhost:5433/pg1" pnpm --dir apps/api test` → 40 pass, 0 fail, 0 skipped.
- Work Unit 2 manual CLI verification: `migrate.mjs down` → `up` (12 tables + `vector` extension confirmed via `psql`) → `down` (0 tables confirmed via `psql`).
- Interim root verification command (end of PR A): `pnpm test` (Docker down, canonical `5432` port restored in `infra/docker-compose.yml`) → exit code 0; API 39 pass/1 skip/0 fail, web 1 pass, worker 1 pass.
- `docker compose down -v` confirmed to cleanly remove container, network, and volume (rollback boundary for Work Unit 1), executed twice.
- PR B — Work Unit 3 RED/GREEN verification: `node --import tsx --test tests/smoke.test.mjs` (in `apps/api`) → 2 fail (RED, `app.listen is not a function`) → 2 pass (GREEN, real HTTP server bound to `127.0.0.1`).
- PR B — Work Unit 3 full-suite verification: `node --import tsx --test tests/*.test.mjs` (in `apps/api`) → 40 pass / 1 skip / 0 fail.
- PR B — Work Unit 3 static verification: `npx tsc --noEmit -p apps/api/tsconfig.json` → 0 errors.
- PR B — Work Unit 3 manual runtime verification: `pnpm --dir apps/api start` + `curl` → all 4 upload spec scenarios (valid/unsupported/zero/multi) plus review-run trigger and list/get routes returned the correct status codes and bodies over real HTTP.
- PR B — Work Unit 4 RED/GREEN verification: `node --import tsx --test tests/smoke.test.mjs` (in `apps/web`) → `ENOENT` failures (RED, pre-scaffold) → 2 pass (GREEN, real Angular app shape).
- PR B — Work Unit 4 TRIANGULATE verification: `node --import tsx --test tests/upload-validation.test.mjs` (in `apps/web`) → 5/5 pass.
- PR B — Work Unit 4 full-suite verification: `node --import tsx --test tests/*.test.mjs` (in `apps/web`) → 7 pass / 0 fail.
- PR B — Work Unit 4 build/runtime harness: `pnpm --dir apps/web build` (real `ng build`) succeeded; `pnpm --dir apps/web start` (real `ng serve`) + `curl` on `/upload` and `/runs/run_manual` both returned `200` with the real SPA shell; dev server process confirmed cleanly killed afterward.
- PR B — Final root verification command: `pnpm test` → exit code 0; `apps/api` 40 pass/1 skip/0 fail, `apps/web` 7 pass/0 fail, `services/worker` 1 pass.
