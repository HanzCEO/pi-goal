# pi-goal

My pi.dev extension for `/goal`.

## Parallel audits

`goal_complete` splits the task list across isolated auditors, one git
worktree per shard, and merges their verdicts. A goal is approved only when
every task passes. Each auditor records every acceptance criterion with
`goal_audit_criterion` as it verifies it, records per-task results with
`goal_audit_task`, and submits a shard verdict with `goal_audit_result`.

Audit config lives in `.pi/goal/config.json`:

```json
{
  "audit": {
    "auditors": 3,
    "maxConcurrency": 3,
    "worktree": true,
    "linkPaths": ["node_modules", ".venv", "venv"],
    "timeoutMs": 900000,
    "thinkingLevel": "low"
  }
}
```

Use `/goal-auditors <n|auto>` to change the count without editing the file.
`auto` uses one auditor per task, up to 16, with concurrency capped at 8.

Environment overrides: `PI_GOAL_AUDITORS`, `PI_GOAL_AUDIT_CONCURRENCY`,
`PI_GOAL_AUDIT_WORKTREE`, `PI_GOAL_AUDIT_TIMEOUT_MS`.

Worktrees are created under `.pi/goal/audit/A<N>-<pid>` from HEAD with the
executor's uncommitted tracked and untracked changes overlaid, so the auditor
verifies what was actually delivered. `linkPaths` are symlinked from the main
tree so tests and builds do not need a fresh install in every worktree.

The widget's progress bar is a braille criteria track: one cell per acceptance
criterion, in task order, so a 3-task goal with 4 criteria each renders as
12 cells. Cells fill vertically. `⠤` is unverified, `⠿` is verified, and the
criterion an auditor is checking right now cycles through `⠼⠶⠧⠏⠛⠹`, so the
bar moves while the audit runs.

Every cell of a task shares that task's color, and each task gets a different
hue (red, blue, yellow, green, magenta, cyan, orange, violet, pink, lime, then
it wraps) so group boundaries read at a glance. A failed criterion is the one
exception: it renders as `⠭` in the theme's error color, because a failure must
never blend into its neighbors. The legend under the bar maps each color to its
task and its verified count.

Groups wrap to a second row when they do not fit, and a whole group moves down
rather than being split unless it is longer than the row itself. Beyond two
rows the bar truncates with `…` and the legend collapses the rest into `+N`.
