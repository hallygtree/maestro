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

// ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl, do dia mais novo pro mais velho.
function* rolloutFiles() {
  const root = home('.codex', 'sessions');
  const desc = (d: string) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m)))
    for (const f of desc(path.join(root, y, m, d))) if (f.endsWith('.jsonl')) yield path.join(root, y, m, d, f);
}

const rollouts = new Map<string, string>();
function codexRollout(id: string): string | undefined {
  if (rollouts.has(id)) return rollouts.get(id);
  for (const f of rolloutFiles()) if (f.endsWith(id + '.jsonl')) { rollouts.set(id, f); return f; }
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

// ── Limites de uso do plano: os mesmos números reais que o Trayce mostra ──
export interface Limit { label: string; pct: number; resetsAt?: number }
const WEEK = 7 * 86_400_000;

// Leitura de antes do reset não diz nada da janela nova: ela está zerada.
const limit = (label: string, pct: number, resetsAt: number | undefined, now: number): Limit =>
  resetsAt && resetsAt <= now ? { label, pct: 0 } : { label, pct: Math.round(pct), resetsAt };
const secs = (s: unknown) => (typeof s === 'number' && s > 0 ? s * 1000 : undefined);

// Codex grava o rate_limits do servidor em todo evento token_count do rollout.
export const codexLimits = (rl: any, now = Date.now()): Limit[] =>
  ['primary', 'secondary'].flatMap((k) => {
    const w = rl?.[k], m = w?.window_minutes;
    if (typeof w?.used_percent !== 'number' || !m) return [];
    return [limit(m === 10080 ? '7d' : m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`, w.used_percent, secs(w.resets_at), now)];
  });

// Snapshot do status line do Claude, gravado pelo Trayce (trayce --setup-claude).
export function claudeLimits(snap: any, now = Date.now()): Limit[] {
  if (!snap?.rate_limits || !(now - Date.parse(snap.seen_at) <= WEEK)) return [];
  return ([['five_hour', '5h'], ['seven_day', '7d']] as const).flatMap(([k, label]) => {
    const w = snap.rate_limits[k], p = w?.used_percentage;
    // o Claude Code já mandou um epoch nesse campo
    return typeof p === 'number' && p >= 0 && p <= 1000 ? [limit(label, p, secs(w.resets_at), now)] : [];
  });
}

// Cota do app desktop do Antigravity, guardada pelo Trayce. Só o primeiro grupo (Gemini), como no Trayce.
export function agyLimits(cache: any, now = Date.now()): Limit[] {
  const buckets: any[] = Array.isArray(cache?.buckets) ? cache.buckets : [];
  return buckets.filter((b) => b.group === buckets[0].group && typeof b.remaining_fraction === 'number').map((b) =>
    limit(/7d/.test(b.label) ? '7d' : /5h/.test(b.label) ? '5h' : b.label,
      (1 - Math.min(1, Math.max(0, b.remaining_fraction))) * 100, b.reset_time ? Date.parse(b.reset_time) : undefined, now));
}

// Mesmo lugar que o dirs::data_dir() do Trayce.
const trayce = (file: string) => path.join(
  process.platform === 'win32' ? process.env.APPDATA ?? home('AppData', 'Roaming')
  : process.platform === 'darwin' ? home('Library', 'Application Support')
  : process.env.XDG_DATA_HOME ?? home('.local', 'share'), 'trayce', file);

// Rollout mais recentemente escrito que tenha um snapshot (retomar sessão antiga escreve no arquivo antigo).
function codexUsage(now: number): Limit[] {
  const files = [...rolloutFiles()].flatMap((f) => { try { return [{ f, t: fs.statSync(f).mtimeMs }]; } catch { return []; } })
    .filter((x) => now - x.t < WEEK).sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    const line = tail(f).split('\n').reverse().find((l) => l.includes('"rate_limits"') && l.includes('"primary"'));
    try { if (line) return codexLimits(JSON.parse(line).payload.rate_limits, now); } catch {}
  }
  return [];
}

export const usage = (now = Date.now()): Record<Agent, Limit[]> => ({
  claude: claudeLimits(readJson(trayce('claude_rate_limits.json')), now),
  codex: codexUsage(now),
  agy: agyLimits(readJson(trayce('antigravity_quota.json')), now),
});

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
