// Descobre sessões vivas lendo o que cada agente já grava em disco. Nada é instalado nos agentes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Agent = 'claude' | 'codex' | 'agy';
export type Status = 'busy' | 'waiting' | 'idle';
export interface Session {
  agent: Agent;
  id: string;
  cwd: string;
  title: string;
  status: Status;
  model?: string;
  detail?: string;
}

const home = (...p: string[]) => path.join(os.homedir(), ...p);
const MODEL = /"model":"([^"]+)"/g;

const readJson = (file: string): any => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};
const readJsonl = (file: string): any[] => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
};
const list = (dir: string, ext: string) => {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return []; }
};

function tail(file: string, bytes = 65536): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(bytes, size), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function firstLine(file: string): any {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1 << 20), n = fs.readSync(fd, buf, 0, buf.length, 0), s = buf.toString('utf8', 0, n);
      return JSON.parse(s.slice(0, s.indexOf('\n') + 1 || undefined));
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}

const lastMatch = (s: string, re: RegExp) => [...s.matchAll(re)].at(-1)?.[1];

// Modelo: procura no fim do log; se não achar, lê o arquivo inteiro uma vez e guarda.
const models = new Map<string, string | undefined>();
function modelOf(file: string, log: string): string | undefined {
  const m = lastMatch(log, MODEL);
  if (m) models.set(file, m);
  else if (!models.has(file)) { try { models.set(file, lastMatch(fs.readFileSync(file, 'utf8'), MODEL)); } catch { models.set(file, undefined); } }
  return models.get(file);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Codex e agy seguram um lock de intervalo de bytes no arquivo enquanto a sessão está aberta: ler dá EBUSY.
// ponytail: só vale no Windows (no Unix esses locks são advisory); em outro SO, trocar por checagem de processo.
export function isLocked(file: string): boolean {
  let fd: number | undefined;
  try { fd = fs.openSync(file, 'r'); fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); return false; }
  catch (e: any) { return e.code === 'EBUSY'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ~/.claude/sessions/<pid>.json é mantido pelo próprio Claude Code com status ao vivo.
function claude(): Session[] {
  const dir = home('.claude', 'sessions');
  return list(dir, '.json').flatMap((f) => {
    const s = readJson(path.join(dir, f));
    if (!s?.sessionId || s.kind !== 'interactive' || !alive(s.pid)) return [];
    const transcript = home('.claude', 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), s.sessionId + '.jsonl');
    return [{
      // além de idle/waiting o Claude usa busy, shell etc. — tudo isso é "rodando"
      agent: 'claude', id: s.sessionId, cwd: s.cwd, title: s.name ?? '',
      status: s.status === 'waiting' || s.status === 'idle' || !s.status ? s.status ?? 'idle' : 'busy',
      detail: s.waitingFor, model: modelOf(transcript, tail(transcript)),
    } satisfies Session];
  });
}

// Status do Codex = último evento de turno no rollout.
// ponytail: não detecta pedido de aprovação (não vai pro rollout); aparece como "rodando".
export function codexStatus(log: string, mtimeMs: number, now = Date.now()): Status {
  const started = log.lastIndexOf('"type":"task_started"'), done = log.lastIndexOf('"type":"task_complete"');
  if (started !== -1 || done !== -1) return started > done ? 'busy' : 'idle';
  return now - mtimeMs < 30_000 ? 'busy' : 'idle'; // turno longo empurrou os eventos pra fora do tail
}

const rollouts = new Map<string, string>();
function codexRollout(id: string): string | undefined {
  if (rollouts.has(id)) return rollouts.get(id);
  const root = home('.codex', 'sessions');
  const desc = (d: string) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    const f = desc(path.join(root, y, m, d)).find((f) => f.endsWith(id + '.jsonl'));
    if (f) { rollouts.set(id, path.join(root, y, m, d, f)); return rollouts.get(id); }
  }
}

function codex(): Session[] {
  const locks = home('.codex', 'thread-writer-locks');
  const live = list(locks, '.lock').map((f) => f.slice(0, -5)).filter((id) => isLocked(path.join(locks, id + '.lock')));
  if (!live.length) return [];
  const names = new Map(readJsonl(home('.codex', 'session_index.jsonl')).map((r) => [r.id, r.thread_name]));
  const prompts = new Map<string, string>();
  for (const r of readJsonl(home('.codex', 'history.jsonl'))) if (!prompts.has(r.session_id)) prompts.set(r.session_id, r.text);
  return live.flatMap((id) => {
    const file = codexRollout(id), meta = file && firstLine(file)?.payload;
    if (!file || !meta || meta.parent_thread_id || meta.source?.subagent) return []; // ignora subagentes (guardian etc.)
    const log = tail(file);
    return [{
      agent: 'codex', id, cwd: meta.cwd, title: names.get(id) ?? prompts.get(id) ?? '',
      status: codexStatus(log, fs.statSync(file).mtimeMs), model: modelOf(file, log),
    } satisfies Session];
  });
}

function agy(): Session[] {
  const base = home('.gemini', 'antigravity-cli'), presence = path.join(base, 'presence');
  const live = list(presence, '.lock').map((f) => f.slice(0, -5)).filter((id) => isLocked(path.join(presence, id + '.lock')));
  if (!live.length) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(base, 'conversation_summaries.db'), { readOnly: true });
    const q = db.prepare('select title, workspace_uris, status from conversation_summaries where conversation_id = ?');
    return live.map((id) => {
      const r = q.get(id) as any;
      const uri = r && JSON.parse(r.workspace_uris)[0];
      const status: Status = /RUNNING|BUSY/.test(r?.status) ? 'busy' : /WAIT|PENDING/.test(r?.status) ? 'waiting' : 'idle';
      return { agent: 'agy', id, cwd: uri ? decodeURIComponent(new URL(uri).pathname).replace(/^\/(\w:)/, '$1').replaceAll('/', path.sep) : '', title: r?.title ?? '', status };
    });
  } catch { return []; } finally { db?.close(); }
}

export const liveSessions = (): Session[] => [...claude(), ...codex(), ...agy()];

export const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

// Diretórios onde algum agente já foi usado (sugestões para nova sessão).
export function knownDirs(): string[] {
  const toml = (() => { try { return fs.readFileSync(home('.codex', 'config.toml'), 'utf8'); } catch { return ''; } })();
  const all: string[] = [
    ...Object.keys(readJson(home('.claude.json'))?.projects ?? {}).map((p) => path.resolve(p)),
    ...[...toml.matchAll(/^\[projects\.['"](.+?)['"]\]/gm)].map((m) => m[1]),
    ...(readJson(home('.gemini', 'antigravity-cli', 'settings.json'))?.trustedWorkspaces ?? []),
  ];
  const out: string[] = [];
  for (const d of all) if (!out.some((o) => samePath(o, d)) && fs.existsSync(d)) out.push(d);
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
