import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize, type Key } from 'ink';
import { knownDirs, liveSessions, samePath, usage, type Agent, type Session } from './disk.ts';
import { MODES, attach, inkInput, killAll, managed, onManagedExit, send, spawn, startInput, type Managed } from './pty.ts';

const h = React.createElement;

export interface Row extends Session { m?: Managed }
type Step =
  | { kind: 'agent' }
  | { kind: 'target'; agent: Agent }
  | { kind: 'dir'; agent: Agent }
  | { kind: 'path'; agent: Agent }
  | { kind: 'mode'; agent: Agent; dir: string }
  | { kind: 'history' }
  | { kind: 'recent' };
type Item = { label: string; value: any; color?: string };

const AGENTS: Agent[] = ['claude', 'codex', 'agy'];
const LABEL: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
const COLOR: Record<Agent, string> = { claude: '#D97757', codex: '#10A37F', agy: '#4285F4' };
const STATUS = {
  busy: { glyph: '●', label: 'running', color: 'yellow' },
  waiting: { glyph: '◐', label: 'waiting on you', color: 'red' },
  idle: { glyph: '✓', label: 'done', color: 'green' },
} as const;
const NO_USAGE: Record<Agent, string> = {
  claude: 'run trayce --setup-claude to see Claude usage',
  codex: 'no Codex usage in the last 7 days',
  agy: 'open the Antigravity desktop app with Trayce running to see the quota',
};
const pctColor = (p: number) => (p >= 80 ? 'red' : p >= 50 ? 'yellow' : 'green');
const bar = (p: number) => '▓'.repeat(Math.round(Math.min(100, p) / 10)).padEnd(10, '░');
const resetAt = (t: number) => {
  const d = new Date(t), hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
};

const short = (p: string) => (p.toLowerCase().startsWith(os.homedir().toLowerCase()) ? '~' + p.slice(os.homedir().length) : p);
const name = (r: Row) => r.title || short(r.cwd);

// Sessions on disk + the ones Maestro opened. A new Codex/agy session only gets an id after its first turn.
// ponytail: those are matched by directory; two new sessions of the same agent in the same dir can swap places.
export function merge(disk: Session[], mine: Managed[]): Row[] {
  const out: Row[] = disk.map((s) => ({ ...s }));
  for (const m of mine) {
    let r = m.id ? out.find((r) => r.agent === m.agent && r.id === m.id) : undefined;
    r ??= m.id ? undefined : out.find((r) =>
      r.agent === m.agent && !r.m && samePath(r.cwd, m.cwd) && !m.preexisting?.has(r.id) && !mine.some((o) => o.id === r.id));
    if (r) { m.id = r.id; r.m = m; r.title ||= m.title; }
    else out.push({ agent: m.agent, id: m.id ?? '', cwd: m.cwd, title: m.title || '(new session, waiting for the first prompt)', status: 'idle', m });
  }
  return out;
}

// What Maestro keeps between runs. Without disk access it just doesn't survive closing.
const DATA = path.join(os.homedir(), '.maestro');
const HISTORY = path.join(DATA, 'history.json'), RECENT = path.join(DATA, 'sessions.json');
const load = (file: string): any[] => {
  try { const l = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
};
const save = (file: string, list: unknown[]) => {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(list)); } catch {}
};

// Prompts already sent, newest first (Ctrl+R), to redo one without retyping.
export const remember = (list: string[], t: string) => [t, ...list.filter((p) => p !== t)].slice(0, 50);

// Sessions opened by Maestro (Ctrl+O), to resume after closing it. seen = last minute it was alive.
export interface Recent { agent: Agent; id: string; cwd: string; title: string; mode?: string[]; seen: number }
const same = (a: { agent: Agent; id: string }, b: { agent: Agent; id: string }) => a.agent === b.agent && a.id === b.id;
export function track(list: Recent[], rows: Row[], now = Date.now()): Recent[] {
  const seen = Math.floor(now / 60_000); // in minutes: the file changes at most once a minute
  const mine = rows.filter((r) => r.m && r.id).map((r): Recent => ({ agent: r.agent, id: r.id, cwd: r.cwd, title: r.title, mode: r.m!.mode, seen }));
  return [...mine.filter((n) => !list.some((o) => same(o, n))), ...list.map((o) => mine.find((n) => same(o, n)) ?? o)].slice(0, 20);
}

// One keystroke applied to a text field with a cursor. Returns [text, cursor].
export function edit(t: string, pos: number, input: string, key: Partial<Key>): [string, number] {
  if (key.leftArrow) return [t, Math.max(0, pos - 1)];
  if (key.rightArrow) return [t, Math.min(t.length, pos + 1)];
  if (key.home) return [t, 0];
  if (key.end) return [t, t.length];
  if (key.backspace) return pos ? [t.slice(0, pos - 1) + t.slice(pos), pos - 1] : [t, pos];
  if (key.delete) return [t.slice(0, pos) + t.slice(pos + 1), pos];
  if (!input || key.ctrl || key.meta) return [t, pos];
  const s = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  return [t.slice(0, pos) + s + t.slice(pos), pos + s.length];
}

// Word wrap that keeps every character (spaces stay at the end of the line), so a cursor index maps 1:1 onto the lines.
// ponytail: counts chars, not columns; wide CJK/emoji can overflow a line.
export function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  while (s.length > w) {
    const sp = s.lastIndexOf(' ', w - 1), n = sp > 0 ? sp + 1 : w;
    out.push(s.slice(0, n));
    s = s.slice(n);
  }
  return [...out, s];
}

// Joins parts with " · " into lines of at most w, breaking only between parts.
export function pack(parts: string[], w: number): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length + 3 + p.length <= w) out[out.length - 1] += ' · ' + p;
    else out.push(p);
  }
  return out;
}

// Text field lines: "› " on the first line, the cursor cell in inverse, scrolled so the cursor stays visible.
function field(t: string, pos: number, w: number, max: number) {
  const lines = wrap(t + ' ', w);
  let row = 0, at = pos;
  while (row < lines.length - 1 && at >= lines[row].length) at -= lines[row++].length;
  const first = Math.max(0, row - max + 1);
  return lines.slice(first, first + max).map((l, i) => h(Text, { key: i },
    h(Text, { color: 'cyan' }, first + i ? '  ' : '› '),
    ...(first + i === row ? [l.slice(0, at), h(Text, { inverse: true }, l[at]), l.slice(at + 1)] : [l])));
}

// State that survives while the dashboard is off screen because you went into a session.
const store = {
  tab: 0, sel: 0, input: '', pos: 0, quitArmed: false,
  history: load(HISTORY) as string[],
  recent: load(RECENT) as Recent[],
  notice: fs.existsSync(RECENT) ? 'Ctrl+O resumes the sessions you had open in Maestro.' : '',
  usage: usage(),
  mode: {} as Partial<Record<Agent, number>>, // last mode picked per agent
  focus: undefined as Managed | undefined, // session you just came back from
  pending: undefined as undefined | { row: Row; prompt: string; misses: number },
};

function App({ onAttach }: { onAttach: (m: Managed) => void }) {
  const { exit } = useApp();
  const { rows: height, columns } = useWindowSize();
  const [all, setAll] = useState<Row[]>([]);
  const [, force] = useState(0);
  const [step, setStep] = useState<Step>();
  const [cursor, setCursor] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [dir, setDir] = useState<[string, number]>(['', 0]);
  const redraw = () => force((n) => n + 1);
  const note = (s: string) => { store.notice = s; redraw(); };

  // Opening an agent can fail (e.g. the executable vanished mid-update). That must not take the dashboard down.
  const open = (agent: Agent, cwd: string, opts: Parameters<typeof spawn>[2]) => {
    try { return spawn(agent, cwd, opts); }
    catch (e: any) { note(`Couldn't open ${LABEL[agent]}: ${e.message}`); }
  };

  const refresh = () => {
    const list = merge(liveSessions(), managed);
    const recent = track(store.recent, list);
    if (JSON.stringify(recent) !== JSON.stringify(store.recent)) save(RECENT, (store.recent = recent));
    const p = store.pending;
    const gone = p && !list.some((r) => r.agent === p.row.agent && r.id === p.row.id);
    if (p) p.misses = gone ? p.misses + 1 : 0;
    // two reads in a row without it: a single one could be the status file mid-rewrite
    if (p && p.misses >= 2) {
      if (open(p.row.agent, p.row.cwd, { resumeId: p.row.id, prompt: p.prompt || undefined })) {
        store.pending = undefined;
        store.notice = `Resumed here: ${LABEL[p.row.agent]} · ${name(p.row)}`;
        return setAll(merge(liveSessions(), managed));
      }
      store.notice += ' Retrying shortly. Esc cancels.'; // it's already closed over there: the resume can't be lost
    }
    setAll(list);
  };
  useEffect(() => {
    refresh();
    onManagedExit(refresh);
    const t = setInterval(refresh, 1500);
    const readUsage = () => { store.usage = usage(); redraw(); };
    readUsage();
    const u = setInterval(readUsage, 30_000);
    return () => { clearInterval(t); clearInterval(u); };
  }, []);

  const tabAgent = store.tab ? AGENTS[store.tab - 1] : undefined;
  const shown = all.filter((r) => !tabAgent || r.agent === tabAgent);
  const back = store.focus && shown.findIndex((r) => r.m === store.focus);
  if (back !== undefined && back >= 0) { store.sel = back; store.focus = undefined; }
  store.sel = Math.min(store.sel, Math.max(0, shown.length - 1));
  const selected = shown[store.sel];

  // Closed = not alive now. "Last time" = the ones still alive in the last recorded minute.
  const closed = store.recent.filter((s) => !all.some((r) => same(r, s)));
  const lastSeen = Math.max(...store.recent.map((s) => s.seen));
  const lastRun = closed.filter((s) => s.seen >= lastSeen - 1);

  const items: Item[] =
    step?.kind === 'agent' ? AGENTS.map((a) => ({ label: LABEL[a], value: a, color: COLOR[a] }))
    : step?.kind === 'target' ? [
        ...all.filter((r) => r.agent === step.agent).sort((a, b) => +!!b.m - +!!a.m).map((r) => ({
          label: `${STATUS[r.status].glyph} ${name(r)}  ·  ${short(r.cwd)}  ${r.m ? '◆' : '◇ other terminal'}`, value: r,
        })),
        { label: '＋ New session…', value: 'new', color: 'cyan' },
      ]
    : step?.kind === 'dir' ? [
        { label: `${short(process.cwd())}  · where you started Maestro`, value: process.cwd() },
        ...knownDirs().filter((d) => !samePath(d, process.cwd())).map((d) => ({ label: short(d), value: d })),
        { label: '✎ Other path…', value: 'other', color: 'cyan' },
      ]
    : step?.kind === 'mode' ? MODES[step.agent].map((m, i) => ({ label: m.label, value: i, color: m.label === 'No permissions' ? 'red' : undefined }))
    : step?.kind === 'history' ? store.history.map((p) => ({ label: p, value: p }))
    : step?.kind === 'recent' ? [
        ...(lastRun.length > 1 ? [{ label: `↻ Resume the ${lastRun.length} that were open last time`, value: 'last', color: 'cyan' }] : []),
        ...closed.map((s) => ({ label: `${LABEL[s.agent].padEnd(12)}${s.title || short(s.cwd)}  ·  ${short(s.cwd)}`, value: s, color: COLOR[s.agent] })),
      ]
    : [];

  const go = (s: Step | undefined) => { setStep(s); setCursor(0); };

  const create = (agent: Agent, raw: string) => {
    setStep({ kind: 'mode', agent, dir: path.resolve(raw) });
    setCursor(store.mode[agent] ?? 0);
  };

  const launch = (agent: Agent, dir: string, mode: number) => {
    store.mode[agent] = mode;
    const before = new Set(all.map((r) => r.id));
    const m = open(agent, dir, { prompt: prompt || undefined, mode: MODES[agent][mode].args });
    go(undefined);
    if (!m) return;
    m.preexisting = before;
    if (!prompt) return onAttach(m); // empty session: you want to use it now
    note(`New ${LABEL[agent]} session in ${short(dir)} got the prompt.`);
    refresh();
  };

  const deliver = (r: Row, text: string) => {
    go(undefined);
    if (r.m) return text ? (send(r.m, text), note(`Sent to ${LABEL[r.agent]} · ${name(r)}`)) : onAttach(r.m);
    // Can't type into a terminal that isn't ours: wait for you to close it there, then resume it here.
    store.pending = { row: r, prompt: text, misses: 0 };
    note(`"${name(r)}" is open in another terminal. Close it there (/exit) and I'll resume it here${text ? ' with your prompt' : ''}. Esc cancels.`);
  };

  const choose = (v: any) => {
    if (step?.kind === 'agent') return go(prompt ? { kind: 'target', agent: v } : { kind: 'dir', agent: v });
    if (step?.kind === 'target') return v === 'new' ? go({ kind: 'dir', agent: step.agent }) : deliver(v, prompt);
    if (step?.kind === 'dir') return v === 'other' ? (setDir(['', 0]), go({ kind: 'path', agent: step.agent })) : create(step.agent, v);
    if (step?.kind === 'mode') return launch(step.agent, step.dir, v);
    if (step?.kind === 'history') { store.input = v; store.pos = v.length; return go(undefined); }
    if (step?.kind === 'recent') return resume(v === 'last' ? lastRun : [v]);
  };

  const resume = (list: Recent[]) => {
    go(undefined);
    const opened = list.flatMap((s) => open(s.agent, s.cwd, { resumeId: s.id, mode: s.mode }) ?? []);
    if (list.length === 1 && opened[0]) return onAttach(opened[0]); // just one: you want to use it now
    if (opened.length) note(`Resumed ${opened.length} session(s).`);
    refresh();
  };

  const startDispatch = (text: string) => {
    setPrompt(text);
    if (text) save(HISTORY, (store.history = remember(store.history, text)));
    if (!tabAgent) {
      setStep({ kind: 'agent' });
      setCursor(Math.max(0, AGENTS.indexOf(selected?.agent ?? 'claude')));
    } else go(text ? { kind: 'target', agent: tabAgent } : { kind: 'dir', agent: tabAgent });
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (managed.length && !store.quitArmed) {
        store.quitArmed = true;
        return note(`Quitting closes ${managed.length} session(s) opened by Maestro. Press Ctrl+C again to confirm.`);
      }
      killAll();
      return exit();
    }
    store.quitArmed = false;

    if (step?.kind === 'path') {
      if (key.escape) return go(undefined);
      if (key.return) {
        const d = dir[0].trim().replace(/^~/, os.homedir());
        return fs.existsSync(d) && fs.statSync(d).isDirectory() ? create(step.agent, d) : note(`Directory doesn't exist: ${d}`);
      }
      return setDir(edit(dir[0], dir[1], input, key));
    }
    if (step) {
      if (key.escape) return go(undefined);
      if (key.upArrow) return setCursor((c) => (c + items.length - 1) % items.length);
      if (key.downArrow) return setCursor((c) => (c + 1) % items.length);
      if (key.return) return choose(items[cursor]?.value);
      return;
    }

    if (key.escape) {
      if (store.pending) { store.pending = undefined; return note('Resume canceled.'); }
      store.input = '';
      store.pos = 0;
      return note('');
    }
    if (key.tab) { store.tab = (store.tab + (key.shift ? 3 : 1)) % 4; store.sel = 0; return redraw(); }
    if (key.upArrow) { store.sel = Math.max(0, store.sel - 1); return redraw(); }
    if (key.downArrow) { store.sel = Math.min(shown.length - 1, store.sel + 1); return redraw(); }
    if (key.ctrl && input === 'n') return startDispatch('');
    if (key.ctrl && input === 'r') {
      if (!store.history.length) return note('No prompts in history yet.');
      setPrompt('');
      return go({ kind: 'history' });
    }
    if (key.ctrl && input === 'o') {
      if (!closed.length) return note('No closed sessions to resume.');
      setPrompt('');
      return go({ kind: 'recent' });
    }
    if (key.return) {
      const t = store.input.trim();
      store.input = '';
      store.pos = 0;
      if (t) return startDispatch(t);
      if (selected) return deliver(selected, '');
      return;
    }
    [store.input, store.pos] = edit(store.input, store.pos, input, key);
    redraw();
  });

  // ── drawing ──
  const counts = AGENTS.map((a) => all.filter((r) => r.agent === a).length);
  const busy = all.filter((r) => r.status === 'busy').length, waiting = all.filter((r) => r.status === 'waiting').length;
  const tabs = ['All', ...AGENTS.map((a) => LABEL[a])];
  const fieldW = Math.max(1, columns - 6), fieldMax = Math.max(1, Math.floor(height / 3)); // 6 = border + padding + "› "
  const inputRows = store.input ? Math.min(wrap(store.input + ' ', fieldW).length, fieldMax) : 1;
  const hints = pack(step
    ? [...(step.kind === 'path' ? ['←→ cursor'] : ['↑↓ choose']), 'Enter confirm', 'Esc cancel']
    : ['Tab tabs', '↑↓ session', '←→ cursor', 'Enter open/send', 'Ctrl+Q/F12 leave session', 'Ctrl+N new session',
      'Ctrl+R history', 'Ctrl+O resume', 'Esc clear', 'Ctrl+C quit', '◆ Maestro ◇ external'], Math.max(1, columns - 2));
  // 10 = header, list border, detail (3), notice, prompt border, one spare row
  const listHeight = Math.max(3, height - 10 - (tabAgent ? 1 : 0) - inputRows - hints.length);
  const start = Math.max(0, store.sel - listHeight + 1);
  const off = Math.max(0, cursor - listHeight + 3);

  const header = h(Box, { paddingX: 1, gap: 2 },
    h(Text, { bold: true, color: 'cyan' }, '✥ Maestro'),
    ...tabs.map((t, i) => h(Text, {
      key: t, bold: i === store.tab, underline: i === store.tab,
      color: i === store.tab ? (i ? COLOR[AGENTS[i - 1]] : 'white') : 'gray',
    }, `${t} ${i ? counts[i - 1] : all.length}`)),
    h(Box, { flexGrow: 1, justifyContent: 'flex-end' },
      h(Text, { dimColor: true }, `${busy} running · `),
      h(Text, { color: waiting ? 'red' : 'gray', bold: waiting > 0 }, `${waiting} waiting on you`)),
  );

  // Only on an agent's tab: bars and reset time.
  const usageLine = tabAgent && h(Box, { paddingX: 1, height: 1 }, h(Text, { wrap: 'truncate-end' }, store.usage[tabAgent].length
    ? store.usage[tabAgent].flatMap((l, i) => [
        i ? h(Text, { key: 's' + i, dimColor: true }, '  ·  ') : null,
        h(Text, { key: 'l' + i }, l.label + ' '),
        h(Text, { key: 'p' + i, color: pctColor(l.pct) }, `${l.pct}% ${bar(l.pct)}`),
        l.resetsAt ? h(Text, { key: 'r' + i, dimColor: true }, ` resets ${resetAt(l.resetsAt)}`) : null,
      ])
    : h(Text, { dimColor: true }, NO_USAGE[tabAgent])));

  const rowLine = (r: Row, i: number) => {
    const on = i === store.sel, st = STATUS[r.status];
    return h(Box, { key: r.agent + r.id + i },
      h(Text, { color: 'cyan' }, on ? '❯ ' : '  '),
      h(Text, { color: st.color }, st.glyph + ' '),
      h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: COLOR[r.agent] }, LABEL[r.agent])),
      h(Box, { flexGrow: 1 }, h(Text, { bold: on, wrap: 'truncate-end' }, name(r))),
      h(Box, { width: 32, marginLeft: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate-start' }, short(r.cwd))),
      h(Box, { width: 18, marginLeft: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, r.model ?? '')),
      h(Text, { color: r.m ? 'cyan' : 'gray' }, r.m ? ' ◆' : ' ◇'),
    );
  };

  const picker = step && h(Box, { flexDirection: 'column' },
    prompt ? h(Text, { dimColor: true, wrap: 'truncate-end' }, `Prompt: "${prompt}"`) : null,
    h(Text, { bold: true }, {
      agent: 'Which agent?',
      target: `Which ${LABEL[(step as any).agent as Agent]} session?`,
      dir: `Which directory should ${LABEL[(step as any).agent as Agent]} open in?`,
      path: 'Directory path:',
      mode: `Which mode should ${LABEL[(step as any).agent as Agent]} start in?`,
      history: 'Which prompt to reuse?',
      recent: 'Which session to resume?',
    }[step.kind]),
    step.kind === 'path'
      ? field(dir[0], dir[1], fieldW, Math.max(1, listHeight - 2))
      : items.slice(off, off + listHeight - 2).map((it, i) => {
          const on = off + i === cursor;
          return h(Text, { key: i, color: on ? 'cyan' : it.color, bold: on, wrap: 'truncate-end' }, (on ? '❯ ' : '  ') + it.label);
        }),
  );

  const empty = h(Text, { dimColor: true }, tabAgent
    ? `No ${LABEL[tabAgent]} sessions open. Write a prompt or press Ctrl+N to open one.`
    : 'No sessions open. Write a prompt or press Ctrl+N to open one.');

  const body = h(Box, { borderStyle: 'round', borderColor: 'gray', flexDirection: 'column', paddingX: 1, height: listHeight + 2 },
    picker ?? (shown.length ? shown.slice(start, start + listHeight).map((r, i) => rowLine(r, start + i)) : empty));

  const detail = selected && !step
    ? h(Box, { flexDirection: 'column', paddingX: 2, height: 3 },
        h(Text, { wrap: 'truncate-end' },
          h(Text, { color: STATUS[selected.status].color }, STATUS[selected.status].label),
          selected.detail ? h(Text, { color: 'red' }, ` — ${selected.detail}`) : '',
          h(Text, { dimColor: true }, `  ·  ${selected.m ? '◆ opened by Maestro (Enter goes in, Ctrl+Q or F12 comes back)' : '◇ open in another terminal (Enter resumes it here once you close it there)'}`)),
        h(Text, { dimColor: true, wrap: 'truncate-start' }, selected.cwd),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, selected.id))
    : h(Box, { height: 3 });

  const input = h(Box, { borderStyle: 'round', borderColor: step ? 'gray' : 'cyan', paddingX: 1, flexDirection: 'column', flexShrink: 0 },
    store.input
      ? field(store.input, store.pos, fieldW, fieldMax)
      : h(Text, { wrap: 'truncate-end' }, h(Text, { color: 'cyan' }, '› '),
          h(Text, { dimColor: true }, step ? '' : `Write a prompt and press Enter to pick ${tabAgent ? 'the session' : 'the agent'}…`)));

  return h(Box, { flexDirection: 'column', height },
    header, usageLine, body, detail,
    h(Box, { paddingX: 1, height: 1 }, h(Text, { color: 'yellow', wrap: 'truncate-end' }, store.notice)),
    input,
    h(Box, { paddingX: 1, flexDirection: 'column', flexShrink: 0 },
      hints.map((l, i) => h(Text, { key: i, dimColor: true, wrap: 'truncate-end' }, l))),
  );
}

export async function run() {
  if (!process.stdin.isTTY) {
    console.error('Maestro needs an interactive terminal.');
    process.exit(1);
  }
  startInput();
  process.stdout.write('\x1b]0;Maestro\x07');
  for (;;) {
    let next: Managed | undefined;
    const app = render(h(App, { onAttach: (m: Managed) => { next = store.focus = m; app.unmount(); } }), { stdin: inkInput as any, exitOnCtrlC: false, alternateScreen: true });
    await app.waitUntilExit();
    if (!next) break;
    await attach(next);
  }
  killAll();
  process.exit(0);
}
