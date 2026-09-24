import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { knownDirs, liveSessions, samePath, type Agent, type Session } from './disk.ts';
import { attach, killAll, managed, onManagedExit, send, spawn, type Managed } from './pty.ts';

const h = React.createElement;

export interface Row extends Session { m?: Managed }
type Step =
  | { kind: 'agent' }
  | { kind: 'target'; agent: Agent }
  | { kind: 'dir'; agent: Agent }
  | { kind: 'path'; agent: Agent };
type Item = { label: string; value: any; color?: string };

const AGENTS: Agent[] = ['claude', 'codex', 'agy'];
const LABEL: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
const COLOR: Record<Agent, string> = { claude: '#D97757', codex: '#10A37F', agy: '#4285F4' };
const STATUS = {
  busy: { glyph: '●', label: 'rodando', color: 'yellow' },
  waiting: { glyph: '◐', label: 'esperando você', color: 'red' },
  idle: { glyph: '✓', label: 'concluído', color: 'green' },
} as const;

const short = (p: string) => (p.toLowerCase().startsWith(os.homedir().toLowerCase()) ? '~' + p.slice(os.homedir().length) : p);
const name = (r: Row) => r.title || short(r.cwd);

// Sessões do disco + as que o Maestro abriu. Sessão nova de Codex/agy só ganha id depois do primeiro turno.
// ponytail: essas são casadas pelo diretório; duas novas do mesmo agente no mesmo dir podem trocar de lugar.
export function merge(disk: Session[], mine: Managed[]): Row[] {
  const out: Row[] = disk.map((s) => ({ ...s }));
  for (const m of mine) {
    let r = m.id ? out.find((r) => r.agent === m.agent && r.id === m.id) : undefined;
    r ??= m.id ? undefined : out.find((r) =>
      r.agent === m.agent && !r.m && samePath(r.cwd, m.cwd) && !m.preexisting?.has(r.id) && !mine.some((o) => o.id === r.id));
    if (r) { m.id = r.id; r.m = m; r.title ||= m.title; }
    else out.push({ agent: m.agent, id: m.id ?? '', cwd: m.cwd, title: m.title || '(nova sessão, aguardando o primeiro prompt)', status: 'idle', m });
  }
  return out;
}

// Estado que sobrevive quando o painel sai da tela para você entrar numa sessão.
const store = {
  tab: 0, sel: 0, input: '', notice: '', quitArmed: false,
  focus: undefined as Managed | undefined, // sessão de onde você acabou de voltar
  pending: undefined as undefined | { row: Row; prompt: string; misses: number },
};

function App({ onAttach }: { onAttach: (m: Managed) => void }) {
  const { exit } = useApp();
  const { rows: height } = useWindowSize();
  const [all, setAll] = useState<Row[]>([]);
  const [, force] = useState(0);
  const [step, setStep] = useState<Step>();
  const [cursor, setCursor] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [dirText, setDirText] = useState('');
  const redraw = () => force((n) => n + 1);
  const note = (s: string) => { store.notice = s; redraw(); };

  // Abrir um agente pode falhar (ex.: o executável sumiu no meio de uma atualização). Isso não pode derrubar o painel.
  const open = (agent: Agent, cwd: string, opts: Parameters<typeof spawn>[2]) => {
    try { return spawn(agent, cwd, opts); }
    catch (e: any) { note(`Não consegui abrir ${LABEL[agent]}: ${e.message}`); }
  };

  const refresh = () => {
    const list = merge(liveSessions(), managed);
    const p = store.pending;
    const gone = p && !list.some((r) => r.agent === p.row.agent && r.id === p.row.id);
    if (p) p.misses = gone ? p.misses + 1 : 0;
    // duas leituras seguidas sem ela: uma só pode ser o arquivo de status no meio de uma regravação
    if (p && p.misses >= 2) {
      if (open(p.row.agent, p.row.cwd, { resumeId: p.row.id, prompt: p.prompt || undefined })) {
        store.pending = undefined;
        store.notice = `Retomada aqui: ${LABEL[p.row.agent]} · ${name(p.row)}`;
        return setAll(merge(liveSessions(), managed));
      }
      store.notice += ' Tento de novo em instantes. Esc cancela.'; // a sessão já foi fechada lá: não dá pra perder a retomada
    }
    setAll(list);
  };
  useEffect(() => {
    refresh();
    onManagedExit(refresh);
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, []);

  const tabAgent = store.tab ? AGENTS[store.tab - 1] : undefined;
  const shown = all.filter((r) => !tabAgent || r.agent === tabAgent);
  const back = store.focus && shown.findIndex((r) => r.m === store.focus);
  if (back !== undefined && back >= 0) { store.sel = back; store.focus = undefined; }
  store.sel = Math.min(store.sel, Math.max(0, shown.length - 1));
  const selected = shown[store.sel];

  const items: Item[] =
    step?.kind === 'agent' ? AGENTS.map((a) => ({ label: LABEL[a], value: a, color: COLOR[a] }))
    : step?.kind === 'target' ? [
        ...all.filter((r) => r.agent === step.agent).sort((a, b) => +!!b.m - +!!a.m).map((r) => ({
          label: `${STATUS[r.status].glyph} ${name(r)}  ·  ${short(r.cwd)}  ${r.m ? '◆' : '◇ outro terminal'}`, value: r,
        })),
        { label: '＋ Nova sessão…', value: 'new', color: 'cyan' },
      ]
    : step?.kind === 'dir' ? [
        { label: `${short(process.cwd())}  · onde você abriu o Maestro`, value: process.cwd() },
        ...knownDirs().filter((d) => !samePath(d, process.cwd())).map((d) => ({ label: short(d), value: d })),
        { label: '✎ Outro caminho…', value: 'other', color: 'cyan' },
      ]
    : [];

  const go = (s: Step | undefined) => { setStep(s); setCursor(0); };

  const create = (agent: Agent, raw: string) => {
    const dir = path.resolve(raw);
    const before = new Set(all.map((r) => r.id));
    const m = open(agent, dir, { prompt: prompt || undefined });
    go(undefined);
    if (!m) return;
    m.preexisting = before;
    if (!prompt) return onAttach(m); // sessão vazia: você quer usá-la agora
    note(`Nova sessão ${LABEL[agent]} em ${short(dir)} recebeu o prompt.`);
    refresh();
  };

  const deliver = (r: Row, text: string) => {
    go(undefined);
    if (r.m) return text ? (send(r.m, text), note(`Enviado para ${LABEL[r.agent]} · ${name(r)}`)) : onAttach(r.m);
    // Não dá pra digitar num terminal que não é nosso: espera você fechar lá e retoma aqui.
    store.pending = { row: r, prompt: text, misses: 0 };
    note(`"${name(r)}" está aberta em outro terminal. Feche-a lá (/exit) e eu retomo aqui${text ? ' já com o seu prompt' : ''}. Esc cancela.`);
  };

  const choose = (v: any) => {
    if (step?.kind === 'agent') return go(prompt ? { kind: 'target', agent: v } : { kind: 'dir', agent: v });
    if (step?.kind === 'target') return v === 'new' ? go({ kind: 'dir', agent: step.agent }) : deliver(v, prompt);
    if (step?.kind === 'dir') return v === 'other' ? (setDirText(''), go({ kind: 'path', agent: step.agent })) : create(step.agent, v);
  };

  const startDispatch = (text: string) => {
    setPrompt(text);
    if (!tabAgent) {
      setStep({ kind: 'agent' });
      setCursor(Math.max(0, AGENTS.indexOf(selected?.agent ?? 'claude')));
    } else go(text ? { kind: 'target', agent: tabAgent } : { kind: 'dir', agent: tabAgent });
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (managed.length && !store.quitArmed) {
        store.quitArmed = true;
        return note(`Sair encerra ${managed.length} sessão(ões) aberta(s) pelo Maestro. Ctrl+C de novo para confirmar.`);
      }
      killAll();
      return exit();
    }
    store.quitArmed = false;
    const text = (t: string, set: (s: string) => void) => {
      if (key.backspace || key.delete) set(t.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) set(t + input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
    };

    if (step?.kind === 'path') {
      if (key.escape) return go(undefined);
      if (key.return) {
        const dir = dirText.trim().replace(/^~/, os.homedir());
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? create(step.agent, dir) : note(`Diretório não existe: ${dir}`);
      }
      return text(dirText, setDirText);
    }
    if (step) {
      if (key.escape) return go(undefined);
      if (key.upArrow) return setCursor((c) => (c + items.length - 1) % items.length);
      if (key.downArrow) return setCursor((c) => (c + 1) % items.length);
      if (key.return) return choose(items[cursor]?.value);
      return;
    }

    if (key.escape) {
      if (store.pending) { store.pending = undefined; return note('Retomada cancelada.'); }
      store.input = '';
      return note('');
    }
    if (key.tab) { store.tab = (store.tab + (key.shift ? 3 : 1)) % 4; store.sel = 0; return redraw(); }
    if (key.upArrow) { store.sel = Math.max(0, store.sel - 1); return redraw(); }
    if (key.downArrow) { store.sel = Math.min(shown.length - 1, store.sel + 1); return redraw(); }
    if (key.ctrl && input === 'n') return startDispatch('');
    if (key.return) {
      const t = store.input.trim();
      store.input = '';
      if (t) return startDispatch(t);
      if (selected) return deliver(selected, '');
      return;
    }
    text(store.input, (s) => { store.input = s; redraw(); });
  });

  // ── desenho ──
  const counts = AGENTS.map((a) => all.filter((r) => r.agent === a).length);
  const busy = all.filter((r) => r.status === 'busy').length, waiting = all.filter((r) => r.status === 'waiting').length;
  const tabs = ['Todos', ...AGENTS.map((a) => LABEL[a])];
  const listHeight = Math.max(3, height - 12);
  const start = Math.max(0, store.sel - listHeight + 1);
  const off = Math.max(0, cursor - listHeight + 3);

  const header = h(Box, { paddingX: 1, gap: 2 },
    h(Text, { bold: true, color: 'cyan' }, '♪ Maestro'),
    ...tabs.map((t, i) => h(Text, {
      key: t, bold: i === store.tab, underline: i === store.tab,
      color: i === store.tab ? (i ? COLOR[AGENTS[i - 1]] : 'white') : 'gray',
    }, `${t} ${i ? counts[i - 1] : all.length}`)),
    h(Box, { flexGrow: 1, justifyContent: 'flex-end' },
      h(Text, { dimColor: true }, `${busy} rodando · `),
      h(Text, { color: waiting ? 'red' : 'gray', bold: waiting > 0 }, `${waiting} esperando você`)),
  );

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
      agent: 'Para qual agente?',
      target: `Qual sessão de ${LABEL[(step as any).agent as Agent]}?`,
      dir: `Em qual diretório abrir ${LABEL[(step as any).agent as Agent]}?`,
      path: 'Caminho do diretório:',
    }[step.kind]),
    step.kind === 'path'
      ? h(Text, null, h(Text, { color: 'cyan' }, '› '), dirText, h(Text, { inverse: true }, ' '))
      : items.slice(off, off + listHeight - 2).map((it, i) => {
          const on = off + i === cursor;
          return h(Text, { key: i, color: on ? 'cyan' : it.color, bold: on, wrap: 'truncate-end' }, (on ? '❯ ' : '  ') + it.label);
        }),
  );

  const empty = h(Text, { dimColor: true }, tabAgent
    ? `Nenhuma sessão de ${LABEL[tabAgent]} aberta. Escreva um prompt ou Ctrl+N para abrir uma.`
    : 'Nenhuma sessão aberta. Escreva um prompt ou Ctrl+N para abrir uma.');

  const body = h(Box, { borderStyle: 'round', borderColor: 'gray', flexDirection: 'column', paddingX: 1, height: listHeight + 2 },
    picker ?? (shown.length ? shown.slice(start, start + listHeight).map((r, i) => rowLine(r, start + i)) : empty));

  const detail = selected && !step
    ? h(Box, { flexDirection: 'column', paddingX: 2, height: 3 },
        h(Text, { wrap: 'truncate-end' },
          h(Text, { color: STATUS[selected.status].color }, STATUS[selected.status].label),
          selected.detail ? h(Text, { color: 'red' }, ` — ${selected.detail}`) : '',
          h(Text, { dimColor: true }, `  ·  ${selected.m ? '◆ aberta pelo Maestro (Enter entra, Ctrl+Q volta)' : '◇ aberta em outro terminal (Enter retoma aqui depois que você fechá-la lá)'}`)),
        h(Text, { dimColor: true, wrap: 'truncate-start' }, selected.cwd),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, selected.id))
    : h(Box, { height: 3 });

  const input = h(Box, { borderStyle: 'round', borderColor: step ? 'gray' : 'cyan', paddingX: 1 },
    h(Text, { color: 'cyan' }, '› '),
    store.input
      ? h(Text, { wrap: 'truncate-start' }, store.input, h(Text, { inverse: true }, ' '))
      : h(Text, { dimColor: true }, step ? '' : `Escreva um prompt e Enter para escolher ${tabAgent ? 'a sessão' : 'o agente'}…`));

  const hints = step
    ? '↑↓ escolher · Enter confirmar · Esc cancelar'
    : 'Tab abas · ↑↓ sessão · Enter entrar/enviar · Ctrl+N nova sessão · Esc limpar · Ctrl+C sair   ◆ Maestro ◇ externa';

  return h(Box, { flexDirection: 'column', height },
    header, body, detail,
    h(Box, { paddingX: 1, height: 1 }, h(Text, { color: 'yellow', wrap: 'truncate-end' }, store.notice)),
    input,
    h(Box, { paddingX: 1 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, hints)),
  );
}

export async function run() {
  if (!process.stdin.isTTY) {
    console.error('O Maestro precisa de um terminal interativo.');
    process.exit(1);
  }
  for (;;) {
    let next: Managed | undefined;
    const app = render(h(App, { onAttach: (m: Managed) => { next = store.focus = m; app.unmount(); } }), { exitOnCtrlC: false, alternateScreen: true });
    await app.waitUntilExit();
    if (!next) break;
    await attach(next);
  }
  killAll();
  process.exit(0);
}
