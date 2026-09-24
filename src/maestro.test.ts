import assert from 'node:assert/strict';
import test from 'node:test';
import { codexStatus, type Session } from './disk.ts';
import { isDetachKey, shimTarget, type Managed } from './pty.ts';
import { merge } from './ui.ts';

test('status do Codex vem do último evento de turno', () => {
  const now = 1_000_000;
  assert.equal(codexStatus('{"type":"task_complete"}\n{"type":"task_started"}', 0, now), 'busy');
  assert.equal(codexStatus('{"type":"task_started"}\n{"type":"task_complete"}', 0, now), 'idle');
  assert.equal(codexStatus('sem eventos', now - 5_000, now), 'busy'); // turno longo, log mexeu agora
  assert.equal(codexStatus('sem eventos', now - 60_000, now), 'idle');
});

test('Ctrl+Q é reconhecido em byte cru e em win32-input-mode', () => {
  assert.ok(isDetachKey('\x11'));
  assert.ok(isDetachKey('\x1b[17;29;0;1;8;1_\x1b[81;16;17;1;8;1_'));
  assert.ok(!isDetachKey('\x1b[81;16;113;1;0;1_')); // "q" sem Ctrl
  assert.ok(!isDetachKey('\x1b[81;16;17;0;8;1_')); // soltar a tecla não conta
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
