import assert from 'node:assert/strict';
import test from 'node:test';
import { agyLimits, claudeLimits, codexLimits, codexStatus, type Session } from './disk.ts';
import { MODES, args, isDetachKey, shimTarget, type Managed } from './pty.ts';
import { merge } from './ui.ts';

test('status do Codex vem do último evento de turno', () => {
  const now = 1_000_000;
  assert.equal(codexStatus('{"type":"task_complete"}\n{"type":"task_started"}', 0, now), 'busy');
  assert.equal(codexStatus('{"type":"task_started"}\n{"type":"task_complete"}', 0, now), 'idle');
  assert.equal(codexStatus('sem eventos', now - 5_000, now), 'busy'); // turno longo, log mexeu agora
  assert.equal(codexStatus('sem eventos', now - 60_000, now), 'idle');
});

test('Ctrl+Q e F12 saem da sessão em todos os formatos de teclado', () => {
  // Ctrl+Q
  assert.ok(isDetachKey('\x11'));
  assert.ok(isDetachKey('\x1b[17;29;0;1;8;1_\x1b[81;16;17;1;8;1_')); // win32-input-mode
  assert.ok(isDetachKey('\x1b[113;5u')); // kitty
  assert.ok(isDetachKey('\x1b[113;5:1u')); // kitty com tipo de evento
  assert.ok(isDetachKey('\x1b[27;5;113~')); // modifyOtherKeys
  // F12
  assert.ok(isDetachKey('\x1b[24~'));
  assert.ok(isDetachKey('\x1b[123;88;0;1;0;1_'));
  // F12 que o terminal mandou como texto, embrulhado caractere por caractere pelo ConPTY (visto no log real)
  assert.ok(isDetachKey('\x1b[0;0;27;1;0;1_\x1b[0;0;91;1;0;1_\x1b[0;0;50;1;0;1_\x1b[0;0;52;1;0;1_\x1b[0;0;126;1;0;1_'));
  // não são tecla de saída
  assert.ok(!isDetachKey('q'));
  assert.ok(!isDetachKey('\x1b[81;16;113;1;0;1_')); // "q" sem Ctrl
  assert.ok(!isDetachKey('\x1b[81;16;17;0;8;1_')); // soltar Ctrl+Q
  assert.ok(!isDetachKey('\x1b[113;5:3u')); // soltar Ctrl+Q (kitty)
  assert.ok(!isDetachKey('\x1b[81;16;47;1;9;1_')); // AltGr+Q no ABNT2 = "/"
  assert.ok(!isDetachKey('\x1b[113;7u')); // Ctrl+Alt+Q (AltGr) no kitty
  assert.ok(!isDetachKey('\x1b[27;7;113~')); // Ctrl+Alt+Q no modifyOtherKeys
  assert.ok(!isDetachKey('\x1b[<0;10;5M')); // clique de mouse
});

test('shim .cmd do npm vira o executável real', () => {
  const claude = '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*';
  const codex = 'IF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n)\ntitle %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
  assert.match(shimTarget(claude, 'C:\\npm')![0], /claude\.exe$/);
  assert.deepEqual(shimTarget(codex, 'C:\\npm')![0], process.execPath);
  assert.match(shimTarget(codex, 'C:\\npm')![1][0], /codex\.js$/);
  assert.equal(shimTarget('@echo off', 'C:\\npm'), undefined);
});

test('merge casa sessões gerenciadas sem roubar as que já existiam', () => {
  const s = (id: string, cwd = 'C:\\p'): Session => ({ agent: 'codex', id, cwd, title: id, status: 'idle' });
  const m = (o: Partial<Managed>) => ({ agent: 'codex', cwd: 'C:\\p', title: '', proc: {} as any, ...o }) as Managed;

  const pre = m({ preexisting: new Set(['old']) });
  let rows = merge([s('old'), s('new')], [pre]);
  assert.equal(rows.find((r) => r.id === 'old')!.m, undefined);
  assert.equal(rows.find((r) => r.id === 'new')!.m, pre);
  assert.equal(pre.id, 'new');

  const starting = m({ title: 'codex' });
  rows = merge([], [starting]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].m, starting);

  const known = m({ agent: 'claude', id: 'abc' });
  rows = merge([{ ...s('abc'), agent: 'claude' }], [known]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].m, known);
});

test('cada agente oferece só os modos que suporta, e o primeiro não passa flag', () => {
  for (const list of Object.values(MODES)) assert.deepEqual(list[0].args, []);
  assert.ok(!MODES.codex.some((m) => m.label === 'Plan')); // o Codex não tem plan por flag
  assert.deepEqual(args('claude', undefined, 'oi', ['--permission-mode', 'plan']), ['--permission-mode', 'plan', 'oi']);
  assert.deepEqual(args('codex', undefined, 'oi', ['-s', 'read-only']), ['-s', 'read-only', 'oi']);
  assert.deepEqual(args('agy', undefined, 'oi', ['--mode', 'plan']), ['--mode', 'plan', '-i', 'oi']);
});

test('limites de uso: mesmos números do Trayce, janela vencida zera, lixo é descartado', () => {
  const now = Date.parse('2026-09-24T12:30:00Z');
  // linha real de um rollout do Codex 0.154 (fixture do Trayce)
  const line = '{"timestamp":"2026-09-24T12:06:13.290Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":33.0,"window_minutes":300,"resets_at":1790269549},"secondary":{"used_percent":21.0,"window_minutes":10080,"resets_at":1790685734},"plan_type":"plus"}}}';
  const rl = JSON.parse(line).payload.rate_limits;
  assert.deepEqual(codexLimits(rl, now), [
    { label: '5h', pct: 33, resetsAt: 1790269549000 },
    { label: '7d', pct: 21, resetsAt: 1790685734000 },
  ]);
  assert.deepEqual(codexLimits(rl, Date.parse('2026-09-24T17:30:00Z'))[0], { label: '5h', pct: 0 }); // passou do reset de 5h

  const snap = { seen_at: '2026-09-24T12:00:00Z', rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1790276400 },
    seven_day: { used_percentage: 1_790_276_400, resets_at: 1790700000 } } };
  assert.deepEqual(claudeLimits(snap, now), [{ label: '5h', pct: 24, resetsAt: 1790276400000 }]);
  assert.deepEqual(claudeLimits(snap, now + 8 * 86_400_000), []); // snapshot velho demais

  const cache = { buckets: [
    { group: 'Gemini Models', label: '5h window', remaining_fraction: 0.86, reset_time: '2026-09-24T17:00:00Z' },
    { group: 'Gemini Models', label: 'Weekly (7d)', remaining_fraction: 0.55 },
    { group: 'Claude and GPT models', label: '5h window', remaining_fraction: 1 } ] };
  assert.deepEqual(agyLimits(cache, now), [
    { label: '5h', pct: 14, resetsAt: Date.parse('2026-09-24T17:00:00Z') },
    { label: '7d', pct: 45, resetsAt: undefined },
  ]);
  assert.deepEqual(agyLimits(undefined, now), []);
});
