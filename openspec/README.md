# OpenSpec Context — PG1

Este directorio guarda la configuración SDD del proyecto.

## Inicialización aplicada

- Modo SDD: `auto`
- Almacenamiento de artefactos: `OpenSpec + Engram`
- Estrategia PR: `auto-forecast`
- Presupuesto de revisión: `400` líneas
- Modo TDD: `strict_tdd=true` (con comando placeholder `pytest -q`)

## Alcance actual

- Ingesta de tesis: **one-to-one upload**
- Integración OneDrive: **fuera de alcance por ahora**
- Hoja de ruta IA: **RAG controlado primero**, luego **RAG agéntico**

## Nota de stack recomendada

- Frontend: Angular + Ionic (o Angular-only admin)
- Backend API: NestJS + TypeScript
- Worker documental/IA: Python FastAPI
- DB: PostgreSQL + pgvector
- Cola: Redis + BullMQ (Temporal opcional después)
- Storage: Local/S3-compatible
- Proveedor IA: abstracción neutral por proveedor; OpenAI queda fuera del stack recomendado
- LLMs recomendados: Claude, DeepSeek y Groq
