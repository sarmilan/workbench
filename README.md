# Workbench

A visual harness for Claude Code and Grok, engineered for product-first engineers.

Workbench wraps an agent session in a three-pane iTerm2 layout and a set of host hooks. The panes make the session observable: what the agent is doing, what it was asked, the plan, the diff, the reviews and the state of every branch. The hooks make the workflow enforceable: no code edits before an approved brief, no merge before the reviews are in, no stop while the tests fail.

It is built for engineers who start from the product problem. Every branch begins as a brief with a problem statement and a user story. The agent builds against that brief in reviewable chunks, and the harness holds it to the plan.

![workbench in iterm: claude on the left, the desk with the plan tab in the middle, the rail with sessions, now, context and the turtle on the right](docs/media/workbench-window.png)

*The screenshot is a mock; the session content and figures are illustrative.*

## What it is

- **Panes.** The agent on the left, the **desk** (Plan, Diff, Review) in the middle, and the **rail** (Session, Git) on the right. Claude opens both on session start, and runs your own `/start` command if you have one; `/desk` and `/rail` toggle them. The panes are read-only views over files the host and the hooks already write.
- **Hooks.** A Claude Code plugin module and a Grok command hook that record live session activity, inject the brief procedure, and enforce three gates.
- **Gates.** The **brief gate** blocks code edits until the person approves a brief. The **review gate** blocks `gh pr merge` until the branch's reviews are complete and clear. The **Stop gate** sends the agent back when the project's tests fail.
- **State.** Briefs, approvals and review records live inside the repo's `.git` directory and are never committed. Session activity and settings live under `~/.claude/session-rail/`.

Zero npm dependencies: plain Node 18+ ESM, with the hooks module running on the host's engine APIs.

## The workflow

```
 problem ─▶ brief ─▶ approve ─▶ chunk 1 ─▶ chunk 2 ─▶ … ─▶ /code-review ─▶ final review ─▶ merge
            │          │          │                          │               │              │
            │          │          └ Done + Files, approach   └ fixes          └ checks the   └ gh pr merge
            │          │            review, commit, push       committed        fixer         allowed only
            │          └ Approve in the desk, or a message                                     when the record
            │            that is exactly "approved"                                            is clear
            └ written by the agent in .git/session-rail/briefs/<branch>.md
```

1. **Scope.** The person describes the problem. When it is clear, the agent writes the branch brief without being asked:

   ```
   # <title>
   ## Problem       Currently it's A; we need B to solve A
   ## Solution      As an X, I should be able to Y so I can Z
   ## Design        UI/UX decisions
   ## Mockups       ASCII mockups
   ## Engineering
   ### Chunk 1: <name>
   <outline>
   Done: <summary>             ← added when the chunk is finished
   Files: src/a.ts, src/b.ts
   ```

2. **Plan review.** The agent runs the approach review on the brief, the cheapest point to change course, and applies its findings.
3. **Approve.** The person approves in the desk's Plan tab (**Approve** or `A`), with `/approve-brief`, or with a message that is exactly `approved`. Within about two seconds the plugin sends Claude the go-ahead; nobody types "go".
4. **Build in chunks.** For each chunk the agent verifies it against the brief and runs the tests, then adds `Done:` and `Files:` lines and runs the approach review (at most two rounds). It then runs what the chunk built once for real, commits the chunk on its own and pushes. After the first chunk it opens a pull request whose Progress checklist tracks the chunks. If the problem, solution or outline changes after approval, the Plan tab shows "changed since" and offers **Approve again**.
5. **Pre-merge review.** When the person says to merge, the agent runs `/code-review --fix` over the whole branch and commits the fixes. It then runs the final approach review, which audits what the fixer did.
6. **Merge.** The review gate allows `gh pr merge` once the record is clear. After the session leaves the merged branch, it compacts itself so the next issue starts with a lean context.

## Architecture

```
  ┌──────────────┐  hooks   ┌───────────────────────────┐  reads   ┌──────────────────┐
  │ Claude Code  │─────────▶│ hooks/register.ts         │          │ rail  (bin/rail) │
  │   or Grok    │◀─────────│ bin/grok-hook.mjs         │─────────▶│ desk  (bin/desk) │
  └──────────────┘ deny /   │ bin/stop-hook.mjs         │ activity └──────────────────┘
         │         prompt   └───────────────────────────┘   file            │
         │ transcript                │ writes                               │ reads
         ▼                           ▼                                      ▼
  host session files     ~/.claude/session-rail/          <repo>/.git/session-rail/
  (logs, subagents,      activity/<session>.json          briefs/  reviews/  chores/
   usage)                settings.json                    tests.json
```

The rail and desk poll their sources (the activity file every second) and render with no shared process. Pane layout goes through iTerm2's AppleScript interface. Per-file detail is in [CLAUDE.md](CLAUDE.md#layout).

### Components

| Component | Role |
|---|---|
| Rail (`bin/rail.mjs`) | Session tree (banner, agents and their handoffs, prompts), sessions on this machine, environment, context, cost, prompt cache, connectors; Git tab with the open-branch tree, checks and merge order. |
| Desk (`bin/desk.mjs`) | Plan (the brief, with Approve), Diff (changes since the merge-base, grouped by chunk), Review (approach, code and wide review records). |
| Claude plugin (`hooks/register.ts`) | Activity recording, brief instructions in the system prompt, the brief and review gates, the `review_approach` tool, `/code-review` capture, approval go-ahead, automatic compaction. |
| Grok hook (`bin/grok-hook.mjs`) | The same activity file and gates for Grok; attaches the brief procedure on the first tool call of each turn. |
| Stop hook (`bin/stop-hook.mjs`) | The Stop test gate for both hosts. |
| Approach reviewer (`bin/reviewer.mjs`) | Headless `claude -p` with a JSON schema, read-only tools, no MCP servers and no saved session. |
| Pane controller (`bin/pane.mjs`) | Opens, sizes, focuses and closes the panes. Never launches iTerm2, and acts only on the nearest `claude` or `grok` process. |

### State on disk

| Path | Contents |
|---|---|
| `.git/session-rail/briefs/<branch>.md` | The branch brief (branch name URL-encoded). |
| `.git/session-rail/briefs/<branch>.approved.json` | The approval record: timestamp and the approved problem, solution and chunks. Written only by the person's approval. |
| `.git/session-rail/reviews/` | Per-branch review record: approach, code and wide runs, with finding statuses. |
| `.git/session-rail/tests.json` | Optional per-checkout Stop gate command. |
| `.git/session-rail/chores/` | CI chore state files. |
| `~/.claude/session-rail/activity/<session>.json` | Live session activity written by the hooks; `.desk.json` and `.rail.json` siblings hold desk and rail state. |
| `~/.claude/session-rail/settings.json` | Shared settings (see Configuration). |
| `~/.claude/session-rail/mascot.json` | The chosen pet. |

## Gates

### Brief gate

On a feature branch, Edit, Write and NotebookEdit are refused until the brief has a problem, a solution and at least one chunk, and the person has approved it. So is any shell command that creates, overwrites, moves or deletes a file in the checkout: redirects, `tee`, `cp`, `mv`, `rm`, `sed -i`, `git checkout --`, `git apply` and similar, parsed by `bin/shellwrite.mjs`. A command whose target is not a literal path is treated as a write in the checkout; the person can run it themselves.

What is not gated:

- Read-only commands, tests and commits.
- The brief and the rest of `.git/session-rail/`. The brief's approval file is always refused to the agent.
- **Paths outside the repo, on any branch.** "The repo" is this checkout's toplevel plus the main checkout, so a linked worktree's session cannot edit the main checkout unbriefed. Paths starting `~`, `$HOME` or `${HOME}` resolve against HOME.
- `git worktree add|remove|move` to a path outside the repo, and `rsync` to a remote `host:path`.
- Git's own lock files (`rm .git/index.lock`).

On `main`, `master` or a detached HEAD there is no brief, and a repo edit is refused. The agent writes the next branch's brief (`.git/session-rail/briefs/<branch>.md`; nothing else under `.git/session-rail/`), switches to that branch with `git switch <b>`, `git switch -c <b>`, `git checkout <b>` or `git checkout -b <b>`, and the brief shows on the Plan tab for Approve. A forced, merge or orphan switch is still a write. `git pull` and `git merge --ff-only` from upstream also run there. A refusal shows on the rail as `Held` and puts a `?` over the pet.

### Review gate

The plugin refuses the agent's `gh pr merge` until:

1. `/code-review` has run since the last chunk's approach review,
2. the final approach review (`final: true`) has run after it, on the last commit, with a clean tree,
3. no finding is open, including any open finding from the newest wide review.

Commits are not gated, and a person can always merge themselves. After each saved review the plugin posts the commit status `session-rail/review` and updates one pull request comment. The status is `success` only when the gate is clear. To make GitHub enforce it, add `session-rail/review` as a required status check. To also fail pull requests that have no status at all, copy `docs/session-rail-review.yml` into `.github/workflows/`. `SESSION_RAIL_PUBLISH=0` keeps the record local.

### Stop gate

When a turn ends, the project's test command runs. On failure the agent is sent back with the tail of the output. It is skipped on the default branch, on a branch with nothing changed, after an interrupt, and when no command resolves. The same failure holds at most two consecutive stops. Command resolution: `.git/session-rail/tests.json`, then `session-rail.json`, then a `test` fence in `AGENTS.md`, then `package.json` (workspace-filtered for turbo and pnpm). Full rules: [docs/stop-gate.md](docs/stop-gate.md).

## Reviews

| Review | When | What it does |
|---|---|---|
| Approach (`review_approach`) | On the complete brief, after each chunk, and with `final: true` before merge | A staff-engineer pass in a headless Claude over the brief, chunk summaries and changed files. Verdict: on track, a simpler path exists, or off goal. Each run re-checks earlier findings as applied, declined (with an accepted reason) or open. Under a minute; uses your Claude account. |
| Code (`/code-review --fix`) | Once, before merge | Correctness review of the whole branch. The plugin arms a token when `/code-review` starts and records the final JSON findings block that carries it, whether the review ran forked or inline. |
| Wide (optional) | On demand, for a diff of 8+ files or 400+ lines | Up to four slices, each reviewed in a throwaway worktree, then one skeptic that keeps or declines each finding. Off unless `wideReview` is set. Not required for merge. |

The desk's Review tab shows every finding with its status; **Run review** (`r`) runs an approach review on demand.

## Panes in brief

- **Rail, Session tab.** The banner names who is working and on what. Below it is a tree of the host agent and its subagents, each with the exact prompt it was handed and what it returned, then your prompts as chapters. Sections below cover the machine's sessions, environment, context, session cost, prompt-cache TTL and expiry, and MCP connectors.
- **Rail, Git tab.** Open branches as a stack tree, each under the branch it would rebase onto, with ahead/behind counts, pull request checks, file clashes and a `Next` line for the merge order.
- **Desk.** Plan shows the live brief with Approve. Diff groups the changes since the merge-base by chunk. Review shows the review record.
- **+ new.** Starts an isolated session: a worktree at the latest `main` in `<repo>.worktrees/<slug>`, a new iTerm window, and `claude "/start <problem>"`. Merged, clean worktrees whose session has ended can be removed from the rail.
- **Pet.** A pixel creature that encodes session state: pace for busy or waiting, position for brief progress, growth stage for the branch lifecycle, and reactions for held edits, failures, subagents and background tasks.

Full behaviour, keys and compaction rules: [docs/reference.md](docs/reference.md). Pet specification: [docs/pets.md](docs/pets.md).

## Requirements

- macOS with iTerm2. Elsewhere the plugin stays quiet.
- Claude Code 2.1.319 or newer, and/or Grok.
- Node.js 18 or newer.
- The GitHub CLI (`gh`) for the Git tab and the review status. Optional: without it the review record stays in `.git`.

## Install

**Claude Code:**

```
/plugin install session-rail --marketplace sarmilan/workbench
```

Accept adding the marketplace, then start a new `claude` session in iTerm2. If macOS asks to allow control of iTerm2, allow it; that is how the panes are opened and focused.

**Grok:**

```
grok plugin marketplace add <this folder>
grok plugin install <this folder> --trust
```

Start a new `grok`. Grok does not open the panes on start; `/desk` and `/rail` toggle them. The brief procedure is attached on the first tool call of each turn, and a message that is exactly `approved` (or `approved!`) approves the brief. The install copies the folder; refresh with `grok plugin uninstall session-rail --confirm` and install again.

For local development, see [CLAUDE.md](CLAUDE.md#local-dev-install).

## Configuration

`~/.claude/session-rail/settings.json`, shared by the rail and the hooks. Every key except `wideModel` is also a row under **settings** in the rail.

| Key | Default | Effect |
|---|---|---|
| `fontSize` | unset | One font size for the agent, desk and rail panes, applied via generated iTerm profiles. |
| `autoCompact` | `true` | Compact after leaving a branch whose brief has a Done chunk and whose work is merged. |
| `warmCompact` | `true` | Compact a waiting session before its prompt cache expires (Claude only). |
| `wideReview` | `false` | Offer the wide review on large diffs. |
| `wideModel` | unset | Model for the wide review's calls. |
| `chores` | `false` | Enable the CI chore ([docs/chores.md](docs/chores.md)). |

Per project or checkout:

| Setting | Effect |
|---|---|
| `session-rail.json` → `testCommand` | Stop gate command for the project; `false` disables it. |
| `.git/session-rail/tests.json` → `command` | Stop gate command for this checkout only; `false` disables it. |
| `SESSION_RAIL_PUBLISH=0` | Do not post the commit status or pull request comment. |

## The CI chore

An optional, budgeted loop that re-checks failing CI for the open branch in its own detached worktree. Budgets are counted in rounds, not dollars, and it stops after two empty rounds. It never edits the repo, approves a brief or merges. Off unless `chores` is `true`. Leave it off on an unattended machine, or with no checks or tests to signal. See [docs/chores.md](docs/chores.md).

## Safe use

Workbench runs on your Mac. It is not a container. The pane controller (`bin/pane.mjs`) can split iTerm2, focus a session, open a window and type into a pane, as you. Claude Code's Bash sandbox and Grok's sandbox profile do not wrap those calls, file tools, MCP servers or plugin hooks. An unattended loop belongs on a disposable machine with credentials that are not your real ones.

Start Claude in Manual mode, without `--dangerously-skip-permissions`, and Grok in ask mode, without `--always-approve`. The sample configuration in [docs/safe-use.md](docs/safe-use.md) is a starting point, not a guarantee: it keeps Manual mode, asks before `git push` and `gh pr merge`, denies a few destructive and credential paths, and enables the Bash sandbox with auto-allow off.

Know the limits:

- A Bash deny rule matches command text: `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`. The sandbox is the OS boundary for shell commands; file tools follow permission rules outside it.
- "Yes, and don't ask again" saves the rule to `.claude/settings.local.json` in the main checkout, which **+ new** worktrees share.
- The brief gate covers Edit, Write, NotebookEdit and shell writes in the checkout (`bin/shellwrite.mjs`). It is a workflow control, not a security boundary.

References:

- [Configure permissions](https://code.claude.com/docs/en/permissions)
- [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing)
- [Grok permissions](https://docs.x.ai/build/features/permissions)
- [Grok sandbox](https://docs.x.ai/build/features/sandbox)

## Further reading

- [docs/reference.md](docs/reference.md): rail, desk, keys, worktrees, compaction, operational notes
- [docs/stop-gate.md](docs/stop-gate.md): the Stop test gate
- [docs/pets.md](docs/pets.md): the pet
- [docs/chores.md](docs/chores.md): the CI chore
- [docs/safe-use.md](docs/safe-use.md): permissions and sandbox samples
- [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md): contributor map and architecture notes

## Uninstall

```
claude plugin uninstall session-rail
```

## License

MIT
