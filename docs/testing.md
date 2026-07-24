# Testing

Run all scaffold smoke tests from the repository root:

```bash
pnpm test
```

This command runs:

- `apps/api` smoke tests for the NestJS-compatible API scaffold.
- `apps/web` smoke tests for the Angular-compatible admin scaffold.
- `services/worker` smoke tests for the FastAPI-compatible worker scaffold.
