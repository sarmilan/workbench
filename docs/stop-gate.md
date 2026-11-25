# The Stop test gate

A Stop hook that runs the project's tests when a turn ends and returns the agent to work if they fail. `bin/stop-hook.mjs` is the command hook for both hosts; the rules are `bin/stopgate.mjs` (pure), shared with Claude's `classic.Stop` in `hooks/register.ts`.

## When it runs

The stop is allowed without running anything when:

- no test command resolves (a folder with no tests is never blocked),
- the checkout is on the default branch (`origin/HEAD`, else `main` or `master`),
- the branch has no commits past its merge-base and a clean tree (nothing changed to test),
- the stop is already a continuation (`stop_hook_active`), so the hook cannot loop,
- the person interrupted the turn.

## Command resolution

The first match wins:

1. **This checkout:** `.git/session-rail/tests.json` — `{ "command": "npm test" }`, or `{ "command": false }` to disable the gate here without touching the project.
2. **The project:** `session-rail.json` at the repo root — `{ "testCommand": "npm test" }`, or `{ "testCommand": false }` to disable it for the project.
3. **`AGENTS.md`** at the git toplevel: the first fence tagged `test` (one command per line, joined with `&&`), else a line such as `Tests: npm test` or `- Run tests: \`npm test\``, else the first command under a heading named Tests. Only those shapes are parsed, so prose about tests resolves to nothing.
4. **`package.json`:** `npm test` when `scripts.test` is real (npm's `no test specified` placeholder does not count). In a workspace it is filtered to the packages changed since the merge-base and their dependents: `npx turbo run test --filter=...[<merge-base>]` with a `turbo.json`, else `pnpm -r --filter "...[<merge-base>]" test` with a `pnpm-workspace.yaml`.
5. **This repo only,** when nothing above resolves: `claude plugin test .` and the frame checks from the dev notes. In practice this repo's `AGENTS.md` names a fence, so step 3 applies.

A minimal `AGENTS.md` for a host project:

````markdown
# AGENTS.md

## Tests

```test
npm test
```
````

## On failure

- **Claude:** the hook exits 2 with the reason on stderr, which Claude receives.
- **Grok:** the hook prints a block decision and exits 0, which is how Grok hooks report a block.

The reason includes the tail of the test output.

**Repeat limit.** A failure is fingerprinted by its output with durations and timestamps stripped (`failureFingerprint`), so a cached turbo replay matches. The same fingerprint holds at most two stops in a row (`MAX_HOLDS`). The third stop is let through with one note, shown by Claude as a system message; later ones pass quietly until the result changes. The streak lives in the session's lock record.

**On the rail.** One line, `tests failed`, and the pet flinches and droops as it does for a failed tool. A later pass clears both.
