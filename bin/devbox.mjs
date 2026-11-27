// Devbox dispatch status: the rules behind the rail's task rows and the desk's Devbox tab. Pure, no Node
// APIs, so sources.mjs (which runs the ssh call and keeps the cache) and the tests share them.
//
// A dispatched task has a tracker in <main checkout>/.claude/hetzner-dispatch/<task>.json:
//   { task, host, branch, worktree, log, result, pidfile, started, ... }
// On the box its wrapper writes <pidfile>, then <name>.exitcode beside it when claude exits, the log, and the
// result: the `claude --print --output-format json` envelope whose `.result` is the task's own JSON
// { status, pr_url, pr_number, commit_sha, branch, summary, blockers }.
// One probe script per host reads all of that in one ssh call (probeScript), and parseProbe reads it back.

export const POLL_MS = 45_000;
export const DEFAULT_HOST = 'devbox';
const MARK = '::session-rail::';
const NAME = /^[A-Za-z0-9._-]{1,80}$/;

/** True when a cache written at `at` (ms) is older than the poll interval at `now`. */
export const stale = (at, now) => !Number.isFinite(at) || now - at >= POLL_MS;

/**
 * A task's state from what the probe saw.
 * A live pid is running. No exit code yet (and no live pid) is unknown. Exit 0 is done unless the result
 * says blocked or failed. 124 is the wrapper's timeout. 75, or 1 with a slot marker in the log, is a refused
 * slot. Anything else is failed.
 * @param {{ alive?: boolean, exitcode?: number | null, result?: any, slot?: string }} t
 * @returns {'running' | 'done' | 'failed' | 'timed out' | 'refused' | 'blocked' | 'unknown'}
 */
export function taskState({ alive, exitcode, result, slot } = {}) {
  if (alive) return 'running';
  if (exitcode == null || !Number.isInteger(exitcode)) return 'unknown';
  if (exitcode === 0) {
    const status = typeof result?.status === 'string' ? result.status.toLowerCase() : '';
    if (status === 'blocked') return 'blocked';
    if (status === 'failed' || status === 'error') return 'failed';
    return 'done';
  }
  if (exitcode === 124) return 'timed out';
  if (exitcode === 75 || (exitcode === 1 && slot)) return 'refused';
  return 'failed';
}

const fenced = (s) => s.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1').trim();
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

/**
 * The task's result from its result file. The `claude --print` envelope's `.result` is parsed again as JSON
 * (a ```json fence around it is fine). A bare result object is taken as it is. When neither parses, the text
 * is kept as `{ raw }`. Empty text is null.
 * @param {string} text
 */
export function parseResult(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return null;
  const outer = tryJson(s);
  if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
    if (typeof outer.result === 'string') {
      const inner = tryJson(fenced(outer.result));
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
      return { raw: outer.result };
    }
    if (outer.result && typeof outer.result === 'object') return outer.result;
    return outer;
  }
  return { raw: s };
}

// A remote path for bash: `~/x` becomes "$HOME"/'x', anything else is single-quoted.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const remotePath = (p) => {
  const s = String(p ?? '');
  if (s === '~') return '"$HOME"';
  return s.startsWith('~/') ? `"$HOME"/${q(s.slice(2))}` : q(s);
};

/** The exit code file the wrapper writes beside the pid file (`T.pid` → `T.exitcode`). */
export const exitFile = (t) => t.exitcode ?? (typeof t.pidfile === 'string' ? t.pidfile.replace(/\.pid$/, '') + '.exitcode' : '');

/**
 * The one bash script that probes every task on a host, run as `ssh <host> bash -s` with this on stdin.
 * Per task, between marker lines: whether the pid is alive, the exit code, the last slot marker in the log,
 * the result file, the last 30 log lines, and `git diff --stat` of the task worktree against its merge-base
 * with origin's default branch. A task whose name is not a plain name is skipped. Every path is quoted.
 * @param {Array<{ task: string, pidfile?: string, log?: string, result?: string, worktree?: string, exitcode?: string }>} tasks
 */
export function probeScript(tasks) {
  const lines = [];
  for (const t of tasks ?? []) {
    if (!NAME.test(t?.task ?? '')) continue;
    const pid = remotePath(t.pidfile), log = remotePath(t.log), res = remotePath(t.result), wt = remotePath(t.worktree);
    lines.push(
      `echo '${MARK} task ${t.task}'`,
      `p=$(cat ${pid} 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo '${MARK} alive 1'; else echo '${MARK} alive 0'; fi`,
      `echo "${MARK} exit $(cat ${remotePath(exitFile(t))} 2>/dev/null | head -n 1)"`,
      `echo "${MARK} slot $(grep -oE 'SLOT_(REFUSED|CONTENDED)' ${log} 2>/dev/null | tail -n 1)"`,
      `echo '${MARK} result'; cat ${res} 2>/dev/null; echo`,
      `echo '${MARK} log'; tail -n 30 ${log} 2>/dev/null`,
      `echo '${MARK} diff'; ( cd ${wt} 2>/dev/null && d=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main) && b=$(git merge-base HEAD "$d" 2>/dev/null) && git diff --stat "$b" 2>/dev/null | tail -n 20 )`,
      `echo '${MARK} end'`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * The probe's stdout by task: `{ [task]: { alive, exitcode, slot, result, resultText, log, diff } }`.
 * A task cut off part way keeps what arrived; a missing part is empty.
 * @param {string} stdout
 */
export function parseProbe(stdout) {
  const out = {};
  let cur = null, part = null;
  const take = (line) => { if (cur && part) cur[part].push(line); };
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.startsWith(MARK)) { take(line); continue; }
    const [key, ...rest] = line.slice(MARK.length).trim().split(' ');
    const value = rest.join(' ').trim();
    if (key === 'task') {
      cur = { alive: false, exitcode: null, slot: '', result: [], log: [], diff: [] };
      out[value] = cur; part = null;
    } else if (!cur) continue;
    else if (key === 'alive') cur.alive = value === '1';
    else if (key === 'exit') cur.exitcode = /^-?\d+$/.test(value) ? Number(value) : null;
    else if (key === 'slot') cur.slot = value;
    else if (key === 'result' || key === 'log' || key === 'diff') part = key;
    else if (key === 'end') part = null;
  }
  for (const t of Object.values(out)) {
    const trim = (a) => { while (a.length && !a[a.length - 1].trim()) a.pop(); return a; };
    t.resultText = trim(t.result).join('\n');
    t.result = parseResult(t.resultText);
    t.log = trim(t.log);
    t.diff = trim(t.diff);
  }
  return out;
}

/**
 * One row per tracker, oldest first: `{ task, host, branch, started, state, pr, result, log, diff }`.
 * `started` is ms (NaN when the tracker has none). `pr` is `{ number, url }` from the open PR whose head is
 * the tracker's branch, else from the result's pr_number / pr_url, else null. A task the probe did not see
 * is `unknown`.
 * @param {any[]} trackers
 * @param {Record<string, any>} probe parseProbe output, merged across hosts
 * @param {Array<{ number: number, url: string, headRefName: string }>} prs
 */
export function taskRows(trackers, probe, prs) {
  const rows = [];
  for (const t of trackers ?? []) {
    if (!t || typeof t.task !== 'string' || !t.task) continue;
    const seen = probe?.[t.task];
    const result = seen?.result ?? null;
    const open = t.branch ? (prs ?? []).find((p) => p?.headRefName === t.branch) : null;
    const number = open?.number ?? (Number.isInteger(Number(result?.pr_number)) && result?.pr_number != null ? Number(result.pr_number) : null);
    const url = open?.url ?? (typeof result?.pr_url === 'string' ? result.pr_url : '');
    rows.push({
      task: t.task,
      host: t.host || DEFAULT_HOST,
      branch: t.branch ?? '',
      started: Date.parse(t.started ?? ''),
      state: seen ? taskState(seen) : 'unknown',
      pr: number != null || url ? { number, url } : null,
      result,
      log: seen?.log ?? [],
      diff: seen?.diff ?? [],
    });
  }
  return rows.sort((a, b) => (a.started || 0) - (b.started || 0));
}

/** The trackers grouped by host: `{ [host]: tracker[] }`. */
export function byHost(trackers) {
  const out = {};
  for (const t of trackers ?? []) (out[t?.host || DEFAULT_HOST] ??= []).push(t);
  return out;
}
