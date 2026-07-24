import { spawnSync } from 'node:child_process';

const commands = [
  ['pnpm', ['--dir', 'apps/api', 'test']],
  ['pnpm', ['--dir', 'apps/web', 'test']],
  ['pnpm', ['--dir', 'services/worker', 'test']],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
