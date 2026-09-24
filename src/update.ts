// Self-update on launch: if GitHub has a newer release, swap it in over this install.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { samePath } from './disk.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASES = 'https://github.com/hallygtree/maestro/releases';
const TMP = path.join(ROOT, '.update');
const TRASH = path.join(ROOT, '.trash');

// Only upgrades: a different but older (or odd) tag never triggers a download.
export function newer(a: string, b: string) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// True when a new version was installed and Maestro should relaunch itself.
export async function update() {
  // Only the installed bundle (its own node next to src/) updates; a git checkout never does.
  if (process.env.MAESTRO_NO_UPDATE || !samePath(path.dirname(process.execPath), ROOT)) return false;
  try { fs.rmSync(TRASH, { recursive: true, force: true }); } catch {} // still held by another Maestro
  try {
    // The /latest redirect names the tag without the rate-limited API.
    const res = await fetch(`${RELEASES}/latest`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    const tag = res.headers.get('location')?.match(/\/tag\/(v[^/]+)$/)?.[1];
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    if (!tag || !newer(tag.slice(1), current)) return false;

    console.log(`Updating Maestro ${current} → ${tag.slice(1)}…`);
    const url = `${RELEASES}/download/${tag}/maestro-${process.platform}-${process.arch}.tar.gz`;
    const tgz = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!tgz.ok) throw new Error(`${url}: HTTP ${tgz.status}`);
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'maestro.tar.gz'), Buffer.from(await tgz.arrayBuffer()));
    // Windows' own tar: Git's GNU tar, if first on PATH, reads "C:\..." as a remote host.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', path.join(TMP, 'maestro.tar.gz'), '-C', TMP]);

    // Windows won't overwrite a running node.exe or a loaded .node, but lets them be moved aside.
    // ponytail: files dropped by the new release stay behind; prune if one ever matters.
    const src = path.join(TMP, 'maestro');
    let n = 0;
    for (const rel of fs.readdirSync(src, { recursive: true }) as string[]) {
      const from = path.join(src, rel), to = path.join(ROOT, rel);
      if (fs.lstatSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); continue; }
      try { fs.renameSync(from, to); } catch {
        fs.mkdirSync(TRASH, { recursive: true });
        fs.renameSync(to, path.join(TRASH, `${Date.now()}-${n++}`));
        fs.renameSync(from, to);
      }
    }
    fs.rmSync(TMP, { recursive: true, force: true });
    return true;
  } catch (e) {
    if (fs.existsSync(TMP)) console.error(`Maestro update failed (${(e as Error).message}). Run the installer again to update.`);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    return false;
  }
}
