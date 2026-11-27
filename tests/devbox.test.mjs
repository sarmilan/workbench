import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devboxStatus, sshProbe } from '../bin/sources.mjs';
import { byHost, parseProbe, parseResult, POLL_MS, probeScript, stale, taskRows, taskState } from '../bin/devbox.mjs';

test('a task state follows the pid, the exit code, the result and the slot marker', () => {
  assert.equal(taskState({ alive: true, exitcode: 1 }), 'running');
  assert.equal(taskState({ alive: false, exitcode: null }), 'unknown');
  assert.equal(taskState({}), 'unknown');
  assert.equal(taskState({ exitcode: 0 }), 'done');
  assert.equal(taskState({ exitcode: 0, result: { status: 'success' } }), 'done');
  assert.equal(taskState({ exitcode: 0, result: { status: 'blocked' } }), 'blocked');
  assert.equal(taskState({ exitcode: 0, result: { status: 'FAILED' } }), 'failed');
  assert.equal(taskState({ exitcode: 124 }), 'timed out');
  assert.equal(taskState({ exitcode: 75 }), 'refused');
  assert.equal(taskState({ exitcode: 1, slot: 'SLOT_REFUSED' }), 'refused');
  assert.equal(taskState({ exitcode: 1 }), 'failed');
  assert.equal(taskState({ exitcode: 2 }), 'failed');
});

test('the result envelope is parsed twice, and raw text is kept when it does not parse', () => {
  const inner = { status: 'success', pr_number: 12, pr_url: 'https://x/pull/12', summary: 'ok', blockers: [] };
  assert.deepEqual(parseResult(JSON.stringify({ type: 'result', result: JSON.stringify(inner) })), inner);
  assert.deepEqual(parseResult(JSON.stringify({ result: '```json\n' + JSON.stringify(inner) + '\n```' })), inner);
  assert.deepEqual(parseResult(JSON.stringify(inner)), inner);
  assert.deepEqual(parseResult(JSON.stringify({ result: 'I could not finish.' })), { raw: 'I could not finish.' });
  assert.deepEqual(parseResult('{"type":"res'), { raw: '{"type":"res' });
  assert.equal(parseResult(''), null);
  assert.equal(parseResult(undefined), null);
});

test('the probe output is read per task, and a cut-off task keeps what arrived', () => {
  const M = '::session-rail::';
  const out = [
    `${M} task A`, `${M} alive 0`, `${M} exit 0`, `${M} slot `,
    `${M} result`, JSON.stringify({ result: JSON.stringify({ status: 'success', pr_number: 3 }) }), '',
    `${M} log`, 'line 1', 'line 2',
    `${M} diff`, ' a.js | 2 +-', ' 1 file changed',
    `${M} end`,
    `${M} task B`, `${M} alive 1`, `${M} exit `, `${M} slot SLOT_CONTENDED`, `${M} result`, '', `${M} log`, 'working',
  ].join('\n');
  const p = parseProbe(out);
  assert.deepEqual(p.A.log, ['line 1', 'line 2']);
  assert.deepEqual(p.A.diff, [' a.js | 2 +-', ' 1 file changed']);
  assert.equal(p.A.exitcode, 0);
  assert.equal(p.A.result.pr_number, 3);
  assert.equal(p.B.alive, true);
  assert.equal(p.B.exitcode, null);
  assert.equal(p.B.slot, 'SLOT_CONTENDED');
  assert.equal(p.B.result, null);
  assert.deepEqual(p.B.log, ['working']);
  assert.deepEqual(p.B.diff, []);
  assert.deepEqual(parseProbe(''), {});
  assert.deepEqual(parseProbe('ssh: connect to host devbox port 22: timed out'), {});
});

test('the probe script runs in bash and reads the files the wrapper writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devbox-'));
  writeFileSync(join(dir, 'A.pid'), '999999\n');
  writeFileSync(join(dir, 'A.exitcode'), '1\n');
  writeFileSync(join(dir, 'A.log'), 'start\nSLOT_REFUSED box full\n');
  writeFileSync(join(dir, "B'q.pid"), `${process.pid}\n`);
  const tasks = [
    { task: 'A', pidfile: join(dir, 'A.pid'), log: join(dir, 'A.log'), result: join(dir, 'A.json'), worktree: join(dir, 'none') },
    { task: 'B', pidfile: join(dir, "B'q.pid"), log: join(dir, 'B.log'), result: join(dir, 'B.json'), worktree: dir },
    { task: 'x; rm -rf /', pidfile: '/dev/null' },
  ];
  const script = probeScript(tasks);
  assert.ok(!script.includes('rm -rf'));
  const p = parseProbe(execFileSync('bash', ['-s'], { input: script, encoding: 'utf8' }));
  assert.deepEqual(Object.keys(p), ['A', 'B']);
  assert.equal(taskState(p.A), 'refused');
  assert.deepEqual(p.A.log, ['start', 'SLOT_REFUSED box full']);
  assert.equal(taskState(p.B), 'running');
});

test('a home-relative path is expanded on the box, not quoted literally', () => {
  const s = probeScript([{ task: 'T', pidfile: '~/logs/T.pid', log: '~/logs/T.log', result: '~/logs/T.json', worktree: '~/ledger-T' }]);
  assert.match(s, /cat "\$HOME"\/'logs\/T\.pid'/);
  assert.match(s, /cat "\$HOME"\/'logs\/T\.exitcode'/);
  assert.match(s, /cd "\$HOME"\/'ledger-T'/);
});

test('rows carry the state and the PR, open PR first, then the result', () => {
  const trackers = [
    { task: 'B', branch: 'feat/hetzner-B', started: '2026-11-26T10:05:00Z', host: 'box2' },
    { task: 'A', branch: 'feat/hetzner-A', started: '2026-11-26T10:00:00Z' },
    { task: 'C', branch: 'feat/hetzner-C', started: '2026-11-26T10:10:00Z' },
    { nope: true },
  ];
  const probe = {
    A: { alive: false, exitcode: 0, result: { status: 'success', pr_number: 7, pr_url: 'https://x/pull/7' }, log: [], diff: [] },
    B: { alive: true, exitcode: null, result: null, log: ['x'], diff: [] },
  };
  const prs = [{ number: 9, url: 'https://x/pull/9', headRefName: 'feat/hetzner-B' }];
  const rows = taskRows(trackers, probe, prs);
  assert.deepEqual(rows.map((r) => [r.task, r.host, r.state, r.pr?.number ?? null]), [
    ['A', 'devbox', 'done', 7], ['B', 'box2', 'running', 9], ['C', 'devbox', 'unknown', null],
  ]);
  assert.equal(rows[0].started, Date.parse('2026-11-26T10:00:00Z'));
  assert.equal(rows[0].pr.url, 'https://x/pull/7');
});

test('the cache is stale after the poll interval, and trackers group by host', () => {
  assert.equal(stale(1000, 1000 + POLL_MS - 1), false);
  assert.equal(stale(1000, 1000 + POLL_MS), true);
  assert.equal(stale(undefined, 5), true);
  assert.deepEqual(Object.keys(byHost([{ task: 'a' }, { task: 'b', host: 'h' }, { task: 'c' }])), ['devbox', 'h']);
});

// ── devboxStatus: trackers, the shared cache and the unreachable fallback, with a fake ssh ──

const M = '::session-rail::';
const probeOut = (task, { alive = 0, exit = '', result = '' } = {}) =>
  [`${M} task ${task}`, `${M} alive ${alive}`, `${M} exit ${exit}`, `${M} slot `, `${M} result`, result, `${M} log`, 'tail', `${M} diff`, `${M} end`].join('\n');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'devbox-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const track = (dir, t) => {
  mkdirSync(join(dir, '.claude', 'hetzner-dispatch'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'hetzner-dispatch', `${t.task}.json`), JSON.stringify({ branch: `feat/hetzner-${t.task}`, started: '2026-11-26T10:00:00Z', ...t }));
};

test('no trackers means no ssh call and an inactive view', async () => {
  const dir = repo();
  let calls = 0;
  const r = await devboxStatus(dir, { probe: async () => { calls++; return { code: 0, out: '' }; }, prList: async () => ({ ok: true, items: [] }) });
  assert.equal(r.active, false);
  assert.equal(calls, 0);
});

test('a fresh cache is reused, a stale one or a new tracker refreshes it', async () => {
  const dir = repo();
  track(dir, { task: 'A' });
  const calls = [];
  const probe = async (host, script) => { calls.push(host); return { code: 0, out: probeOut('A', { alive: 1 }) + '\n' + (script.includes("task B'") ? probeOut('B', { exit: 0, result: JSON.stringify({ result: JSON.stringify({ status: 'success', pr_number: 4 }) }) }) : '') }; };
  const prList = async () => ({ ok: true, items: [{ number: 9, url: 'u9', headRefName: 'feat/hetzner-A' }, { number: 1, url: 'u1', headRefName: 'other' }] });
  const t0 = 1_000_000;
  let r = await devboxStatus(dir, { probe, prList, now: t0 });
  assert.deepEqual(r.rows.map((x) => [x.task, x.state, x.pr?.number]), [['A', 'running', 9]]);
  r = await devboxStatus(dir, { probe, prList, now: t0 + 10_000 });
  assert.equal(calls.length, 1);
  const cache = JSON.parse(readFileSync(join(dir, '.git', 'session-rail', 'devbox.json'), 'utf8'));
  assert.deepEqual(cache.prs.map((p) => p.number), [9]);
  track(dir, { task: 'B', host: 'box2' });
  r = await devboxStatus(dir, { probe, prList, now: t0 + 20_000 });
  assert.deepEqual(calls.slice(1).sort(), ['box2', 'devbox']);
  assert.deepEqual(r.rows.map((x) => [x.task, x.host]), [['A', 'devbox'], ['B', 'box2']]);
  await devboxStatus(dir, { probe, prList, now: t0 + 20_000 + 45_000 });
  assert.equal(calls.length, 5);
  rmSync(join(dir, '.claude', 'hetzner-dispatch', 'B.json'));
  r = await devboxStatus(dir, { probe, prList, now: t0 + 70_000 });
  assert.deepEqual(r.rows.map((x) => x.task), ['A']);
});

test('an unreachable box is one line with the last error, and the last known tasks stay', async () => {
  const dir = repo();
  track(dir, { task: 'A' });
  const ok = async () => ({ code: 0, out: probeOut('A', { alive: 1 }) });
  const down = async () => ({ code: 255, out: '', err: 'debug\nssh: connect to host devbox port 22: Operation timed out\n' });
  const prList = async () => ({ ok: false, items: [] });
  await devboxStatus(dir, { probe: ok, prList, now: 1_000_000 });
  const r = await devboxStatus(dir, { probe: down, prList, now: 1_100_000 });
  assert.deepEqual(r.unreachable, [{ host: 'devbox', error: 'ssh: connect to host devbox port 22: Operation timed out' }]);
  assert.deepEqual(r.rows.map((x) => [x.task, x.state]), [['A', 'running']]);
  const thrown = await devboxStatus(dir, { probe: async () => { throw new Error('boom'); }, prList, now: 1_200_000 });
  assert.equal(thrown.unreachable[0].error, 'boom');
});

test('a refresh another pane claimed is not started again', async () => {
  const dir = repo();
  track(dir, { task: 'A' });
  mkdirSync(join(dir, '.git', 'session-rail'), { recursive: true });
  writeFileSync(join(dir, '.git', 'session-rail', 'devbox.json'), JSON.stringify({ at: 0, claim: 1_000_000 - 5_000, probe: {} }));
  let calls = 0;
  const r = await devboxStatus(dir, { probe: async () => { calls++; return { code: 0, out: '' }; }, prList: async () => ({ ok: true, items: [] }), now: 1_000_000 });
  assert.equal(calls, 0);
  assert.deepEqual(r.rows.map((x) => [x.task, x.state]), [['A', 'unknown']]);
});

test('a task the probe cannot report does not run ssh on every poll', async () => {
  const dir = repo();
  track(dir, { task: 'ok' });
  writeFileSync(join(dir, '.claude', 'hetzner-dispatch', 'spaced.json'), JSON.stringify({ task: 'fix login bug' }));
  let calls = 0;
  const probe = async () => { calls++; return { code: 0, out: probeOut('ok', { alive: 1 }) }; };
  const prList = async () => ({ ok: true, items: [] });
  await devboxStatus(dir, { probe, prList, now: 1_000_000 });
  const r = await devboxStatus(dir, { probe, prList, now: 1_005_000 });
  assert.equal(calls, 1);
  assert.deepEqual(r.rows.map((x) => [x.task, x.state]).sort(), [['fix login bug', 'unknown'], ['ok', 'running']]);
});

test('the ssh runner refuses a host name that could be an option', async () => {
  const r = await sshProbe('-oProxyCommand=x', 'true');
  assert.equal(r.code, 255);
  assert.match(r.err, /bad host name/);
});
