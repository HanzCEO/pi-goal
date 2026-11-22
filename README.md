# pi-goal

My pi.dev extension for `/goal`.

## Parallel audits

`goal_complete` splits the task list across isolated auditors, one git
worktree per shard, and merges their verdicts. A goal is approved only when
every task passes. Each auditor records per-task results with
`goal_audit_task` and submits a shard verdict with `goal_audit_result`.

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

The widget shows a Braille multi-progress bar: up to four auditors per bar
row, one dot row per auditor, with two dot columns per cell for sub-cell
resolution. A second bar row is used for up to eight auditors; more are
summarized as `+N` in the legend.
