import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pg1ApiModule } from './app.module.js';

declare const process: {
  env: { PORT?: string };
  argv: string[];
};

/**
 * Real NestJS bootstrap for the PG1 API. This is the NestJS-compatible
 * transport layer: it wraps the existing pure handler/service logic
 * (`api-contract.mjs`, `upload-service.mjs`, `review-run-lifecycle.mjs`)
 * without rewriting it.
 */
export async function bootstrapApi(): Promise<NestExpressApplication> {
  return NestFactory.create<NestExpressApplication>(Pg1ApiModule, {
    logger: false,
  });
}

async function main() {
  const app = await bootstrapApi();
  const port = Number(process.env.PORT ?? 3000);
  // Bind to localhost only: this MVP slice never exposes the API beyond the
  // developer's machine, and there is no reverse proxy in front of it yet.
  await app.listen(port, '127.0.0.1');
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}
