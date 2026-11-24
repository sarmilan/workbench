import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { noteTests, fresh } from '../bin/activity.mjs';
import { droopFor } from '../bin/mascot.mjs';
import { loadProject, runStop } from '../bin/stop-hook.mjs';
import {
  MAX_HOLDS, commandFromAgents, failureFingerprint, gateDecision, hostReply, isDefaultBranch, packageTestCommand,
  performGate, projectCommand, repeatDecision, resolveTestCommand, settingFrom, skipReason, stopHookActive,
  wasInterrupted, workspaceTestCommand,
} from '../bin/stopgate.mjs';

const HOOK = new URL('../bin/stop-hook.mjs', import.meta.url).pathname;

// What the loader resolves, without the branch state (a temp folder outside git has none).
async function load(dir) {
  const { changes, ...rest } = await loadProject(dir);
  return rest;
}

test('the command resolves setting, then AGENTS.md, then package script, then this repo, and off wins', () => {
  assert.equal(commandFromAgents('## Tests\n\nnpm test\n'), 'npm test');
  assert.equal(commandFromAgents('Tests: npm test\n'), 'npm test');
  assert.equal(commandFromAgents('- Run tests: `pnpm test`\n'), 'pnpm test');
  assert.equal(commandFromAgents('**Test command:** `make -C src check`\n'), 'make -C src check');
  assert.equal(commandFromAgents('run npm test'), null);
  assert.equal(commandFromAgents('## Setup\n\n```bash\nnpm install\n```\n'), null);
  assert.equal(commandFromAgents('## Testing\n\nSee CLAUDE.md for the deeper notes.\n'), null);
  assert.equal(commandFromAgents('```js\nTests: npm test\n```\n'), null);
  assert.equal(commandFromAgents('## Tests\n\n```test\nclaude plugin validate .\nclaude plugin test .\n```\n'), 'claude plugin validate . && claude plugin test .');
  assert.equal(commandFromAgents('```test\nnpm test\n```\n\nTests: make lint\n'), 'npm test');
  assert.equal(commandFromAgents('## Tests\n\nRun the suite.\n\nnpm test\n'), 'npm test');
  assert.equal(commandFromAgents('## Tests\n\n```ts\nconst x = 1\n```\n\nnpm test\n'), 'npm test');
  assert.equal(commandFromAgents('<!--\n```test\nnpm test\n```\n-->\nHello.\n'), null);
  assert.equal(commandFromAgents('## Tests\r\n\r\nnpm test\r\n'), 'npm test');
  assert.equal(commandFromAgents(null), null);
  assert.equal(commandFromAgents(''), null);
  assert.equal(packageTestCommand('echo "Error: no test specified" && exit 1'), null);
  assert.equal(packageTestCommand('node --test'), 'npm test');
  assert.deepEqual(resolveTestCommand({ setting: false, agentsText: '## Tests\n\nnpm test\n', packageScript: 'node --test', repoDefault: 'make test' }), { command: null, source: 'off' });
  assert.deepEqual(resolveTestCommand({ setting: 'make check', agentsText: '## Tests\n\nnpm test\n' }), { command: 'make check', source: 'setting' });
  assert.deepEqual(resolveTestCommand({ agentsText: '## Tests\n\nnpm test\n', packageScript: 'node --test', repoDefault: 'make test' }), { command: 'npm test', source: 'agents' });
  assert.deepEqual(resolveTestCommand({ agentsText: 'run npm test', packageScript: 'node --test' }), { command: 'npm test', source: 'package' });
  assert.deepEqual(resolveTestCommand({}), { command: null, source: null });
  assert.equal(settingFrom({ testCommand: 'make test' }, { command: false }), false);
  assert.equal(settingFrom({ testCommand: 'make test' }, {}), 'make test');
  const here = projectCommand({ pluginName: 'session-rail', hasRail: true });
  assert.equal(here.source, 'default');
  assert.match(here.command, /claude plugin test/);
  assert.equal(projectCommand({ pluginName: 'session-rail', hasRail: false }).command, null);
});

test('a failure blocks and a pass, a timeout, an interrupt, and stop_hook_active do not loop', () => {
  const fail = gateDecision({ command: 'npm test', exitCode: 1, output: 'ok\nnot ok 1\n' });
  assert.equal(fail.action, 'block');
  assert.match(fail.reason, /tests failed \(npm test\)/);
  assert.match(fail.reason, /not ok 1/);
  assert.equal(gateDecision({ command: 'npm test', exitCode: 0, output: '' }).action, 'allow');
  assert.equal(gateDecision({ command: 'npm test', exitCode: 1, timedOut: true, output: '' }).why, 'timeout');
  assert.equal(stopHookActive({ stop_hook_active: true }), true);
  assert.equal(stopHookActive({ stop_hook_active: 'false' }), false);
  assert.equal(wasInterrupted({ interrupted: true }), true);
  assert.equal(wasInterrupted({ reason: 'interrupt' }), true);
  assert.equal(wasInterrupted({ stop_hook_active: true }), false);
});

test('Claude exits 2 and Grok prints a block decision', () => {
  const decision = { action: 'block', reason: 'session-rail: tests failed (npm test). The stop is held.' };
  const claude = hostReply('claude', decision);
  assert.equal(claude.exitCode, 2);
  assert.match(claude.stderr, /tests failed/);
  assert.equal(JSON.parse(claude.stdout).decision, 'block');
  assert.equal(claude.stdout.includes('continue'), false);
  const grok = hostReply('grok', decision);
  assert.equal(grok.exitCode, 0);
  assert.equal(grok.stderr, '');
  assert.equal(JSON.parse(grok.stdout).decision, 'block');
  assert.equal(JSON.parse(grok.stdout).reason, decision.reason);
  assert.deepEqual(hostReply('claude', { action: 'allow' }), { exitCode: 0, stdout: '', stderr: '' });
  assert.deepEqual(hostReply('grok', { action: 'allow' }), { exitCode: 0, stdout: '', stderr: '' });
});

test('one stop runs the command once, and stop_hook_active does not run it again', async () => {
  let runs = 0;
  const lock = { value: null };
  const io = {
    now: () => 5_000,
    load: async () => ({ command: 'npm test', root: '/repo' }),
    readLock: async () => lock.value,
    writeLock: async (record) => { lock.value = record; },
    run: async () => {
      runs += 1;
      return { exitCode: 1, output: 'not ok', timedOut: false };
    },
  };
  const event = { hook_event_name: 'Stop', session_id: 's', cwd: '/repo', last_assistant_message: 'done' };
  const first = await performGate(event, io);
  assert.equal(first.action, 'block');
  const again = await performGate(event, io);
  assert.equal(again.action, 'block');
  assert.equal(again.reason, first.reason);
  const active = await performGate({ ...event, stop_hook_active: true }, io);
  assert.equal(active.why, 'stop_hook_active');
  assert.equal(runs, 1);
  const passed = await performGate({ ...event, last_assistant_message: 'fixed' }, {
    ...io,
    run: async () => ({ exitCode: 0, output: 'ok', timedOut: false }),
  });
  assert.equal(passed.action, 'allow');
  assert.equal(passed.ok, true);
});

test('a failed test droops the pet until a later pass', () => {
  const failed = noteTests(fresh(1), { at: 10, ok: false, command: 'npm test', detail: 'not ok' }, 10);
  assert.equal(droopFor(failed), true);
  assert.equal(failed.tests.ok, false);
  const passed = noteTests(failed, { at: 20, ok: true, command: 'npm test', detail: '' }, 20);
  assert.equal(droopFor(passed), false);
  assert.equal(passed.tests.ok, true);
  const twice = noteTests(failed, { at: 10, ok: false, command: 'npm test', detail: 'not ok' }, 11);
  assert.equal(twice.recent.filter((r) => r.tool === 'test').length, 1);
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-gate-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

test('the project files are read in order, and AGENTS.md supplies the command', async () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"make check"}\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
    'AGENTS.md': 'Tests: npm test\n',
    '.claude-plugin/plugin.json': '{"name":"session-rail"}\n',
    'bin/rail.mjs': '',
  });
  try {
    assert.deepEqual((await load(dir)), { root: dir, command: 'make check', source: 'setting' });
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, '.git', 'session-rail'), { recursive: true });
    writeFileSync(join(dir, '.git', 'session-rail', 'tests.json'), '{"command":false}\n');
    assert.equal((await load(dir)).command, null);
    assert.equal((await load(dir)).source, 'off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const agents = fixture({
    'AGENTS.md': '## Tests\n\nnpm test\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  try {
    assert.deepEqual((await load(agents)), { root: agents, command: 'npm test', source: 'agents' });
  } finally {
    rmSync(agents, { recursive: true, force: true });
  }
  const prose = fixture({
    'AGENTS.md': 'run npm test\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  try {
    assert.deepEqual((await load(prose)), { root: prose, command: 'npm test', source: 'package' });
  } finally {
    rmSync(prose, { recursive: true, force: true });
  }
  const pkg = fixture({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}\n' });
  try {
    assert.equal((await load(pkg)).command, null);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

function runHook(dir, event, host) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: join(dir, 'home'),
      SESSION_RAIL_TEST: '1',
      SESSION_RAIL_STOP_HOST: host,
    };
    delete env.SESSION_RAIL_HEADLESS;
    const child = spawn(process.execPath, [HOOK], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ cwd: dir, session_id: 'demo', hook_event_name: 'Stop', ...event }));
  });
}

test('a fixture repo blocks a red stop and allows a green one, on both hosts', async () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"node marker.mjs"}\n',
    'marker.mjs': "import { writeFileSync, readFileSync } from 'node:fs';\nwriteFileSync('ran', '1');\nprocess.exit(Number(readFileSync('code.txt', 'utf8')));\n",
    'code.txt': '1\n',
  });
  try {
    for (const host of ['claude', 'grok']) {
      rmSync(join(dir, 'ran'), { force: true });
      const red = await runHook(dir, { last_assistant_message: `red ${host}` }, host);
      assert.equal(existsSync(join(dir, 'ran')), true, `${host} ran the tests`);
      if (host === 'claude') {
        assert.equal(red.code, 2);
        assert.match(red.stderr, /tests failed/);
      } else {
        assert.equal(red.code, 0);
        assert.equal(red.stderr, '');
        assert.equal(JSON.parse(red.stdout).decision, 'block');
      }
      const activity = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
      assert.equal(activity.tests.ok, false);
      assert.equal(activity.recent[0].tool, 'test');

      rmSync(join(dir, 'ran'), { force: true });
      const held = await runHook(dir, { stop_hook_active: true, last_assistant_message: `held ${host}` }, host);
      assert.equal(held.code, 0);
      assert.equal(held.stderr, '');
      assert.equal(existsSync(join(dir, 'ran')), false, `${host} did not run tests while stop_hook_active`);

      writeFileSync(join(dir, 'code.txt'), '0\n');
      const green = await runHook(dir, { last_assistant_message: `green ${host}` }, host);
      assert.equal(green.code, 0);
      assert.equal(green.stderr, '');
      assert.equal(green.stdout, '');
      const after = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
      assert.equal(after.tests.ok, true);
      writeFileSync(join(dir, 'code.txt'), '1\n');
    }
    rmSync(join(dir, 'ran'), { force: true });
    const interrupted = await runHook(dir, { interrupted: true, last_assistant_message: 'stopped' }, 'claude');
    assert.equal(interrupted.code, 0);
    assert.equal(existsSync(join(dir, 'ran')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stop hook runs the command named in AGENTS.md', async () => {
  const dir = fixture({
    'AGENTS.md': '# Map\n\n## Tests\n\n```test\nnode check.mjs\n```\n',
    'package.json': '{"scripts":{"test":"node from-package.mjs"}}\n',
    'check.mjs': "import { writeFileSync, readFileSync } from 'node:fs';\nwriteFileSync('ran', 'agents');\nprocess.exit(Number(readFileSync('code.txt', 'utf8')));\n",
    'code.txt': '1\n',
  });
  try {
    assert.deepEqual((await load(dir)), { root: dir, command: 'node check.mjs', source: 'agents' });
    const red = await runHook(dir, { last_assistant_message: 'red agents' }, 'claude');
    assert.equal(red.code, 2);
    assert.match(red.stderr, /tests failed \(node check\.mjs\)/);
    assert.equal(readFileSync(join(dir, 'ran'), 'utf8'), 'agents');
    writeFileSync(join(dir, 'code.txt'), '0\n');
    const green = await runHook(dir, { last_assistant_message: 'green agents' }, 'grok');
    assert.equal(green.code, 0);
    assert.equal(green.stderr, '');
    assert.equal(green.stdout, '');
    const activity = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
    assert.equal(activity.tests.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REPO_TEST_COMMAND = [
  'claude plugin validate .',
  'claude plugin test .',
  'node bin/rail.mjs --frame 42 40',
  'node bin/rail.mjs --frame 42 40 --tab git',
  'node bin/desk.mjs --frame 80 40 --tab diff',
].join(' && ');

test('this repo takes its test command from AGENTS.md', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(text.split('\n').length < 80, 'AGENTS.md stays short');
  assert.match(text, /CLAUDE\.md/);
  assert.equal(text.includes('Say the plan is in the Plan tab'), false);
  assert.equal(commandFromAgents(text), REPO_TEST_COMMAND);
  const loaded = (await load(root));
  assert.equal(loaded.source, 'agents');
  assert.equal(loaded.command, REPO_TEST_COMMAND);
});

test('runStop agrees with the process for a pass and a headless skip', async () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"node -e \\"process.exit(1)\\""}\n',
  });
  const previous = process.env.SESSION_RAIL_HEADLESS;
  process.env.SESSION_RAIL_HEADLESS = '1';
  try {
    const skipped = await runStop({ hook_event_name: 'Stop', cwd: dir, session_id: 'h' }, { host: 'grok', cwd: dir });
    assert.equal(skipped.exitCode, 0);
    assert.equal(skipped.stdout, '');
  } finally {
    if (previous == null) delete process.env.SESSION_RAIL_HEADLESS;
    else process.env.SESSION_RAIL_HEADLESS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Nothing to check: the default branch, or a branch with no changes ─────────

test('the default branch and a branch with no changes are skipped; a folder outside git is not', () => {
  assert.equal(isDefaultBranch('main', 'origin/main'), true);
  assert.equal(isDefaultBranch('main', 'main'), true);
  assert.equal(isDefaultBranch('develop', 'origin/develop'), true);
  assert.equal(isDefaultBranch('feature/x', 'origin/main'), false);
  assert.equal(isDefaultBranch('main', null), false);
  assert.equal(skipReason(null), null);
  assert.equal(skipReason({ branch: 'main', onDefault: true }), 'default-branch');
  assert.equal(skipReason({ branch: 'fix/x', onDefault: false, base: 'abc1234', ahead: 0, dirty: false }), 'no-changes');
  assert.equal(skipReason({ branch: 'fix/x', onDefault: false, base: 'abc1234', ahead: 0, dirty: true }), null);
  assert.equal(skipReason({ branch: 'fix/x', onDefault: false, base: 'abc1234', ahead: 2, dirty: false }), null);
  // git couldn't say: run, as before.
  assert.equal(skipReason({ branch: 'fix/x', onDefault: false, base: null, ahead: null, dirty: null }), null);
  assert.equal(skipReason({ branch: 'fix/x', onDefault: false, base: 'abc1234', ahead: 0, dirty: null }), null);
});

test('with nothing changed, the gate does not run the command', async () => {
  let runs = 0;
  const io = (changes) => ({
    now: () => 1,
    load: async () => ({ command: 'npm test', root: '/repo', changes }),
    readLock: async () => null,
    writeLock: async () => {},
    run: async () => { runs += 1; return { exitCode: 1, output: 'not ok' }; },
  });
  const event = { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'done' };
  const main = await performGate(event, io({ branch: 'main', onDefault: true }));
  assert.equal(main.action, 'allow');
  assert.equal(main.quiet, true);
  assert.equal(main.why, 'default-branch');
  const clean = await performGate(event, io({ branch: 'fix/x', onDefault: false, base: 'abc1234', ahead: 0, dirty: false }));
  assert.equal(clean.why, 'no-changes');
  assert.equal(runs, 0);
  const changed = await performGate(event, io({ branch: 'fix/x', onDefault: false, base: 'abc1234', ahead: 1, dirty: false }));
  assert.equal(changed.action, 'block');
  assert.equal(runs, 1);
});

test('a workspace repo tests only the packages the branch touched', () => {
  const base = 'a1b2c3d4e5f6';
  assert.equal(workspaceTestCommand({ turbo: true, pnpm: true, base }, 'turbo run test'), `npx turbo run test --filter=...[${base}]`);
  assert.equal(workspaceTestCommand({ pnpm: true, base }, 'pnpm -r test'), `pnpm -r --filter "...[${base}]" test`);
  // A root script that doesn't fan out through turbo or pnpm -r runs as written.
  assert.equal(workspaceTestCommand({ turbo: true, pnpm: true, base }, 'vitest run'), null);
  assert.deepEqual(resolveTestCommand({ packageScript: 'vitest run', workspace: { turbo: true, base } }), { command: 'npm test', source: 'package' });
  assert.equal(workspaceTestCommand({ base }), null);
  assert.equal(workspaceTestCommand({ turbo: true, base: null }), null);
  assert.equal(workspaceTestCommand({ turbo: true, base: 'main; rm -rf /' }), null);
  assert.deepEqual(resolveTestCommand({ packageScript: 'turbo run test', workspace: { turbo: true, base } }),
    { command: `npx turbo run test --filter=...[${base}]`, source: 'workspace' });
  // A command someone named runs as written; a workspace with no merge-base keeps the package script.
  assert.equal(resolveTestCommand({ agentsText: 'Tests: pnpm test\n', packageScript: 'turbo run test', workspace: { turbo: true, base } }).command, 'pnpm test');
  assert.deepEqual(resolveTestCommand({ packageScript: 'turbo run test', workspace: { turbo: true } }), { command: 'npm test', source: 'package' });
  // No root test script: nothing to scope.
  assert.deepEqual(resolveTestCommand({ workspace: { turbo: true, base } }), { command: null, source: null });
});

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A repo on main with one commit, then a feature branch. `files` are committed on main.
function gitFixture(files) {
  const dir = fixture(files);
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'user.name', 'Test');
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.gitignore'), 'ran\nhome/\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('a git repo is skipped on main and on a clean branch, and tested once the branch changes something', async () => {
  const dir = gitFixture({
    'session-rail.json': '{"testCommand":"node marker.mjs"}\n',
    'marker.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran', '1');\nprocess.exit(1);\n",
  });
  try {
    const onMain = await runHook(dir, { last_assistant_message: 'main' }, 'claude');
    assert.equal(onMain.code, 0);
    assert.equal(onMain.stderr, '');
    assert.equal(existsSync(join(dir, 'ran')), false, 'main is not tested');
    assert.equal((await loadProject(dir)).changes.onDefault, true);

    gitIn(dir, 'switch', '-q', '-c', 'fix/x');
    const clean = await runHook(dir, { last_assistant_message: 'clean branch' }, 'grok');
    assert.equal(clean.code, 0);
    assert.equal(clean.stdout, '');
    assert.equal(existsSync(join(dir, 'ran')), false, 'a branch with no changes is not tested');

    writeFileSync(join(dir, 'change.txt'), 'x\n');
    const dirty = await runHook(dir, { last_assistant_message: 'dirty branch' }, 'claude');
    assert.equal(dirty.code, 2);
    assert.match(dirty.stderr, /tests failed/);
    assert.equal(existsSync(join(dir, 'ran')), true);

    rmSync(join(dir, 'ran'));
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'change');
    const committed = await runHook(dir, { last_assistant_message: 'committed branch' }, 'claude');
    assert.equal(committed.code, 2);
    assert.equal(existsSync(join(dir, 'ran')), true, 'a commit past the merge-base is tested');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a turbo or pnpm workspace filters the package test from the merge-base', async () => {
  const dir = gitFixture({
    'package.json': '{"scripts":{"test":"turbo run test"}}\n',
    'turbo.json': '{}\n',
    'pnpm-workspace.yaml': 'packages: ["apps/*"]\n',
  });
  try {
    const base = gitIn(dir, 'rev-parse', 'HEAD');
    gitIn(dir, 'switch', '-q', '-c', 'fix/x');
    const turbo = await loadProject(dir);
    assert.equal(turbo.source, 'workspace');
    assert.equal(turbo.command, `npx turbo run test --filter=...[${base}]`);
    assert.equal(turbo.changes.base, base);
    rmSync(join(dir, 'turbo.json'));
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"pnpm -r test"}}\n');
    const pnpm = await loadProject(dir);
    assert.equal(pnpm.command, `pnpm -r --filter "...[${base}]" test`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The same result, held at most MAX_HOLDS stops in a row ────────────────────

const TURBO_FAIL = (time) => [
  ' Tasks:    47 successful, 57 total',
  'Cached:    47 cached, 57 total',
  `  Time:    ${time}`,
  'Failed:    ledger-infra#test',
  ' ERROR  run failed: command  exited (1)',
].join('\n');

test('a fingerprint ignores durations and timestamps, and nothing else', () => {
  assert.equal(failureFingerprint(TURBO_FAIL('4.529s')), failureFingerprint(TURBO_FAIL('3.1s')));
  assert.equal(failureFingerprint('not ok 1 (12ms) at 2026-11-24T10:00:01Z'), failureFingerprint('not ok 1 (9 ms) at 2026-11-24T11:22:33Z'));
  assert.notEqual(failureFingerprint('Failed: ledger-infra#test'), failureFingerprint('Failed: ledger-d1-backup#test'));
  assert.notEqual(failureFingerprint('not ok 1'), failureFingerprint('not ok 2'));
  assert.notEqual(failureFingerprint('expected 5 m got 3 m'), failureFingerprint('expected 5 m got 4 m'));
});

test('the same failure holds twice, is let through once with a note, then quietly; a change or a pass starts over', () => {
  assert.equal(MAX_HOLDS, 2);
  const fail = (time) => gateDecision({ command: 'npm test', exitCode: 1, output: TURBO_FAIL(time) });
  let streak;
  const step = (decision) => { const r = repeatDecision(decision, streak); streak = r.streak; return r.decision; };
  assert.equal(step(fail('4.5s')).action, 'block');
  assert.equal(step(fail('4.6s')).action, 'block');
  const third = step(fail('4.4s'));
  assert.equal(third.action, 'allow');
  assert.equal(third.why, 'repeat');
  assert.equal(third.ok, false, 'the rail still shows the failure');
  assert.match(third.note, /same result as the last 2 held stops/);
  const fourth = step(fail('4.2s'));
  assert.equal(fourth.action, 'allow');
  assert.equal(fourth.note, '');
  const other = step(gateDecision({ command: 'npm test', exitCode: 1, output: 'Failed: ledger-d1-backup#test' }));
  assert.equal(other.action, 'block', 'a different failure holds again');
  const pass = step(gateDecision({ command: 'npm test', exitCode: 0, output: '' }));
  assert.equal(pass.action, 'allow');
  assert.deepEqual(streak, { fingerprint: '', count: 0 });
  assert.equal(step(fail('1s')).action, 'block', 'after a pass the same failure holds again');
});

test('the note reaches Claude as a system message and leaves Grok alone', () => {
  const allowed = { action: 'allow', why: 'repeat', note: 'session-rail: tests failed (npm test) with the same result.' };
  const claude = hostReply('claude', allowed);
  assert.equal(claude.exitCode, 0);
  assert.equal(claude.stderr, '');
  assert.equal(JSON.parse(claude.stdout).systemMessage, allowed.note);
  assert.deepEqual(hostReply('grok', allowed), { exitCode: 0, stdout: '', stderr: '' });
  assert.deepEqual(hostReply('claude', { ...allowed, note: '' }), { exitCode: 0, stdout: '', stderr: '' });
});

test('performGate keeps the streak in the lock across stops, and both hooks of one stop count once', async () => {
  const lock = { value: null };
  let runs = 0;
  const io = {
    now: () => 10_000 + runs * 10_000,
    load: async () => ({ command: 'npm test', root: '/repo', changes: null }),
    readLock: async () => lock.value,
    writeLock: async (record) => { lock.value = record; },
    run: async () => { runs += 1; return { exitCode: 1, output: TURBO_FAIL(`${runs}.0s`) }; },
  };
  const stop = (n) => ({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: `turn ${n}` });
  assert.equal((await performGate(stop(1), io)).action, 'block');
  // The second hook of the same stop reuses the decision and does not add to the streak.
  assert.equal((await performGate(stop(1), { ...io, now: () => lock.value.at + 100 })).action, 'block');
  assert.equal(lock.value.streak.count, 1);
  assert.equal((await performGate(stop(2), io)).action, 'block');
  const third = await performGate(stop(3), io);
  assert.equal(third.action, 'allow');
  assert.match(third.note, /Not holding again/);
  assert.equal((await performGate(stop(4), io)).note, '');
  assert.equal(runs, 4);
});

test('the hook stops holding a replayed result after two stops', async () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"node fail.mjs"}\n',
    'fail.mjs': "console.log('Failed: pkg#test');\nconsole.log(`Time: ${Math.random().toFixed(3)}s`);\nprocess.exit(1);\n",
  });
  try {
    const first = await runHook(dir, { last_assistant_message: 'turn 1' }, 'claude');
    assert.equal(first.code, 2);
    const second = await runHook(dir, { last_assistant_message: 'turn 2' }, 'claude');
    assert.equal(second.code, 2);
    const third = await runHook(dir, { last_assistant_message: 'turn 3' }, 'claude');
    assert.equal(third.code, 0);
    assert.match(JSON.parse(third.stdout).systemMessage, /same result as the last 2 held stops/);
    const fourth = await runHook(dir, { last_assistant_message: 'turn 4' }, 'grok');
    assert.equal(fourth.code, 0);
    assert.equal(fourth.stdout, '');
    const activity = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
    assert.equal(activity.tests.ok, false, 'the rail still shows the failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
