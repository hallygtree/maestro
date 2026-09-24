// Sessões gerenciadas: o Maestro abre o agente num pseudoterminal próprio, então consegue digitar nele.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
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

// Modos que cada CLI aceita na inicialização. Só entra o que o agente suporta; o primeiro é sempre a config dele.
export const MODES: Record<Agent, { label: string; args: string[] }[]> = {
  claude: [
    { label: 'Padrão (config do agente)', args: [] },
    { label: 'Manual', args: ['--permission-mode', 'manual'] },
    { label: 'Aceitar edições', args: ['--permission-mode', 'acceptEdits'] },
    { label: 'Plan', args: ['--permission-mode', 'plan'] },
    { label: 'Auto', args: ['--permission-mode', 'auto'] },
    { label: 'Sem permissões', args: ['--permission-mode', 'bypassPermissions'] },
  ],
  codex: [
    { label: 'Padrão (config do agente)', args: [] },
    { label: 'Somente leitura', args: ['-s', 'read-only'] },
    { label: 'Auto', args: ['--approve-for-me'] },
    { label: 'Sem permissões', args: ['--dangerously-bypass-approvals-and-sandbox'] },
  ],
  agy: [
    { label: 'Padrão (config do agente)', args: [] },
    { label: 'Aceitar edições', args: ['--mode', 'accept-edits'] },
    { label: 'Plan', args: ['--mode', 'plan'] },
    { label: 'Sem permissões', args: ['--dangerously-skip-permissions'] },
  ],
};

export function args(agent: Agent, resumeId?: string, prompt?: string, mode: string[] = []): string[] {
  const p = [...mode, ...(prompt ? [prompt] : [])];
  if (agent === 'claude') return resumeId ? ['--resume', resumeId, ...p] : p;
  if (agent === 'codex') return resumeId ? ['resume', resumeId, ...p] : p;
  return [...(resumeId ? ['--conversation', resumeId] : []), ...mode, ...(prompt ? ['-i', prompt] : [])];
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

// Enquanto você está dentro de uma sessão, o título da aba lembra como voltar.
const HINT = 'Ctrl+Q ou F12 volta ao Maestro';
const withHint = (d: string) =>
  d.replace(/\x1b\]([02]);([^\x07\x1b]*)(\x07|\x1b\\)/g, (_, n, t, end) => `\x1b]${n};${t} · ${HINT}${end}`);

export function spawn(agent: Agent, cwd: string, opts: { resumeId?: string; prompt?: string; mode?: string[] } = {}): Managed {
  const [file, pre] = resolve(agent);
  const a = args(agent, opts.resumeId, opts.prompt, opts.mode);
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
    if (attached === m) process.stdout.write(withHint(d));
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

const WIN = process.platform === 'win32';

// Com win32-input-mode ligado, o ConPTY embrulha cada tecla em ESC[Vk;Sc;Uc;Kd;Cs;Rc_. O que o terminal mandou
// como texto (o F12 do VS Code, "ESC[24~") chega caractere por caractere. Aqui volta a ser texto, só com as teclas pressionadas.
export const unwrapWin32 = (s: string) =>
  s.replace(/\x1b\[(\d+);\d+;(\d+);(\d+);\d+;\d+_/g, (_, vk, uc, down) =>
    down !== '1' ? '' : +uc ? String.fromCharCode(+uc) : vk === '123' ? '\x1b[24~' : '');

// Tecla de saída: Ctrl+Q ou F12 (o terminal do VS Code engole o Ctrl+Q para o "Quick Open View").
// Depois de desembrulhar, o Ctrl+Q ainda pode vir cru (0x11), no formato kitty (ESC[113;5u) ou modifyOtherKeys (ESC[27;5;113~).
// Ctrl sem Alt: AltGr chega como Ctrl+Alt, e no ABNT2 AltGr+Q digita "/".
const ctrlOnly = (mods: string) => ((+mods - 1) & 4) !== 0 && ((+mods - 1) & 2) === 0;
export function isDetachKey(raw: string): boolean {
  const s = unwrapWin32(raw);
  if (s.includes('\x11') || /\x1b\[24(;\d+)?~/.test(s)) return true;
  for (const [, key, mods, event] of s.matchAll(/\x1b\[(\d+)(?::\d+)*;(\d+)(?::(\d+))?u/g))
    if (key === '113' && ctrlOnly(mods) && event !== '3') return true; // evento 3 = soltar a tecla
  for (const [, mods, key] of s.matchAll(/\x1b\[27;(\d+);(\d+)~/g))
    if (key === '113' && ctrlOnly(mods)) return true;
  return false;
}

// Desliga o que o agente pode ter ligado: win32-input, foco, tela alternativa, cursor, paste, mouse,
// modifyOtherKeys e todos os níveis do teclado kitty.
const RESET = '\x1b[?9001l\x1b[?1004l\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4m\x1b[<99u\x1b[0m';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

// Um único leitor do stdin, sempre em raw mode e nunca pausado. No Windows, desligar o raw mode com a leitura
// ativa deixa o libuv preso numa leitura em modo linha que come as teclas seguintes: era assim que a segunda
// entrada numa sessão ficava surda, sem Ctrl+Q. O painel (Ink) lê de um stream que finge ser terminal.
export const inkInput = Object.assign(new PassThrough(), {
  isTTY: true,
  setRawMode() { return inkInput; },
  ref() { return inkInput; },
  unref() { return inkInput; },
});
let onKey: ((s: string) => void) | undefined;
export function startInput() {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (b: Buffer) => (onKey ? onKey(b.toString()) : inkInput.write(b)));
}

let hinted = false;

// Entra na sessão: o terminal inteiro passa a ser do agente até Ctrl+Q ou F12.
// ponytail: sem emulador de terminal no meio; o redesenho vem de um "resize" forçado.
// Modos que o agente ligou antes (mouse, bracketed paste) não são reativados ao voltar. Upgrade: @xterm/headless.
export function attach(m: Managed): Promise<void> {
  const { stdout } = process;
  return new Promise((done) => {
    const onResize = () => m.proc.resize(stdout.columns, stdout.rows);
    detachCurrent = () => {
      detachCurrent = attached = undefined;
      onKey = () => {}; // key-ups que ainda chegam depois do Ctrl+Q não podem vazar pro painel
      stdout.off('resize', onResize);
      stdout.write(RESET + CLEAR + '\x1b]0;Maestro\x07');
      setTimeout(() => { onKey = undefined; done(); }, 200);
    };
    stdout.write(CLEAR + `\x1b]0;${m.title || m.agent} · ${HINT}\x07`);
    // Na primeira vez, a dica fica na tela um instante antes de o agente desenhar por cima.
    if (!hinted) stdout.write(`\x1b[2;3H\x1b[1;36m♪ Maestro\x1b[0m   ${HINT}\x1b[H`);
    setTimeout(() => {
      attached = m;
      if (WIN) stdout.write('\x1b[?9001h\x1b[?1004h');
      onKey = (s) => (isDetachKey(s) ? detachCurrent?.() : m.proc.write(s));
      stdout.on('resize', onResize);
      m.proc.resize(stdout.columns, Math.max(2, stdout.rows - 1));
      setTimeout(onResize, 60);
    }, hinted ? 0 : 1500);
    hinted = true;
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
