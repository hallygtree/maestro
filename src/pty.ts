// Managed sessions: Maestro opens the agent in its own pseudoterminal, so it can type into it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Agent } from './disk.ts';

// preexisting: sessions already alive when this one was opened (must not be mistaken for it). mode: mode flags, to resume the same way.
export interface Managed { agent: Agent; cwd: string; id?: string; title: string; proc: IPty; preexisting?: Set<string>; mode?: string[] }
export const managed: Managed[] = [];
let detachCurrent: (() => void) | undefined;
let attached: Managed | undefined;
let onExitCb = () => {};
export const onManagedExit = (cb: () => void) => { onExitCb = cb; };

// npm shim (.cmd) → real target, so the prompt goes in as argv without cmd.exe's quoting rules.
export function shimTarget(cmdText: string, dir: string): [string, string[]] | undefined {
  const m = [...cmdText.matchAll(/"%dp0%\\([^"]+)"/g)].at(-1); // the last one is the line that runs; the IF EXIST node.exe comes before it
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

// Modes each CLI accepts at launch. Only what the agent supports; the first is always its own config.
export const MODES: Record<Agent, { label: string; args: string[] }[]> = {
  claude: [
    { label: 'Default (agent config)', args: [] },
    { label: 'Manual', args: ['--permission-mode', 'manual'] },
    { label: 'Accept edits', args: ['--permission-mode', 'acceptEdits'] },
    { label: 'Plan', args: ['--permission-mode', 'plan'] },
    { label: 'Auto', args: ['--permission-mode', 'auto'] },
    { label: 'No permissions', args: ['--permission-mode', 'bypassPermissions'] },
  ],
  codex: [
    { label: 'Default (agent config)', args: [] },
    { label: 'Read-only', args: ['-s', 'read-only'] },
    { label: 'Auto', args: ['--approve-for-me'] },
    { label: 'No permissions', args: ['--dangerously-bypass-approvals-and-sandbox'] },
  ],
  agy: [
    { label: 'Default (agent config)', args: [] },
    { label: 'Accept edits', args: ['--mode', 'accept-edits'] },
    { label: 'Plan', args: ['--mode', 'plan'] },
    { label: 'No permissions', args: ['--dangerously-skip-permissions'] },
  ],
};

export function args(agent: Agent, resumeId?: string, prompt?: string, mode: string[] = []): string[] {
  const p = [...mode, ...(prompt ? [prompt] : [])];
  if (agent === 'claude') return resumeId ? ['--resume', resumeId, ...p] : p;
  if (agent === 'codex') return resumeId ? ['resume', resumeId, ...p] : p;
  return [...(resumeId ? ['--conversation', resumeId] : []), ...mode, ...(prompt ? ['-i', prompt] : [])];
}

// Markers a parent Claude injects. If inherited, the child agent thinks it's a subsession and doesn't save a transcript.
const PARENT_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID',
];
const childEnv = () => {
  const env = { ...process.env } as Record<string, string>;
  for (const k of PARENT_MARKERS) delete env[k];
  return env;
};

// While you're inside a session, the tab title reminds you how to get back.
const HINT = 'Ctrl+Q or F12 returns to Maestro';
const withHint = (d: string) =>
  d.replace(/\x1b\]([02]);([^\x07\x1b]*)(\x07|\x1b\\)/g, (_, n, t, end) => `\x1b]${n};${t} · ${HINT}${end}`);

export function spawn(agent: Agent, cwd: string, opts: { resumeId?: string; prompt?: string; mode?: string[] } = {}): Managed {
  const [file, pre] = resolve(agent);
  const a = args(agent, opts.resumeId, opts.prompt, opts.mode);
  let id = opts.resumeId;
  if (agent === 'claude' && !id) a.unshift('--session-id', (id = randomUUID())); // id known from the start
  const proc = pty.spawn(file, [...pre, ...a], {
    name: 'xterm-256color', cwd, env: childEnv(),
    cols: process.stdout.columns || 120, rows: process.stdout.rows || 30,
    useConptyDll: true, // node-pty's ConPTY (passes output through); Windows' own redraws and leaves garbage when scrolling
  });
  const m: Managed = { agent, cwd, id, title: '', proc, mode: opts.mode };
  proc.onData((d) => {
    const t = [...d.matchAll(/\x1b\][02];([^\x07\x1b]*)/g)].at(-1)?.[1];
    // ignore ConPTY's initial title (the .exe path) and strip the spinner some agents put in front
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
  setTimeout(() => m.proc.write('\r'), 150); // separate Enter, otherwise it becomes a line break inside the "paste"
}

const WIN = process.platform === 'win32';

// With win32-input-mode on, ConPTY wraps each key in ESC[Vk;Sc;Uc;Kd;Cs;Rc_. What the terminal sent
// as text (VS Code's F12, "ESC[24~") arrives char by char. This turns it back into text, key presses only.
export const unwrapWin32 = (s: string) =>
  s.replace(/\x1b\[(\d+);\d+;(\d+);(\d+);\d+;\d+_/g, (_, vk, uc, down) =>
    down !== '1' ? '' : +uc ? String.fromCharCode(+uc) : vk === '123' ? '\x1b[24~' : '');

// Leave key: Ctrl+Q or F12 (the VS Code terminal swallows Ctrl+Q for "Quick Open View").
// After unwrapping, Ctrl+Q can still come raw (0x11), in kitty format (ESC[113;5u) or modifyOtherKeys (ESC[27;5;113~).
// Ctrl without Alt: AltGr arrives as Ctrl+Alt, and on ABNT2 AltGr+Q types "/".
const ctrlOnly = (mods: string) => ((+mods - 1) & 4) !== 0 && ((+mods - 1) & 2) === 0;
export function isDetachKey(raw: string): boolean {
  const s = unwrapWin32(raw);
  if (s.includes('\x11') || /\x1b\[24(;\d+)?~/.test(s)) return true;
  for (const [, key, mods, event] of s.matchAll(/\x1b\[(\d+)(?::\d+)*;(\d+)(?::(\d+))?u/g))
    if (key === '113' && ctrlOnly(mods) && event !== '3') return true; // event 3 = key release
  for (const [, mods, key] of s.matchAll(/\x1b\[27;(\d+);(\d+)~/g))
    if (key === '113' && ctrlOnly(mods)) return true;
  return false;
}

// Turns off whatever the agent may have turned on: win32-input, focus, alternate screen, cursor, paste, mouse,
// modifyOtherKeys and every kitty keyboard level.
const RESET = '\x1b[?9001l\x1b[?1004l\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4m\x1b[<99u\x1b[0m';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

// A single stdin reader, always in raw mode and never paused. On Windows, turning raw mode off while reading
// leaves libuv stuck in a line-mode read that eats the next keys: that's how entering a session a second
// time went deaf, with no Ctrl+Q. The dashboard (Ink) reads from a stream that pretends to be a terminal.
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

// Enters the session: the whole terminal belongs to the agent until Ctrl+Q or F12.
// ponytail: no terminal emulator in between; the redraw comes from a forced "resize".
// Modes the agent turned on earlier (mouse, bracketed paste) aren't re-enabled on return. Upgrade: @xterm/headless.
export function attach(m: Managed): Promise<void> {
  const { stdout } = process;
  return new Promise((done) => {
    const onResize = () => m.proc.resize(stdout.columns, stdout.rows);
    detachCurrent = () => {
      detachCurrent = attached = undefined;
      onKey = () => {}; // key-ups still arriving after Ctrl+Q must not leak into the dashboard
      stdout.off('resize', onResize);
      stdout.write(RESET + CLEAR + '\x1b]0;Maestro\x07');
      setTimeout(() => { onKey = undefined; done(); }, 200);
    };
    stdout.write(CLEAR + `\x1b]0;${m.title || m.agent} · ${HINT}\x07`);
    // The first time, the hint stays on screen a moment before the agent draws over it.
    if (!hinted) stdout.write(`\x1b[2;3H\x1b[1;36m✥ Maestro\x1b[0m   ${HINT}\x1b[H`);
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

// On Windows node-pty's kill() sometimes prints "AttachConsole failed" over the screen; taskkill /T takes the tree down quietly.
export const killAll = () => {
  for (const m of [...managed]) {
    try {
      if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(m.proc.pid)], { stdio: 'ignore' });
      else m.proc.kill();
    } catch {} // already exited
  }
};
