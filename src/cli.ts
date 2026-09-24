#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { update } from './update.ts';

if (await update()) {
  // Relaunch on the new files; the UI (and node-pty) were never loaded here.
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const { run } = await import('./ui.ts');
await run();
