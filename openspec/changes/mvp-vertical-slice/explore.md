# Exploration — MVP Vertical Slice (Upload → CAG Review → Persist → UI)

## Trigger

User reprioritization: instead of continuing the strict Work-Unit-6-onward sequence from
`mvp-academic-review-core`, stand up a thin **end-to-end** slice that actually runs: upload a
real thesis through a real UI, run at least one real RAG or CAG review check, persist the
result to a real PostgreSQL database, and see it in the UI.

## Current State (verified by direct file reads, not by design docs)

- `apps/api/src/main.ts` returns a string, never calls `.listen()`. `app.module.ts` and both
  `*.controller.ts` files are plain classes holding a `routes: string[]` array — zero NestJS
  decorators or DI.
- Business logic is already framework-agnostic and reusable as-is: `upload-service.mjs`,
  `storage/object-storage.mjs` (in-memory `Map`), `review-runs/review-run-lifecycle.mjs`,
  `jobs/review-queue.mjs` (in-memory BullMQ-shaped queue). Nothing persists to Postgres yet.
- `apps/web/src/app/*` are placeholder consts/classes. No `angular.json`, no `index.html`, no
  `@angular/core` dependency — no real Angular CLI scaffold at all. **Largest real-vs-stub gap
  of the three services.**
- `services/worker/app/main.py`'s `create_app()` returns a plain dict — no FastAPI import.
  Easiest of the three to make real.
- `apps/api/src/db/migrations/0001_schema_baseline.sql` defines all 12 tables with
  `embedding vector(1536)`, but was only ever validated via static string/regex tests — **never
  executed against a live Postgres.**
- `pnpm-lock.yaml` importers are `{}` for every package — zero npm deps ever installed.
  `services/worker/pyproject.toml` has `dependencies = []`.
- No `.env`, `.env.example`, `docker-compose.yml`, or `Dockerfile` anywhere. No env-var
  contract has been named yet (`ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `GROQ_API_KEY` /
  `DATABASE_URL` all absent from the repo and from the shell environment).
- Normative corpus `data/academic-rules/*.txt` = 4 files, 1,302 non-blank lines total — small
  enough to fit whole into a single LLM call; no chunking/embeddings required for that corpus.

## Environment Pre-flight (run by orchestrator, Bash-verified)

| Tool | Result |
|---|---|
| Docker | 28.3.2 — available |
| Docker Compose | v2.39.1 — available |
| Node | v22.19.0 — available |
| pnpm | 11.2.2 — matches `packageManager` pin |
| Python | 3.14.6 — satisfies `requires-python >=3.11` |
| `psql` (host binary) | not installed — not required; Postgres will run in Docker |
| LLM API keys (`ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY`/`GROQ_API_KEY`) | **none present** — blocking, needs user-supplied credential |
| `.env` / `.env.example` | none exist |

**Conclusion**: local tooling is fully sufficient (Docker+Compose can run Postgres+pgvector
without any host install). The only real blocker is that **no LLM provider API key exists
anywhere** — the user must supply at least one before the "review check" step can call a real
model.

## Approaches Considered

### 1. CAG — stuff the normative corpus into prompt context (recommended for this slice)
- No pgvector/embedding-provider decision needed to ship a working check.
- No live migration blocking the demo's core AI call.
- ~1,300-line corpus fits in one call to Claude, DeepSeek, or Groq.
- Fastest path to a genuinely working end-to-end finding.
- Not literal `hhhuang/CAG` KV-cache reuse; provider-native prompt caching (Anthropic prompt
  caching, DeepSeek context caching) can be layered in later purely as a cost optimization
  without changing the functional path.
- Effort: Low.

### 2. Minimal RAG — embed `normative_segment` + pgvector + retrieve
- Matches the already-accepted `mvp-academic-review-core/design.md` controlled-RAG
  architecture and reuses `normative_segment`/`embedding_record` tables as designed.
- Requires live Postgres + migration executed + an embedding model decision (still open per
  `openspec/decisions/0002-llm-provider-strategy.md`) + chunking strategy before any retrieval
  works at all.
- Effort: Medium-High.

**Recommendation**: CAG first for the MVP's one working review check (normative-source
grounding), explicitly deferring pgvector/embedding RAG to a later slice — the schema already
reserves the tables, so nothing is thrown away.

## Affected Areas

- `apps/api/src/main.ts`, `app.module.ts`, `*.controller.ts` — real NestJS wiring
  (`@nestjs/core`/`common`/`platform-express`, real `@Module`/`@Controller`, `app.listen()`);
  underlying services reusable almost as-is.
- `apps/web/*` — real Angular CLI scaffold; current files are placeholder shape, effectively a
  rewrite. `angular-cli` MCP tool available in-session and should drive this.
- `services/worker/app/main.py` — trivial: replace dict with real `FastAPI()`.
- `apps/api/src/db/migrations/0001_schema_baseline.sql` — first-ever live execution; migration
  runner and Postgres client (`pg`/`postgres.js`) undecided (zero deps today).
- `infra/` — needs a real `docker-compose.yml` (Postgres+pgvector, optionally Redis) from
  scratch.
- New: `.env.example` for `DATABASE_URL` + at least one LLM provider key — none exists today.

## Risks

- Skipping real Redis/BullMQ for this slice (synchronous processing instead) diverges from the
  already-accepted `design.md` queue architecture — needs explicit sign-off as a deliberate
  demo-scope shortcut, not a silent swap.
- Angular has the largest real-vs-stub gap — highest risk of scope/estimate overrun.
- Empty `pnpm-lock.yaml` means the first real `pnpm install` produces a large lockfile diff —
  isolate to its own PR.
- `0001_schema_baseline.sql` has never run against live Postgres — first real execution may
  surface issues static tests couldn't catch.
- No LLM API key present anywhere — user must supply at least one out-of-band.

## Suggested PR Chain

1. **PR A** — `docker-compose.yml` (Postgres+pgvector), migration execution, Postgres client
   wiring, `.env.example`.
2. **PR B** — real NestJS transport + real Angular upload scaffold (reusing existing
   framework-light service logic behind real controllers).
3. **PR C** — text extraction (minimal) + CAG normative-review call + evidence/finding
   persistence.
4. **PR D** — Angular findings/status view reading persisted results.

Does not fit in a single ≤400-line PR.

## Ready for Proposal

Yes, with one explicit pre-req: the user must supply at least one real LLM provider API key
(Claude, DeepSeek, or Groq) before `sdd-design` can commit the CAG review-call implementation.
