# The CI chore

One bounded chore: re-check failing CI on the branch you have open. It is not a general cron, and it is not `/loop` (that stays inside one session). It is off until `chores` is true.

Turn it on with **↻ Chores** in the rail's settings (`"chores": true` in `~/.claude/session-rail/settings.json`). Then press **↻ Re-run failing CI** under Sessions, or run the commands below from the repo. `/schedule` is that same path. Each chore gets its own detached worktree in `<repo>.worktrees/chore-<id>`, so it cannot edit the checkout you have open.

**Leave it off** when any of these is true:

- The machine would be unattended. This includes overnight on the host Mac, a standing auto-approve, and any runner that merges while you are away. The chore does not sandbox the Mac and it does not approve anything for you.
- You do not want a budget. There is no way to run it without a round cap.
- There is no signal. With no checks and no tests, every round is empty and it stops after two. It will not have fixed anything.

The budget is a count of rounds. It is not a dollar amount. Session cost on the rail is a separate question, and this chore does not invent one.

## Three dry runs

From a git checkout, with chores on:

```
node bin/chore-run.mjs start --budget 5 --no-window
node bin/chore-run.mjs round --dry-run --failing lint
node bin/chore-run.mjs round --dry-run --failing test
node bin/chore-run.mjs round --dry-run --failing typecheck
node bin/chore-run.mjs show
```

Spend is 3 of 5. The state file (`.git/session-rail/chores/ci-<branch>.json`) starts with a `summary` you can read without the rest of the JSON: the worktree, the spend, the empty-round count, and the line that a person reviews before anything merges.

A dry run does not call `gh`. It still spends a round, so the cap is real.

## Two empty rounds

```
node bin/chore-run.mjs round --dry-run --green
node bin/chore-run.mjs round --dry-run --green
node bin/chore-run.mjs round --dry-run --green
```

The first green is one empty round. The second stops the loop. The third prints `Stopped without further spend` and the spend in the state file does not move. A live round treats "checks green", "no checks", and "no pull request" as empty. A failing check, or a check still running, is work and resets the empty count.

## What it will not do

- Merge. `gh pr merge` is refused and does not spend a round. The review cadence is the same gate as every other session.
- Approve the brief, or edit the repo. A later session in the worktree still waits for an approved brief.
- Open iTerm when iTerm is not already running. The worktree is the sandbox either way.
- Keep going after two empty rounds or a spent budget.

`node bin/chore-run.mjs stop` marks the file for a person without spending. The Sessions row is busy while a round runs, waiting when the person should look, and blocked when the loop has stopped itself.
