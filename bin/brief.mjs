// The session brief: the branch's goal, design and engineering chunks, written by Claude before it edits
// code. Pure functions only (no Node APIs), so the desk (through sources.mjs) and the hooks module read it
// the same way.
//
// The brief lives inside the repo's shared git dir, so it's never committed:
//   <git common dir>/session-rail/briefs/<branch>.md             the brief
//   <git common dir>/session-rail/briefs/<branch>.approved.json  { approvedAt, core } once the person approves
// Its sections are fixed headings (## Problem, Solution, Design, Mockups, Engineering). Engineering holds
// "### Chunk N: name" blocks, each an outline plus, once built, "Done: summary" and "Files: a, b".
// main/master and a detached HEAD have no brief. A repo edit there is refused until the work is on a branch,
// except the next branch's brief (briefWriteOnMain), so the agent writes it and then switches to that branch.
// Git's own lock files are never a code edit (isGitLock).

export const BRIEF_SECTIONS = ['problem', 'solution', 'design', 'mockups', 'engineering'];
export const NO_BRIEF_BRANCHES = ['main', 'master', 'HEAD', 'detached'];
const REQUIRED = { problem: 'problem', solution: 'user story', engineering: 'engineering outline' };

/**
 * The branch a checkout is on. `git rev-parse --abbrev-ref HEAD` prints `HEAD` for the whole of a
 * rebase; `rebaseRef` is `rebase-merge/head-name` (or rebase-apply), and a `refs/heads/` ref keeps
 * that branch. Anything else detached stays `HEAD`.
 * @param {string} abbrev
 * @param {string} [rebaseRef]
 */
export function checkoutName(abbrev, rebaseRef) {
  const name = typeof abbrev === 'string' ? abbrev.trim() : '';
  const ref = typeof rebaseRef === 'string' ? rebaseRef.trim() : '';
  if (name && name !== 'HEAD') return name;
  if (ref.startsWith('refs/heads/')) return ref.slice(11);
  return name || 'HEAD';
}

/**
 * What to tell the agent on a checkout that cannot hold a brief. The same sentence is the prompt note
 * and the reason a repo edit is refused: the new branch's brief first, then switch to it, then Approve.
 * Writing the brief first means the Plan tab shows it as soon as the branch changes.
 * @param {string} branch `main`, `master`, `HEAD`, or `detached`
 * @param {string} [common] the git common dir, to name where the brief goes
 */
export function mainCheckoutNote(branch, common) {
  const name = branch === 'HEAD' || branch === 'detached' || !branch ? 'a detached HEAD' : branch;
  const where = common ? `${common}/session-rail/briefs/<new-branch>.md (the branch name URL-encoded, / as %2F)` : 'the new branch\'s brief file';
  return `session-rail: No brief for ${name}. Write the brief at ${where}, switch to that branch (git switch -c <new-branch>), then ask the person to Approve it in the desk's Plan tab. Code edits wait until then.`;
}

/**
 * True when `file` is a brief, written from a checkout that cannot hold one (main, master, detached)
 * before switching to its branch. An approval file is not: only the person approves. Nothing else
 * under session-rail/ is either, and a path with `.` or `..` segments never is.
 * @param {string} common the git common dir
 * @param {string} file absolute path
 */
export function briefWriteOnMain(common, file) {
  if (!common || typeof file !== 'string' || /(?:^|\/)\.\.?(?:\/|$)/.test(file)) return false;
  const dir = `${common}/session-rail/briefs/`;
  return file.startsWith(dir) && !file.slice(dir.length).includes('/') && file.endsWith('.md');
}

/**
 * True when `file` is in this repo: a relative path, or an absolute path inside one of `roots`.
 * Callers pass the git toplevel (the session cwd when that lookup fails) and the main checkout
 * (`mainCheckout`), so a linked worktree's session still counts the main checkout as the repo.
 * A path outside them all is not a repo edit.
 * @param {string | string[]} roots
 * @param {string} file
 */
export function inWorkTree(roots, file) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  if (!list.length || !file) return false;
  if (!file.startsWith('/')) return true;
  return list.some((root) => {
    const base = root.endsWith('/') ? root.slice(0, -1) : root;
    return file === base || file.startsWith(`${base}/`);
  });
}

/** The main checkout's folder from the git common dir (`/repo/.git` → `/repo`), or '' for a bare or moved git dir. */
export const mainCheckout = (common) => (typeof common === 'string' && common.endsWith('/.git') ? common.slice(0, -5) : '');

/**
 * True for git's own lock files (`.git/index.lock`, `.git/refs/heads/main.lock`, a worktree's
 * `.git/worktrees/x/index.lock`). Clearing a stale one is repo maintenance, not a code edit.
 * A path with `.` or `..` segments is not one: `/repo/.git/../yarn.lock` is a work-tree file.
 */
export function isGitLock(file) {
  return typeof file === 'string' && !/(?:^|\/)\.\.?(?:\/|$)/.test(file)
    && /(?:^|\/)\.git\/(?:[^/]+\/)*[^/]+\.lock$/.test(file);
}

/** @param {string} common the git common dir @param {string} branch @param {'md' | 'approved.json'} ext */
export const briefFile = (common, branch, ext) => `${common}/session-rail/briefs/${encodeURIComponent(branch)}.${ext}`;

/**
 * @param {string} text
 * @returns {{ title: string, sections: Record<string, string>, missing: string[],
 *   chunks: { n: number, name: string, outline: string, done: string, files: string[] }[] }}
 */
export function parseBrief(text) {
  /** @type {Record<string, string[]>} */
  const lines = {};
  let title = '', at = null, fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h1 = !fence && /^#\s+(.*)$/.exec(line), h2 = !fence && /^##\s+(.*)$/.exec(line);
    if (h1 && !title) { title = h1[1].trim(); continue; }
    if (h2) { const key = h2[1].trim().toLowerCase(); at = BRIEF_SECTIONS.includes(key) ? key : null; if (at) lines[at] = []; continue; }
    if (at) lines[at].push(line);
  }
  /** @type {Record<string, string>} */
  const sections = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.join('\n').trim()]));
  /** @type {{ n: number, name: string, outline: any, done: string, files: string[] }[]} */
  const chunks = [];
  fence = false;
  for (const line of (sections.engineering ?? '').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^###\s+(?:Chunk\s+)?(\d+)\s*[:.\-–]?\s*(.*)$/i.exec(line);
    if (h) { chunks.push({ n: +h[1], name: h[2].trim(), outline: [], done: '', files: [] }); continue; }
    const c = chunks.at(-1);
    if (!c) continue;
    const done = /^Done:\s*(.*)$/i.exec(line), files = /^Files:\s*(.*)$/i.exec(line);
    if (done) c.done = done[1].trim();
    else if (files) c.files = files[1].split(',').map((f) => f.trim().replace(/^`|`$/g, '')).filter(Boolean);
    else c.outline.push(line);
  }
  for (const c of chunks) c.outline = c.outline.join('\n').trim();
  const missing = Object.entries(REQUIRED)
    .filter(([k]) => !sections[k] || (k === 'engineering' && !chunks.some((c) => c.outline)))
    .map(([, label]) => label);
  return { title, sections, chunks, missing };
}

/**
 * What approval covers: the problem, the solution and each chunk's outline. Claude adding Done/Files lines
 * as it works leaves this unchanged; rewriting the goal or the plan changes it.
 * @param {ReturnType<typeof parseBrief>} brief
 */
export const briefCore = (brief) => JSON.stringify({
  problem: brief.sections.problem ?? '', solution: brief.sections.solution ?? '',
  chunks: brief.chunks.map((c) => `${c.n}: ${c.name}\n${c.outline}`),
});

/** The approval record to save. @param {ReturnType<typeof parseBrief>} brief @param {number} now */
export const approvalRecord = (brief, now) => JSON.stringify({ approvedAt: now, core: briefCore(brief) });

/**
 * @param {ReturnType<typeof parseBrief>} brief
 * @param {{ approvedAt?: number, core?: string } | null} approval
 * @returns {'draft' | 'ready' | 'approved' | 'changed'}
 */
export function briefStatus(brief, approval) {
  if (approval?.approvedAt) return approval.core === briefCore(brief) ? 'approved' : 'changed';
  return brief.missing.length ? 'draft' : 'ready';
}
// Whether the person approved the brief (an edit since keeps the approval: the gate keeps allowing edits).
export const isApproved = (status) => status === 'approved' || status === 'changed';
