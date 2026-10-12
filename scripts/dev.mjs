import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

// Development metadata is isolated; scanning the user's Skills is read-only.
const dataDir = join(tmpdir(), 'skill-shelf-magpie-dev');
await mkdir(dataDir, { recursive: true });
const children = [
  spawn(process.execPath, ['src/cli.mjs', '--data-dir', dataDir, '--no-open', '--dev'], { stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'vite'], { stdio: 'inherit' }),
];
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
for (const child of children) {
  child.once('error', (error) => { console.error(error.message); stop(); process.exitCode = 1; });
  child.once('exit', (code) => { if (code) process.exitCode = code; stop(); });
}
