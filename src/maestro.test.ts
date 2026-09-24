import assert from 'node:assert/strict';
import test from 'node:test';
import { agyLimits, claudeLimits, codexLimits, codexStatus, lockedInodes, type Session } from './disk.ts';
import { MODES, args, isDetachKey, shimTarget, type Managed } from './pty.ts';
import { edit, merge, pack, remember, track, wrap, type Recent, type Row } from './ui.ts';

test('recent sessions: new ones first, live ones updated in place, external and id-less left out', () => {
  const m = { mode: ['-s', 'read-only'] } as Managed;
  const row = (id: string, o: Partial<Row> = {}): Row => ({ agent: 'codex', id, cwd: 'C:\\p', title: id, status: 'idle', m, ...o });
  const old: Recent = { agent: 'codex', id: 'a', cwd: 'C:\\p', title: 'old', seen: 1 };
  const out = track([old], [row('a', { title: 'new' }), row('b'), row('c', { m: undefined }), row('')], 120_000);
  assert.deepEqual(out.map((s) => s.id), ['b', 'a']);
  assert.equal(out[1].title, 'new');
  assert.equal(out[1].seen, 2); // minutes
  assert.deepEqual(out[0].mode, ['-s', 'read-only']);
  assert.deepEqual(track(out, [], 999_999_999), out); // closed ones stay there, untouched
});

test('prompt history: newest first, no repeats, at most 50', () => {
  assert.deepEqual(remember(['b', 'a'], 'c'), ['c', 'b', 'a']);
  assert.deepEqual(remember(['b', 'a'], 'a'), ['a', 'b']);
  const full = Array.from({ length: 50 }, (_, i) => String(i));
  assert.equal(remember(full, 'new').length, 50);
  assert.equal(remember(full, 'new').at(-1), '48');
});

test('Codex status comes from the last turn event', () => {
  const now = 1_000_000;
  assert.equal(codexStatus('{"type":"task_complete"}\n{"type":"task_started"}', 0, now), 'busy');
  assert.equal(codexStatus('{"type":"task_started"}\n{"type":"task_complete"}', 0, now), 'idle');
  assert.equal(codexStatus('no events', now - 5_000, now), 'busy'); // long turn, log just changed
  assert.equal(codexStatus('no events', now - 60_000, now), 'idle');
});

test('Linux lock detection reads inodes from /proc/locks', () => {
  const procLocks = '1: FLOCK  ADVISORY  WRITE 4242 08:01:1310723 0 EOF\n'
    + '2: POSIX  ADVISORY  WRITE 99 fd:00:42 0 EOF\n'
    + '3: OFDLCK ADVISORY  READ  -1 00:1a:77 0 EOF\n';
  assert.deepEqual([...lockedInodes(procLocks)], ['1310723', '42', '77']);
  assert.equal(lockedInodes('').size, 0);
});

test('Ctrl+Q and F12 leave the session in every keyboard format', () => {
  // Ctrl+Q
  assert.ok(isDetachKey('\x11'));
  assert.ok(isDetachKey('\x1b[17;29;0;1;8;1_\x1b[81;16;17;1;8;1_')); // win32-input-mode
  assert.ok(isDetachKey('\x1b[113;5u')); // kitty
  assert.ok(isDetachKey('\x1b[113;5:1u')); // kitty with event type
  assert.ok(isDetachKey('\x1b[27;5;113~')); // modifyOtherKeys
  // F12
  assert.ok(isDetachKey('\x1b[24~'));
  assert.ok(isDetachKey('\x1b[123;88;0;1;0;1_'));
  // F12 the terminal sent as text, wrapped char by char by ConPTY (seen in a real log)
  assert.ok(isDetachKey('\x1b[0;0;27;1;0;1_\x1b[0;0;91;1;0;1_\x1b[0;0;50;1;0;1_\x1b[0;0;52;1;0;1_\x1b[0;0;126;1;0;1_'));
  // not a leave key
  assert.ok(!isDetachKey('q'));
  assert.ok(!isDetachKey('\x1b[81;16;113;1;0;1_')); // "q" without Ctrl
  assert.ok(!isDetachKey('\x1b[81;16;17;0;8;1_')); // Ctrl+Q release
  assert.ok(!isDetachKey('\x1b[113;5:3u')); // Ctrl+Q release (kitty)
  assert.ok(!isDetachKey('\x1b[81;16;47;1;9;1_')); // AltGr+Q on ABNT2 = "/"
  assert.ok(!isDetachKey('\x1b[113;7u')); // Ctrl+Alt+Q (AltGr) in kitty
  assert.ok(!isDetachKey('\x1b[27;7;113~')); // Ctrl+Alt+Q in modifyOtherKeys
  assert.ok(!isDetachKey('\x1b[<0;10;5M')); // mouse click
});

test('npm .cmd shim resolves to the real executable', () => {
  const claude = '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*';
  const codex = 'IF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n)\ntitle %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
  assert.match(shimTarget(claude, 'C:\\npm')![0], /claude\.exe$/);
  assert.deepEqual(shimTarget(codex, 'C:\\npm')![0], process.execPath);
  assert.match(shimTarget(codex, 'C:\\npm')![1][0], /codex\.js$/);
  assert.equal(shimTarget('@echo off', 'C:\\npm'), undefined);
});

test('merge matches managed sessions without stealing preexisting ones', () => {
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

test('each agent offers only the modes it supports, and the first passes no flag', () => {
  for (const list of Object.values(MODES)) assert.deepEqual(list[0].args, []);
  assert.ok(!MODES.codex.some((m) => m.label === 'Plan')); // Codex has no plan flag
  assert.deepEqual(args('claude', undefined, 'hi', ['--permission-mode', 'plan']), ['--permission-mode', 'plan', 'hi']);
  assert.deepEqual(args('codex', undefined, 'hi', ['-s', 'read-only']), ['-s', 'read-only', 'hi']);
  assert.deepEqual(args('agy', undefined, 'hi', ['--mode', 'plan']), ['--mode', 'plan', '-i', 'hi']);
});

test('usage limits: same numbers as Trayce, expired window is zero, garbage is dropped', () => {
  const now = Date.parse('2026-09-24T12:30:00Z');
  // real line from a Codex 0.154 rollout (Trayce fixture)
  const line = '{"timestamp":"2026-09-24T12:06:13.290Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":33.0,"window_minutes":300,"resets_at":1790269549},"secondary":{"used_percent":21.0,"window_minutes":10080,"resets_at":1790685734},"plan_type":"plus"}}}';
  const rl = JSON.parse(line).payload.rate_limits;
  assert.deepEqual(codexLimits(rl, now), [
    { label: '5h', pct: 33, resetsAt: 1790269549000 },
    { label: '7d', pct: 21, resetsAt: 1790685734000 },
  ]);
  assert.deepEqual(codexLimits(rl, Date.parse('2026-09-24T17:30:00Z'))[0], { label: '5h', pct: 0 }); // past the 5h reset

  const snap = { seen_at: '2026-09-24T12:00:00Z', rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1790276400 },
    seven_day: { used_percentage: 1_790_276_400, resets_at: 1790700000 } } };
  assert.deepEqual(claudeLimits(snap, now), [{ label: '5h', pct: 24, resetsAt: 1790276400000 }]);
  assert.deepEqual(claudeLimits(snap, now + 8 * 86_400_000), []); // snapshot too old

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

test('prompt field: cursor moves, edits happen at the cursor', () => {
  assert.deepEqual(edit('helo', 3, 'l', {}), ['hello', 4]);
  assert.deepEqual(edit('ab', 0, '', { leftArrow: true }), ['ab', 0]);
  assert.deepEqual(edit('ab', 2, '', { rightArrow: true }), ['ab', 2]);
  assert.deepEqual(edit('abc', 1, '', { end: true }), ['abc', 3]);
  assert.deepEqual(edit('abc', 2, '', { home: true }), ['abc', 0]);
  assert.deepEqual(edit('abc', 1, '', { backspace: true }), ['bc', 0]);
  assert.deepEqual(edit('abc', 0, '', { backspace: true }), ['abc', 0]);
  assert.deepEqual(edit('abc', 1, '', { delete: true }), ['ac', 1]);
  assert.deepEqual(edit('abc', 3, '', { delete: true }), ['abc', 3]);
  assert.deepEqual(edit('ac', 1, 'x\r\ny\x07', {}), ['ax yc', 4]); // pasted line breaks become spaces
  assert.deepEqual(edit('a', 1, 'r', { ctrl: true }), ['a', 1]);
});

test('prompt wraps at spaces, keeps every char, hard-breaks long words; hints break between parts', () => {
  assert.deepEqual(wrap('the quick brown fox', 10), ['the quick ', 'brown fox']);
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  const s = 'a bb ccc dddd eeeee ffffff';
  for (let w = 1; w < 30; w++) {
    const lines = wrap(s, w);
    assert.equal(lines.join(''), s);
    assert.ok(lines.every((l) => l.length <= w));
  }
  assert.deepEqual(pack(['Tab tabs', 'Esc clear', 'Ctrl+C quit'], 20), ['Tab tabs · Esc clear', 'Ctrl+C quit']);
});
