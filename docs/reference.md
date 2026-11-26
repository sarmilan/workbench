# Reference

Detailed behaviour of the rail, the desk, worktrees and compaction. The overview, the gates and configuration are in the [README](../README.md). The Stop test gate is in [stop-gate.md](stop-gate.md), the pet in [pets.md](pets.md), the CI chore in [chores.md](chores.md).

## The rail

`bin/rail.mjs`, a dependency-free Node TUI in the right-hand pane. Two tabs: **Session** (this session's state) and **Git** (every open branch). `Tab` / `]` and `Shift-Tab` / `[` switch tabs; each rail persists its tab in `<session id>.rail.json` beside the session's activity file.

### Session tab

```
 ▌ Now  Wren and Otto
 ────────────────────────────────────────
 ▸ ● Grok
   the tab now opens each handoff
   ├ Wren    how the session tab is drawn
   │    asked   how the session tab is drawn
   │    prompt  Read the session tab and say what a person can learn
   │    said    It lists tool calls. The ask itself is missing.
   └ Otto    run the tests                 running
 ▸ Rue     read the pet stages            2h
 ◇ bun test                               12s
 ▾ you   bring that attitude to the session tab
 │   why  I'll look at the session tab first
 │ ├ Wren  how the session tab is drawn
 │ └ Otto  run the tests
 ▸ you   the pet should follow the session
```

![the rail's session tab: sessions, now with wren and otto, environment, context with cache and usage rows, and the pet at the bottom](media/rail-session.png)

The tree is built by `bin/sessionstory.mjs` (pure) from the activity file and the host transcript. Nothing in it is inferred.

- **Banner.** The single status line. `Now` names the active agents and the ask they were given (`Wren and Otto` for two). `Held` means the brief gate just refused an edit. `waiting for you` means the turn has ended. A tool call with no handoff names its file (`reading rail.mjs`), and that text is not repeated on the row below.
- **Agents.** The host (Claude or Grok) is the root. Its latest reply sits under it, and `Enter` opens the full text. Each subagent hangs under the agent that spawned it, with a purple name and a lamp showing its elapsed time, or `running` while a shell is in flight. With one active agent the banner carries the ask, so the row shows only the name and the lamp; with several, each row keeps its ask. Background agents sit level with the host and are left out of the banner while a foreground agent is named. A running shell is a `◇` row, and `Enter` opens its output. A running desk review is also a row.
- **Handoff.** Expanding an agent shows `asked` (the one-line task), `prompt` (the exact text sent), `said` (the returned answer) and `doing` (the call in flight), followed by its tool calls.
- **Finished subagents** stay listed under the live ones, newest first, with their task and how long ago they finished.
- **Chapters.** Each user prompt is a chapter, newest first: `why` (what the agent said it would do), the agents that turn spawned, and the reply. `⟲ compacted after <branch>` stays for an hour after an automatic compaction.
- **Sources.** The hooks record prompts, replies and turns in the activity file as they happen. The rail also reads the transcript: Grok's `chat_history.jsonl` and `subagents/<id>/meta.json`, and Claude's session log. A subagent's prompt is the `prompt` it was spawned with; its reply is what it returned.

Sections below the tree:

- **Sessions.** Every agent session on the machine: this one first (`▸`), then the ones that need you. Each row shows the brief title (or branch), a state (busy, waiting, blocked by the brief gate, idle), and its repo, branch and current action. Every rail shows the same list.
- **Environment.** Host, repo and git rows, plus lines added and removed since the merge-base with the default branch (committed and uncommitted; untracked files excluded). Account and Remote Control sit on dim rows below.
- **Context.** Context-window fill, model, token count, session cost, prompt cache and the plan's usage windows. Open by default.
- **Cost.** Session spend in USD when the host reports one. Claude's figure is the session ledger from `session.measure` (the same value as `/usage` and the status line); it resets when `/clear` starts a new session and is distinct from the 5-hour and 7-day plan windows, which stay percentages. A later reading appends the delta as `turn`. Grok's figure is `session.costUsdTicks` in the session's `usage.json` (10¹⁰ ticks per dollar), with the turn's cost when recorded. No figure renders as `—`. The rail never prices tokens itself.
- **Cache.** Billing mode (plan or API key), the prompt-cache TTL (1 h on a plan, 5 min on an API key) and the time to expiry, e.g. `plan · 1h · warm 42m left` or `API · 5m · cold 12m`. Each main-loop request renews it. A request after expiry resends the full history, about 10× a warm request on a 100k-token session. `—` before the first request and under Grok.
- **Connectors.** MCP servers and their connection state, from `claude mcp list`.

### Git tab

```
 my-app · main                       ↻ 4s
 ▌ Next  merge #35 · rebase #36
 ────────────────────────────────────────
 │ main
 ┣▸ ● feature/35-branch-map    ↑4↓1 #35 ✓
 │ └▸ feature/36-colours         ↑2 #36 ◌
 ┣▸ feature/40-pets                 #40 ✗
 └▸ feature/41-api        not checked out
```

A tree of open branches. Each branch hangs under the branch it would rebase onto: its pull request's base, else the nearest open branch whose tip is its ancestor, else the default branch (the dim trunk). A pull request with no local checkout is listed as `not checked out`; a detached checkout is one dim line.

- **Banner.** `Next` names the trunk pull request whose checks pass and whose merge is clean, then the child to rebase once it lands. `Held` is the same pull request when GitHub reports it dirty, when it shares a changed file with a branch that is neither its parent nor its child, or when merging it into its parent conflicts. A child editing its parent's files is a stack and stays `Next`. A child never takes the line while its parent is open. The rail never merges or rebases anything.
- **Rows.** `↑` ahead of the parent, `↓` behind, the pull request number, and one lamp: `✓` passing, `✗` failing or conflicting, `◌` draft or running. The lane colour is green for the `Next` branch, yellow for a shared file, red for a failed check or a real conflict.
- **Expanded row** (`Enter`): `+N −N` and the uncommitted count, clashing and conflicting files, checks (failing first), a requested-changes review line (one `gh pr view` when the row opens), and actions: go to that checkout's session, open the pull request, copy the branch name.

```
 ┣▾ ● feature/35-branch-map    ↑4↓1 #35 ✓
 │┃   +42 −7 · 3 uncommitted
 │┃   clash  rail.mjs
 │┃   ✗ lint                      failing
 │┃   ✓ test
 │┃   Go to session
 │┃   Open PR #35
 │┃   Copy branch name
 │┃└▸ feature/36-colours         ↑2 #36 ◌
```

Refresh: the tree about once a minute, on switching to Git, on `r`, and on a branch change. `+N −N` and the uncommitted count come from this checkout every 5 s. Checks come from one `gh` call covering your own open pull requests (up to 100). If that call fails, the last list stays and the tab says GitHub is unavailable.

### Rail keys

| Key | Does |
|---|---|
| `↑` `↓`, click | move |
| `Enter` | expand an agent, chapter or branch; open a prompt, reply, check, pull request or task output; jump to a session's iTerm window; open a devbox task in the desk |
| `Esc` | back |
| `Tab` / `Shift-Tab`, `]` / `[` | switch tabs |
| `r` | refresh |
| `c` | cycle the pet |
| `q` | close the rail |

**settings**, bottom right, opens rows for Font size, Pet, Auto-compact, Wide review, Before cache cold (Claude only) and Chores. `←` `→` changes a row; `Enter` on Font size resets it. Font size switches the Claude, desk and rail panes together to generated iTerm profiles (`session-rail 15pt` and so on, written to iTerm's DynamicProfiles). The keys these rows write are in the README's Configuration table.

## The desk

`bin/desk.mjs`, the middle pane. Tabs: **Plan**, **Diff**, **Review**, **Devbox**.

```
┌─ desk ───────────────────────────────────────────────────────────────────────┐
│  Plan   Diff +134 −6   Review 2                                              │
│ ──────────────────────────────────────────────────────────────────────────── │
│ 4 files since the branch forked  +134 −6                                     │
│                                                                              │
│ Chunk 1: Show the date and time in the header                       +95 −2   │
│ ✔ Added date and time state, pulled from the clock API once a minute         │
│       src/header.tsx                                                 +58 −2  │
│   new src/useClock.ts                                                +37 −0  │
│                                                                              │
│ Not in a chunk yet                                                  +39 −4   │
│       README.md                                                       +2 −2  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Plan.** The branch brief, live, with **Approve** when it is complete. If the session's plan-mode file is newer than the brief, that file is shown instead, with no Approve button. A change to either selects Plan and scrolls to the top. With nothing written, it says why (on the default branch, create a branch; on a feature branch, the brief is not written yet) and lists the board's Todo issues and recent work. The desk reads the folder the session was started in: a session started in a parent folder has no repo and no brief.
- **Diff.** Every file changed since the merge-base with the default branch (the same base as the rail's `+N −N`), including untracked files marked `new`, grouped under the brief's chunks with each chunk's `Done:` summary. Open a file for its diff.
- **Review.** The branch's review record: the approach review, the latest `/code-review` (each finding with file and line; `Enter` jumps to it in the diff), and wide reviews. Each finding is ● open, ✓ applied or ✗ declined (code findings: ✓ fixed, ✓ no change, ✓ skipped); declined findings show the reason. Older runs collapse to one line. The tab warns when the pull request is merged, or mergeable by a person, while the record is not clean.

- **Devbox.** Tasks dispatched to a devbox from this repo (trackers in `.claude/hetzner-dispatch/` of the main checkout): state, age, host, PR and branch. `Enter` opens one: tracker fields, the result (status, PR URL, commit, summary, blockers), the diff stat against the default branch and the last 30 log lines; `o` opens its PR. An unreachable host is one line on top with the ssh error. `Enter` on a task in the rail opens this tab on that task. With no trackers it says so and runs nothing.

The desk opens on Plan. Diff and Review keep their position until you switch.

![the desk's plan tab showing an approved brief: problem, solution, design, mockups and engineering chunks](media/desk-plan-brief.png)

### Desk keys

| Key | Does |
|---|---|
| `Tab` / `Shift-Tab`, `1` `2` `3` `4`, click | switch tabs |
| `↑` `↓`, `j` `k`, mouse wheel | move or scroll |
| `Space` / `b`, `PgDn` / `PgUp`, `g` / `G` | page, top, bottom |
| `Enter` | open a file (Diff); jump to a code finding's line (Review); open a task (Devbox) |
| `n` `p`, `Esc` | next / previous file, back to the list |
| `o` | open the task's pull request (Devbox) |
| `A` | approve the brief (Plan) |
| `r` | run an approach review (Review); refresh (other tabs) |
| `w` | wide review, when the diff is wide and Wide review is on (Review) |
| `x` | cancel a running review |
| `q` | close the desk |

## Worktrees and parallel sessions

**+ new**, on the Sessions heading, starts an isolated session. Type the problem on the rail's bottom line and press `Enter` (`Esc` cancels). The rail:

1. adds a detached worktree at the latest `main` in `<repo>.worktrees/<slug>` (`sources.newWorktree`),
2. opens a new iTerm window at the same size and position,
3. runs `claude "/start <problem>"`, so `/start` files the issue and creates the branch inside that worktree.

Each session gets its own checkout and its own agent │ desk │ rail. With one tab per window iTerm hides the tab bar; the Sessions list is the switcher.

Removal (`bin/prune.mjs`): once a **+ new** worktree's branch is merged, its tree is clean and its session is gone, Sessions and Git offer **Remove**, which runs `git worktree remove` after one confirm (never `--force`). Dirty worktrees are listed and kept. Unmerged branches are never offered, and the current checkout is never removed. After an automatic compaction off a merged branch, the rail offers that worktree too.

Claude keeps a separate project memory per worktree folder; it goes with the worktree.

## Compaction

Two automatic compactions, both Claude only, both in `hooks/compact.ts` and driven by register.ts's 2 s poll once Claude's turn has ended.

- **After a merged branch.** When the session leaves a branch (back to main, or onto the next branch) whose brief has a Done chunk and whose tip is in the default branch, it compacts once (at most 3 attempts). The summary keeps the board, working preferences, open issues and next steps, and reduces the finished branch to one line. Leaving an unmerged branch does nothing. Setting: `autoCompact`.
- **Before the cache goes cold.** In a waiting session with at least 50k tokens, the session compacts in the last stretch of the cache's life: 50 min into a plan's 1 h cache (ahead of Claude Code's own idle compact, which waits for 200k tokens), 4 min into an API key's 5 min cache, and never within 15 s of expiry or after it. Once per wait. The summary keeps the task, files, test command and next step. Rationale: a request after expiry costs about 10× a warm one on a 100k-token session; `/compact` while warm costs about 2.5×; `/compact` after expiry saves nothing. Setting: `warmCompact`. On an API key, the 1 h cache (`"promptCacheTtl": "1h"` in Claude's settings, or `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`) doubles each cache write's cost (2× instead of 1.25×), so it pays off only if you often return after 5–60 minutes.

After a compaction the context drops and the pet shrinks back to a hatchling.

## The pet

A pixel creature (snail, turtle or crab) at the bottom of the rail, drawn as an inline image in iTerm2 and as Unicode octants elsewhere. It encodes session state: pace for busy or waiting, position along the strip for brief progress (or context fill without a brief), growth stage for the branch's lifecycle, a yellow `?` while the brief waits for approval, a flinch and droop on a failed tool, one visitor per running subagent and one baby per background command. The full specification is [pets.md](pets.md).

![a hatchling snail standing still at the left edge with a yellow ? over its head, babies piled at its heel](media/reactions/held.gif)

## Operational notes

- **macOS and iTerm2 only.** Elsewhere the plugin stays quiet. On start Claude fills the screen (not macOS full screen); the desk takes 28% of the width, the rail 18.5%. `/rail` and `/desk` take their share from the agent's pane and never grow the window. If macOS blocks Automation control of iTerm2, the reply points to Privacy & Security → Automation.
- **Additional Claude logins.** `CLAUDE_CONFIG_DIR=~/.claude-work claude` (or any `~/.claude-<name>`) works: the rail reads sessions, context, plan files, tasks, account and rate limits from that directory. Panes, pet and settings stay shared.
- **Host file formats.** The rail reads Claude Code's and Grok's own files, which can change between host versions.
- **Activity cleanup.** Activity, desk and tab files in `~/.claude/session-rail/activity/` are deleted once their session's process is gone. Files of a live session, and any file written in the last minute, are kept. Ending a session deletes its own files; `/clear` keeps them.
