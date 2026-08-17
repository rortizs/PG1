# PG1 — Plataforma de revisión de tesis asistida por IA

Proyecto de graduación, Facultad de Ingeniería en Sistemas de Información y
Ciencias de la Computación, Universidad Mariano Gálvez. Historial y visión
del proyecto en [`HISTORY.md`](HISTORY.md); normativa de cátedra en
[`docs/normativa-catedra.md`](docs/normativa-catedra.md).

## Qué hace

Un revisor sube la tesis (PDF o DOCX, máx. 20 MB) desde la vista de detalle
de un estudiante. El pipeline de revisión corre dos vías independientes
sobre el mismo documento:

- **Revisión LLM (CAG)** — revisión asistida por IA (Anthropic Claude) que
  produce hallazgos con evidencia y ubicación (página/sección), ahora
  reforzada con **retrieval real sobre pgvector**: se recuperan los
  segmentos normativos más similares al contenido de la tesis y se inyectan
  como contexto en el prompt de revisión (`apps/api/src/embeddings/`,
  migración `0005_normative_rag_indexes.sql`), con trazabilidad de qué
  segmentos se usaron en cada hallazgo.
- **Motor de reglas determinístico** — sin llamadas a LLM (`services/worker/app/rules/`):
  muletillas, oraciones largas, ortografía en español, estructura del
  documento y verificación de citas.

Ambas vías son independientes: si una falla, la otra sigue produciendo
resultados. Los hallazgos se persisten en Postgres y se pueden descargar
como reporte en Markdown.

Un tablero Kanban (`/review-board`) sigue a cada estudiante a través de los
estados `Pending → In Review → Reviewed → Approved`, con prioridad
`Low/Normal/Urgent`. El estado `Approved` lo define únicamente un revisor
humano — nunca se marca automáticamente.

## Arquitectura

| Servicio | Stack | Rol |
|---|---|---|
| [`apps/api`](apps/api) | NestJS 11, `pg`, TypeScript vía `tsx` | API REST, orquestación del pipeline de revisión, persistencia |
| [`apps/web`](apps/web) | Angular 20 (standalone, signals) | Tablero de revisión, subida de tesis, descarga de reportes |
| [`services/worker`](services/worker) | Python 3.11, FastAPI, Anthropic SDK | Extracción de texto, revisión CAG/RAG, motor de reglas |

Postgres con la extensión `pgvector` es la base de datos compartida
(`infra/docker-compose.yml`).

## Estructura del repo

```
apps/api/            NestJS: contrato de API, jobs, repositorio, migraciones
apps/web/             Angular: páginas del tablero y de subida
services/worker/      FastAPI: extracción, CAG/RAG, reglas
infra/                docker-compose para Postgres + pgvector
data/academic-rules/  Corpus normativo extraído (texto plano, usado por RAG)
docs/                 Runbooks, guía de testing, OpenAPI, PDFs normativos fuente
openspec/             Cambios spec-driven development (ver abajo)
scripts/              Utilidades de repo (smoke tests, etc.)
```

## Cómo correrlo en local

Prerrequisitos: Docker, Node.js 22+ con `pnpm`, Python 3.11+.

```bash
# 1. Levantar Postgres + pgvector
docker compose -f infra/docker-compose.yml up -d

# 2. Migrar el esquema
DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1 node apps/api/src/db/migrate.mjs up

# 3. Crear .env en la raíz (no se autocarga — sourcealo antes de levantar api/worker)
#    DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1
#    ANTHROPIC_API_KEY=sk-ant-...
#    WORKER_BASE_URL=http://localhost:8000
set -a && source .env && set +a

# 4. Worker (terminal aparte)
cd services/worker && uvicorn app.main:app --host 127.0.0.1 --port 8000

# 5. API (terminal aparte)
cd apps/api && node --import tsx src/main.ts   # PORT por defecto: 3000

# 6. Web (terminal aparte)
cd apps/web && pnpm start   # ng serve, proxy hacia la API
```

Runbook completo de verificación manual end-to-end:
[`docs/mvp-vertical-slice-runbook.md`](docs/mvp-vertical-slice-runbook.md).

## Testing

```bash
pnpm test                       # smoke tests de todo el repo
pnpm --filter @pg1/api test     # NestJS API (node --test)
pnpm --filter @pg1/web test     # Angular (node --test sobre helpers puros)
cd services/worker && pnpm test # o: python3 -m unittest discover -s tests -p 'test_*.py'
```

Guía de testing: [`docs/testing.md`](docs/testing.md).

## Desarrollo con SDD (OpenSpec)

Cada feature relevante se planifica como un *change* bajo `openspec/changes/`
(explore → proposal → spec → design → tasks → apply → verify → archive)
antes de implementarse. Cambios archivados quedan en
`openspec/changes/archive/` como historial de decisiones.

Activos/recientes:

- `functional-review-board-rag` — tablero Kanban y retrieval real con pgvector.
- `precise-thesis-review-pipeline` — detección de secciones y motor de reglas (en curso).
- `mvp-academic-review-core` — fundamentos de precisión académica y trazabilidad de evidencia.

Archivados: `mvp-vertical-slice`, `llm-provider-admin`.

## Documentación adicional

- [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — contrato de la API.
- [`docs/guias/`](docs/guias) — PDFs normativos fuente (APA, guía GT, plantilla de graduación).
- [`data/academic-rules/`](data/academic-rules) — texto extraído de esos PDFs, usado como corpus normativo para RAG.
