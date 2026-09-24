// Sessões gerenciadas: o Maestro abre o agente num pseudoterminal próprio, então consegue digitar nele.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Agent } from './disk.ts';

// preexisting: sessões já vivas quando esta foi aberta (não podem ser confundidas com ela).
export interface Managed { agent: Agent; cwd: string; id?: string; title: string; proc: IPty; preexisting?: Set<string> }
export const managed: Managed[] = [];
let detachCurrent: (() => void) | undefined;
let attached: Managed | undefined;
let onExitCb = () => {};
export const onManagedExit = (cb: () => void) => { onExitCb = cb; };

// Shim do npm (.cmd) → alvo real, pra passar o prompt como argv sem as regras de aspas do cmd.exe.
export function shimTarget(cmdText: string, dir: string): [string, string[]] | undefined {
  const m = [...cmdText.matchAll(/"%dp0%\\([^"]+)"/g)].at(-1); // a última é a linha que executa; antes vem o IF EXIST node.exe
  if (!m) return;
  const target = path.join(dir, m[1]);
  return target.endsWith('.js') ? [process.execPath, [target]] : [target, []];
}

function resolve(name: string): [string, string[]] {
  if (process.platform !== 'win32') return [name, []];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const exe = path.join(dir, name + '.exe');
    if (fs.existsSync(exe)) return [exe, []];
    const cmd = path.join(dir, name + '.cmd');
    const t = fs.existsSync(cmd) && shimTarget(fs.readFileSync(cmd, 'utf8'), dir);
    if (t) return t;
  }
  return [name, []];
}

function args(agent: Agent, resumeId?: string, prompt?: string): string[] {
  const p = prompt ? [prompt] : [];
  if (agent === 'claude') return resumeId ? ['--resume', resumeId, ...p] : p;
  if (agent === 'codex') return resumeId ? ['resume', resumeId, ...p] : p;
  return [...(resumeId ? ['--conversation', resumeId] : []), ...(prompt ? ['-i', prompt] : [])];
}

// Marcadores que um Claude pai injeta. Herdados, fazem o agente filho se achar subsessão e não salvar transcript.
const PARENT_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID',
];
const childEnv = () => {
  const env = { ...process.env } as Record<string, string>;
  for (const k of PARENT_MARKERS) delete env[k];
  return env;
};

export function spawn(agent: Agent, cwd: string, opts: { resumeId?: string; prompt?: string } = {}): Managed {
  const [file, pre] = resolve(agent);
  const a = args(agent, opts.resumeId, opts.prompt);
  let id = opts.resumeId;
  if (agent === 'claude' && !id) a.unshift('--session-id', (id = randomUUID())); // id conhecido desde o início
  const proc = pty.spawn(file, [...pre, ...a], {
    name: 'xterm-256color', cwd, env: childEnv(),
    cols: process.stdout.columns || 120, rows: process.stdout.rows || 30,
  });
  const m: Managed = { agent, cwd, id, title: '', proc };
  proc.onData((d) => {
    const t = [...d.matchAll(/\x1b\][02];([^\x07\x1b]*)/g)].at(-1)?.[1];
    // ignora o título inicial do ConPTY (caminho do .exe) e tira o spinner que alguns agentes põem na frente
    if (t && !/\.exe$/i.test(t)) m.title = t.replace(/^[^\p{L}\p{N}]+/u, '');
    if (attached === m) process.stdout.write(d);
  });
  proc.onExit(() => {
    managed.splice(managed.indexOf(m), 1);
    if (attached === m) detachCurrent?.();
    onExitCb();
  });
  managed.push(m);
  return m;
}

export function send(m: Managed, text: string) {
  m.proc.write(text);
  setTimeout(() => m.proc.write('\r'), 150); // Enter separado, senão vira quebra de linha dentro do "paste"
}

// No Windows o ConPTY do agente pede win32-input-mode (?9001h): cada tecla vira ESC[Vk;Sc;Uc;Kd;Cs;Rc_.
// Ligamos esse modo ao entrar (preserva Shift+Enter etc.) e reconhecemos Ctrl+Q nos dois formatos.
const WIN = process.platform === 'win32';
export const isDetachKey = (s: string) => s.includes('\x11') || /\x1b\[81;\d+;17;1;/.test(s);

const RESET = '\x1b[?9001l\x1b[?1004l\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m\x1b[<u';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

// Entra na sessão: o terminal inteiro passa a ser do agente até Ctrl+Q.
// ponytail: sem emulador de terminal no meio; o redesenho vem de um "resize" forçado.
// Modos que o agente ligou antes (mouse, bracketed paste) não são reativados ao voltar. Upgrade: @xterm/headless.
export function attach(m: Managed): Promise<void> {
  const { stdin, stdout } = process;
  return new Promise((done) => {
    const onKey = (b: Buffer | string) => {
      const s = b.toString();
      if (isDetachKey(s)) return detachCurrent?.();
      m.proc.write(s);
    };
    const swallow = () => {}; // key-ups que ainda chegam depois do Ctrl+Q não podem vazar pro painel
    const onResize = () => m.proc.resize(stdout.columns, stdout.rows);
    detachCurrent = () => {
      detachCurrent = attached = undefined;
      stdin.off('data', onKey);
      stdin.on('data', swallow);
      stdout.off('resize', onResize);
      stdout.write(RESET + CLEAR);
      setTimeout(() => {
        stdin.off('data', swallow);
        stdin.setRawMode(false);
        stdin.pause();
        done();
      }, 200);
    };
    attached = m;
    stdout.write(CLEAR + (WIN ? '\x1b[?9001h\x1b[?1004h' : ''));
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    stdout.on('resize', onResize);
    m.proc.resize(stdout.columns, Math.max(2, stdout.rows - 1));
    setTimeout(onResize, 60);
  });
}

// No Windows o kill() do node-pty às vezes imprime "AttachConsole failed" por cima da tela; taskkill /T derruba a árvore em silêncio.
export const killAll = () => {
  for (const m of [...managed]) {
    try {
      if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(m.proc.pid)], { stdio: 'ignore' });
      else m.proc.kill();
    } catch {} // já tinha saído
  }
};
