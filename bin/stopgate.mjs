// The Stop test gate. Pure, no Node APIs: the Claude hook (hooks/register.ts) and the command
// hook (bin/stop-hook.mjs) both follow it. A stop is held when the project's test command fails,
// once. stop_hook_active, an interrupt, or no command at all lets it through, so a folder with
// nothing configured is never blocked and a block cannot loop. The default branch, and a branch
// with nothing changed against it, are not tested at all. The same failure holds at most MAX_HOLDS
// stops in a row.
//
// commandFromAgents reads a test command from the project's AGENTS.md. A fence tagged test,
// then a Tests: line, then the first command under a Tests heading. Prose is not a command,
// so a file that never names one does not gate the stop.

import { clean } from './term.mjs';

// This repo's own checks, used only when nothing else names a command. AGENTS.md is the list
// a session runs; its fence also starts with `claude plugin validate .`.
export const WORKBENCH_TEST_COMMAND = 'claude plugin test . && node bin/rail.mjs --frame 42 40 && node bin/rail.mjs --frame 42 40 --tab git && node bin/desk.mjs --frame 80 40 --tab diff';

// A finished decision can be reused for this long, so the command hook and the Claude hook of
// one stop share a single run. A later stop is outside the window and runs again.
export const DEDUPE_MS = 1500;
// How long the other hook will wait for a run that has started and not finished.
export const RUN_WAIT_MS = 175_000;
export const RUN_TIMEOUT_MS = 170_000;

const INTERRUPT = new Set([
  'interrupt', 'interrupted', 'abort', 'aborted', 'cancel', 'cancelled', 'canceled',
  'user_interrupt', 'user-interrupt',
]);

const allowQuiet = (why) => ({
  action: 'allow', quiet: true, why, reason: '', ok: null, command: '', detail: '', at: 0,
});

export function sessionIdOf(event) {
  return String(event?.session_id || event?.sessionId || '');
}

// Stop, not SubagentStop. A missing name is Stop: the command hook is only wired to that event.
export function isMainStop(event) {
  const raw = String(event?.hook_event_name || event?.hookEventName || 'Stop');
  return raw.toLowerCase().replace(/_/g, '') === 'stop';
}

export function stopHookActive(event) {
  const v = event?.stop_hook_active ?? event?.stopHookActive;
  return v === true || v === 'true' || v === 1 || v === '1';
}

// The person stopped the turn. Claude often skips Stop entirely; Grok may still deliver it.
export function wasInterrupted(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.interrupted === true || event.isAborted === true || event.is_aborted === true) return true;
  const reason = String(event.reason || event.stop_reason || event.stopReason || '').toLowerCase();
  return INTERRUPT.has(reason);
}

export function stopKey(event) {
  const active = stopHookActive(event) ? '1' : '0';
  const msg = String(event?.last_assistant_message || event?.lastAssistantMessage || '').slice(0, 200);
  return `${sessionIdOf(event)}\n${active}\n${msg}`;
}

export function lockPath(home, sessionId) {
  const id = String(sessionId || 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session';
  return `${String(home).replace(/\/$/, '')}/.claude/session-rail/stop/${id}.json`;
}

// A string is the command. false, or an empty / off string, turns the gate off. Anything else is unset.
export function coerceSetting(value) {
  if (value === false || value === null) return false;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t || /^(off|false|0)$/i.test(t)) return false;
    return t;
  }
  return undefined;
}

// The checkout file wins over the committed project file, so one checkout can turn the gate off.
export function settingFrom(project, local) {
  if (local && typeof local === 'object' && Object.prototype.hasOwnProperty.call(local, 'command')) {
    return coerceSetting(local.command);
  }
  if (project && typeof project === 'object' && Object.prototype.hasOwnProperty.call(project, 'testCommand')) {
    return coerceSetting(project.testCommand);
  }
  return undefined;
}

// Long enough for a joined check list, short enough that a pasted essay cannot become the command.
const MAX_COMMAND = 2000;

const TEST_TITLES = new Set(['test', 'tests', 'testing', 'test command', 'tests command']);

// A line of explanation, not a program. `run` is left out so `run npm test` under a Tests
// heading can still be a command; a bare sentence with no heading still matches nothing.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'see', 'this', 'that', 'these', 'those', 'keep', 'when', 'if', 'for',
  'and', 'or', 'to', 'with', 'from', 'your', 'our', 'its', 'it', 'is', 'are', 'be', 'do',
  'does', 'did', 'not', 'no', 'yes', 'all', 'any', 'some', 'then', 'also', 'just', 'please',
  'you', 'we', 'they', 'on', 'in', 'of', 'at', 'as', 'by', 'how', 'what', 'where',
]);

const LABEL = /^(?:[-*+]|\d+[.)])?\s*(?:run\s+)?(?:testing|tests?)(?:\s+command)?\s*[:：]\s*(.+)$/i;

function linesOf(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function headingOf(line) {
  const m = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  const title = m[2].replace(/\s+#+\s*$/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return { level: m[1].length, title };
}

function fenceOf(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const info = (m[2] || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  return { char: marker[0], len: marker.length, info };
}

function isTestInfo(info) {
  return info === 'test' || info === 'tests';
}

function isShellInfo(info) {
  return info === '' || info === 'sh' || info === 'bash' || info === 'shell' || info === 'zsh' || info === 'console' || isTestInfo(info);
}

// "See the notes." is a sentence. "claude plugin validate ." is a command: the dot is its own word.
function endsSentence(body) {
  if (/[!?]$/.test(body)) return true;
  return /[A-Za-z0-9)]\.$/.test(body);
}

function isCommandToken(token) {
  if (token.startsWith('./') || token.startsWith('~/') || token.startsWith('/')) {
    return /^[A-Za-z0-9._~+/-]+$/.test(token);
  }
  return /^[a-z0-9][a-z0-9+._-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(token);
}

function commandBody(line) {
  let t = line.trim();
  const bullet = /^[-*+]\s+(.+)$/.exec(t);
  if (bullet) t = bullet[1].trim();
  const quoted = /^`([^`]+)`$/.exec(t);
  if (quoted) t = quoted[1].trim();
  return t;
}

function validCommand(body) {
  const t = String(body || '').trim();
  if (!t || t.length > MAX_COMMAND || /[\0\r\n]/.test(t) || endsSentence(t)) return null;
  const token = t.split(/\s+/)[0];
  if (!token || STOP_WORDS.has(token.toLowerCase()) || !isCommandToken(token)) return null;
  return t;
}

function joinCommands(cmds) {
  if (!cmds.length) return null;
  const joined = cmds.join(' && ');
  return joined.length <= MAX_COMMAND ? joined : null;
}

// A fence is an explicit block: keep every command line, skip blanks, comments, and prose.
function commandsFromFence(lines) {
  const cmds = [];
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const body = validCommand(commandBody(line));
    if (body) cmds.push(body);
  }
  return joinCommands(cmds);
}

// Bare lines under a heading: the first run of commands, stopping at the next sentence.
function commandsFromProse(lines) {
  const cmds = [];
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) {
      if (cmds.length) break;
      continue;
    }
    const body = validCommand(commandBody(line));
    if (!body) {
      if (cmds.length) break;
      continue;
    }
    cmds.push(body);
  }
  return joinCommands(cmds);
}

function labelCommand(line) {
  const stripped = line.trim().replace(/\*\*/g, '').replace(/__/g, '');
  const m = LABEL.exec(stripped);
  if (!m) return null;
  const rest = m[1].trim();
  const tick = /`([^`]+)`/.exec(rest);
  return validCommand(tick ? tick[1].trim() : rest);
}

/**
 * The test command an AGENTS.md names, or null when it names none.
 * A project is not gated just because the file exists.
 * First match: a fence tagged `test`, then a Tests: line, then the first command under a
 * heading named Tests, Testing, or Test command.
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function commandFromAgents(text) {
  if (text == null || typeof text !== 'string') return null;
  const src = text.replace(/<!--[\s\S]*?-->/g, '');
  if (!src.trim()) return null;
  const lines = linesOf(src);
  let tagged = null;
  let labeled = null;
  let section = null;
  let fence = null;
  let sectionLevel = 0;
  let prose = [];

  const flushProse = () => {
    if (!section && sectionLevel) {
      const cmd = commandsFromProse(prose);
      if (cmd) section = cmd;
    }
    prose = [];
  };

  for (const line of lines) {
    if (fence) {
      const close = fenceOf(line);
      if (close && close.char === fence.char && close.len >= fence.len && close.info === '') {
        const cmd = commandsFromFence(fence.buf);
        if (cmd && fence.tagged && !tagged) tagged = cmd;
        if (cmd && fence.inSection && !section) section = cmd;
        fence = null;
      } else {
        fence.buf.push(line);
      }
      continue;
    }
    const opened = fenceOf(line);
    if (opened) {
      flushProse();
      fence = {
        char: opened.char, len: opened.len, buf: [],
        tagged: isTestInfo(opened.info),
        inSection: sectionLevel > 0 && isShellInfo(opened.info),
      };
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      flushProse();
      if (sectionLevel && heading.level <= sectionLevel) sectionLevel = 0;
      if (!sectionLevel && TEST_TITLES.has(heading.title)) sectionLevel = heading.level;
      continue;
    }
    if (!labeled) {
      const cmd = labelCommand(line);
      if (cmd) labeled = cmd;
    }
    if (sectionLevel && !section) {
      if (!line.trim()) flushProse();
      else prose.push(line);
    }
  }
  if (fence) {
    const cmd = commandsFromFence(fence.buf);
    if (cmd && fence.tagged && !tagged) tagged = cmd;
    if (cmd && fence.inSection && !section) section = cmd;
  }
  flushProse();
  return tagged || labeled || section || null;
}

// npm's own placeholder fails on purpose. It is not a project test suite.
export function packageTestCommand(script) {
  const s = typeof script === 'string' ? script.trim() : '';
  if (!s || /no test specified/i.test(s)) return null;
  return 'npm test';
}

// A merge-base is a full or short sha; anything else never reaches a shell line.
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * In a workspace repo the package fallback tests the packages the branch touched (and what depends on
 * them), never the whole tree. null outside a workspace, or without a merge-base to filter from.
 * @param {{ turbo?: boolean, pnpm?: boolean, base?: string | null }} workspace
 */
export function workspaceTestCommand({ turbo, pnpm, base } = {}) {
  if (!base || !SHA.test(base)) return null;
  if (turbo) return `npx turbo run test --filter=...[${base}]`;
  if (pnpm) return `pnpm -r --filter "...[${base}]" test`;
  return null;
}

// `origin/main` and `main` name the same branch. `defaultRef` is what sources.mjs defaultBranch returns.
export function isDefaultBranch(branch, defaultRef) {
  const name = String(defaultRef || '').replace(/^origin\//, '');
  return Boolean(branch && name && branch === name);
}

const DEFAULT_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

/**
 * The default branch's ref: origin/HEAD, else the first of main/master that exists (remote, then local).
 * The one rule, shared by sources.mjs (the rail and the desk) and branchChanges here.
 * `git(args)` resolves trimmed stdout, or null on failure.
 * @param {(args: string[]) => Promise<string | null>} git
 */
export async function defaultRef(git) {
  const head = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  for (const c of new Set([head, ...DEFAULT_CANDIDATES].filter(Boolean))) {
    if ((await git(['rev-parse', '--verify', '--quiet', c])) != null) return c;
  }
  return null;
}

/**
 * What the branch changed against the default branch, for skipReason and the workspace filter.
 * `git(args, timeoutMs)` runs git in the checkout and resolves its trimmed stdout, or null on failure;
 * each host passes its own runner. The default branch is defaultRef's. null outside a git checkout.
 * @param {(args: string[], timeoutMs?: number) => Promise<string | null>} git
 */
export async function branchChanges(git) {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return null;
  const ref = await defaultRef(git);
  if (!ref) return { branch, onDefault: false, base: null, ahead: null, dirty: null };
  if (isDefaultBranch(branch, ref)) return { branch, onDefault: true, base: null, ahead: null, dirty: null };
  const base = await git(['merge-base', 'HEAD', ref]);
  const count = base ? await git(['rev-list', '--count', `${base}..HEAD`]) : null;
  const status = await git(['status', '--porcelain'], 15_000);
  return {
    branch, onDefault: false, base: base || null,
    ahead: count != null && /^\d+$/.test(count) ? Number(count) : null,
    dirty: status == null ? null : status !== '',
  };
}

/**
 * Why there is nothing to test, or null to run. `changes` is null outside a git checkout (or when git
 * can't say), which runs as before. On the default branch, or a branch with no commits past its
 * merge-base and a clean tree, the session has changed nothing the gate could hold it for.
 * @param {{ branch?: string, onDefault?: boolean, base?: string | null, ahead?: number | null, dirty?: boolean | null } | null} changes
 */
export function skipReason(changes) {
  if (!changes || !changes.branch) return null;
  if (changes.onDefault) return 'default-branch';
  if (changes.base && changes.ahead === 0 && changes.dirty === false) return 'no-changes';
  return null;
}

export function workbenchDefault({ pluginName, hasRail } = {}) {
  if (pluginName === 'session-rail' && hasRail) return WORKBENCH_TEST_COMMAND;
  return null;
}

/**
 * First match wins. `setting` false turns the rest off, including this repo's default.
 * @returns {{ command: string | null, source: string | null }}
 */
export function resolveTestCommand({ setting, agentsText, packageScript, repoDefault, workspace } = {}) {
  if (setting === false) return { command: null, source: 'off' };
  if (typeof setting === 'string' && setting.trim()) return { command: setting.trim(), source: 'setting' };
  const agents = commandFromAgents(agentsText);
  if (agents) return { command: agents, source: 'agents' };
  const pkg = packageTestCommand(packageScript);
  const scoped = pkg && workspaceTestCommand(workspace);
  if (scoped) return { command: scoped, source: 'workspace' };
  if (pkg) return { command: pkg, source: 'package' };
  if (typeof repoDefault === 'string' && repoDefault.trim()) return { command: repoDefault.trim(), source: 'default' };
  return { command: null, source: null };
}

export function projectCommand({ project, local, agentsText, packageScript, pluginName, hasRail, workspace } = {}) {
  return resolveTestCommand({
    setting: settingFrom(project, local),
    agentsText,
    packageScript,
    repoDefault: workbenchDefault({ pluginName, hasRail }),
    workspace,
  });
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The command itself stays unquoted so its own && and pipes run. The directory is quoted.
export function shellLine(root, command) {
  const dir = String(root || '').replace(/[\0\r\n]/g, '');
  return `cd ${shellQuote(dir)} && ${command}`;
}

export function tailText(output, lines = 30, chars = 1000) {
  const text = clean(String(output ?? '')).replace(/\r/g, '');
  const body = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const tail = body.slice(-lines).join('\n').trim();
  if (tail.length <= chars) return tail;
  return tail.slice(-chars);
}

// How many stops in a row the same failure holds. The next identical one is let through with a note.
export const MAX_HOLDS = 2;

const shownCommand = (command) => (command.length > 180 ? `${command.slice(0, 177)}…` : command);

/**
 * What makes two failures the same result: the output tail without durations and timestamps, which
 * change on every run (turbo's `Time: 4.529s`, a test's `(12ms)`) even when nothing else does.
 * @param {string} text
 */
export function failureFingerprint(text) {
  return String(text ?? '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?|h)\b/gi, '<dur>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function block(command, detail, why) {
  const head = `session-rail: tests failed (${shownCommand(command)}). The stop is held. Fix the failures and finish again.`;
  const reason = detail ? `${head}\n${detail}` : head;
  const line = detail.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return {
    action: 'block', quiet: false, why, reason: reason.slice(0, 2500), ok: false,
    command, detail: clean(line).replace(/\s+/g, ' ').trim().slice(0, 200), at: 0,
    fingerprint: `${why}\n${failureFingerprint(detail)}`,
  };
}

/**
 * The same failure is held MAX_HOLDS stops in a row, then let through: holding again can't help, and a
 * cached suite (turbo) replays it exactly. The first one let through carries a note, the rest none.
 * A pass, or a different failure, starts over. `streak` is `{ fingerprint, count }` from the lock record.
 * @returns {{ decision: object, streak: { fingerprint: string, count: number } }}
 */
export function repeatDecision(decision, streak) {
  if (!decision || decision.action !== 'block' || !decision.fingerprint) {
    return { decision, streak: { fingerprint: '', count: 0 } };
  }
  const same = streak && streak.fingerprint === decision.fingerprint;
  const count = same ? (Number(streak.count) || 0) + 1 : 1;
  const next = { fingerprint: decision.fingerprint, count };
  if (count <= MAX_HOLDS) return { decision, streak: next };
  const note = count === MAX_HOLDS + 1
    ? `session-rail: tests failed (${shownCommand(decision.command)}) with the same result as the last ${MAX_HOLDS} held stops. Not holding again until the result changes.`
    : '';
  return { decision: { ...decision, action: 'allow', why: 'repeat', reason: '', note }, streak: next };
}

// `exitCode` 0 allows. A timeout, a spawn error, or any other status blocks.
export function gateDecision({ command, exitCode, output, timedOut, spawnError } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return allowQuiet('no-command');
  if (timedOut) return block(cmd, tailText(output) || 'The test command timed out.', 'timeout');
  if (spawnError && exitCode !== 0) return block(cmd, tailText(spawnError) || 'The test command could not be started.', 'spawn');
  if (exitCode === 0) return { action: 'allow', quiet: false, why: 'pass', reason: '', ok: true, command: cmd, detail: '', at: 0 };
  return block(cmd, tailText(output) || `exit ${exitCode}`, 'fail');
}

export function reuseDecision(record, key, now, windowMs = DEDUPE_MS) {
  if (!record || record.key !== key || record.done !== true || !record.decision) return null;
  if (typeof record.at !== 'number' || now - record.at > windowMs) return null;
  return record.decision;
}

export function runInProgress(record, key, now, windowMs = RUN_WAIT_MS) {
  return Boolean(record && record.key === key && record.done === false && typeof record.at === 'number' && now - record.at <= windowMs);
}

/**
 * io.load() → { command, root, changes }, where changes is null or what skipReason reads. io.run(command, root) → { exitCode, output, timedOut, spawnError }
 * and never throws. io.readLock / writeLock / wait are optional; wait resolves to a decision or null.
 */
export async function performGate(event, io) {
  if (!isMainStop(event)) return allowQuiet('not-stop');
  if (wasInterrupted(event)) return allowQuiet('interrupted');
  if (stopHookActive(event)) return allowQuiet('stop_hook_active');
  let loaded;
  try { loaded = await io.load(); } catch { return allowQuiet('error'); }
  const command = loaded?.command || '';
  const root = loaded?.root || '';
  if (!command) return allowQuiet('no-command');
  const skip = skipReason(loaded?.changes);
  if (skip) return allowQuiet(skip);
  const key = stopKey(event);
  const now = io.now();
  let prior = null;
  try { prior = await io.readLock(); } catch { prior = null; }
  const reused = reuseDecision(prior, key, now);
  if (reused) return reused;
  if (runInProgress(prior, key, now) && io.wait) {
    const waited = await io.wait(key);
    if (waited) return waited;
  }
  // The streak outlives each stop's record, so it is carried into every write.
  const streak = prior?.streak;
  try { await io.writeLock({ key, at: now, done: false, streak }); } catch { /* the run still happens */ }
  const result = await io.run(command, root);
  const repeated = repeatDecision({ ...gateDecision({ command, ...result }), at: io.now() }, streak);
  const decision = repeated.decision;
  try { await io.writeLock({ key, at: decision.at, done: true, decision, streak: repeated.streak }); } catch { /* the reply still stands */ }
  return decision;
}

// Claude's command hook blocks with exit 2 and the reason on stderr. Grok's hook prints a block
// decision and exits 0 (a non-zero exit is how a broken Grok hook fails open). Neither sets
// `continue: false`, which would end the turn instead of sending the agent back.
// A stop let through with a note (repeatDecision) shows it to the person on Claude as a systemMessage.
export function hostReply(host, decision) {
  if (decision?.action === 'allow' && decision.note && host !== 'grok') {
    return { exitCode: 0, stdout: JSON.stringify({ systemMessage: decision.note }), stderr: '' };
  }
  if (!decision || decision.action !== 'block') return { exitCode: 0, stdout: '', stderr: '' };
  const stdout = JSON.stringify({ decision: 'block', reason: decision.reason });
  if (host === 'grok') return { exitCode: 0, stdout, stderr: '' };
  return { exitCode: 2, stdout, stderr: `${decision.reason}\n` };
}
