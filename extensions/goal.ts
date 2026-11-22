/**
 * pi-goal, a goal-driven agentic workflow extension
 *
 * Invoke with `/goal <topic>`. The command registers the goal and hands
 * control to the agent. The agent refines the goal, plans the work, and
 * executes it using the provided tools to interact with the user.
 *
 * Tools:
 *   goal_ask            Ask the user a clarifying question
 *   goal_approve_plan   Submit a task plan for user approval
 *   goal_update_task    Mark a task in-progress or completed
 *   goal_complete       Submit the goal for audit (requires all tasks done)
 *   goal_audit_criterion Record a verdict for one acceptance criterion
 *   goal_audit_task    Record the verdict for one assigned task
 *   goal_audit_result   Submit the auditor's shard verdict
 *   goal_fail           Mark the goal as failed
 *
 * Widget tracking:
 *   A widget above the editor shows the goal and task progress. It is
 *   updated live (via a file watcher on the state file) and cleared when
 *   the goal is completed, failed, stopped, or deleted.
 *
 * Audit loop:
 *   `goal_complete` does not finalize the goal. It transitions the state
 *   to "auditing" and dispatches one isolated auditor per task shard in
 *   parallel, each in its own git worktree via the pi SDK
 *   (createAgentSession). The auditors' thinking tokens and tool calls are
 *   streamed live into the widget's audit log so the user watches the audit
 *   happen. Each auditor records per-task results through goal_audit_task and
 *   a shard verdict through goal_audit_result (AUDITOR-ONLY). The coordinator
 *   merges all shard verdicts: the goal is approved only when every task
 *   passed. On rejection the failing tasks return to "pending" so the host
 *   can re-execute and call goal_complete again.
 *
 * Built on the research from the pi-goal project:
 *   - Workers execute in fresh, bounded contexts
 *   - Execution and assessment are decoupled
 *   - Task state is externalized and versioned
 *   - The user is the decision maker, the agent is the guide
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, getMarkdownTheme, getSelectListTheme, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Container, Markdown, Spacer, Text, SelectList, type Component, type SelectItem, getKeybindings, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

const CUSTOM_OPTION = "Others (custom answer)";

// Inter-extension beep channel. pi-beep subscribes to this on pi.events; the
// emit is a silent no-op when pi-beep is not loaded. Matches the BEEP_EVENT
// export in pi-beep's service module.
const BEEP_EVENT = "beep:notify";

const buildGoalInstructionPrompt = (topic: string): string =>
	`I want to accomplish this goal: ${topic}

Work through it step by step:

0. **Explore**. Before anything, explore and gain enough context about the subject matter. Don't ask the user about the goal. Try to explore the codebase first. Only if you have a sudden question, DO IMMEDIATELY ASK the user. Do not postpone using goal_ask. This can be skipped if you already have investigation result before this message.

1. **Refine**. If the goal is vague or has missing constraints, use goal_ask to ask me clarifying questions. Choose the right question type with this decision framework:

   - **radio_answers** when the possible answers are a small, enumerable set and the user should pick exactly one. Pass the candidate answers in \`options\`, putting your recommended answer first. This is the most common type for clarifying questions (e.g., "Which package manager do you use?" with options ["pnpm", "npm", "yarn"]).

   - **multiple_answers** when several independent choices can all be valid simultaneously and the user may want to pick more than one. Pass the candidates in \`options\` (e.g., "Which features interest you?" with options ["CLI", "GUI", "API", "Plugin"]).

   - **open_ended** when the possible answers are unbounded, unknown, or you need free-form explanation. This is the last resort; prefer radio_answers when you can enumerate the options.

   Ask ONE question at a time. Do not combine multiple clarifying questions into a single goal_ask call. Each question is asked separately.
   Keep asking until you have a clear, actionable goal.

2. **Plan**. Decompose the goal into a small set of tasks. Each task needs a contract (what to do) and acceptance criteria (how to verify it is done). Tasks should be ordered so each builds on the completed state of the prior ones. Never ever execute tests or builds, only the authoritative auditor do this.

3. **Approve**. Use goal_approve_plan to submit the refined goal and task list for my approval. If I reject it, revise and resubmit.

4. **Execute**. Once approved, execute each task. Prefer spawning isolated subagents (fresh-context, worktree-isolated) per task so each one has a clean start. After each task, verify it yourself with a fresh, critical eye, then immediately call goal_update_task to mark it "completed". Do not move on to the next task before marking the current one done.

5. **Mark done**. After each task is complete, immediately call goal_update_task with taskId and status "completed". Do not procrastinate. Mark it done right after verification.

6. **Complete**. When all tasks are marked done, call goal_complete with a summary. This dispatches parallel isolated auditors (one per task shard, handled by the goal extension, not by you). Their thinking and tool calls stream into the goal panel above the editor while they verify the work in isolated git worktrees.

7. **Audit result**. goal_audit_result is AUDITOR-ONLY. The in-process auditors call it directly to submit their shard verdicts, and the coordinator merges them. You do not call it. On rejection, fix the failing tasks (they will be reset to pending) and call goal_complete again. On approval, the goal is finalized.

The state file at .pi/goal/state.json is updated automatically. You can read it to track progress.`;

const AUDITOR_SYSTEM_PROMPT_TEMPLATE = `You are the goal auditor for an agentic workflow. Your job is to verify, with a fresh and critical eye, that the work delivered for a goal actually meets every acceptance criterion. You are an independent reviewer: trust nothing, verify everything yourself.

You have read-only verification tools (read, bash, grep, find, ls) plus write/edit only when you must create test artifacts; you must NEVER modify the goal's state file (__STATEPATH__).

## Goal
__GOAL__

## Claimed work summary (from the executor)
__RESULT__

## Your assignment
__ASSIGNMENT__

## Tasks and acceptance criteria to verify
__TASKS__

## Procedure
1. Read the current state from __STATEPATH__ if you need the executor's claims.
2. For each task assigned to you, inspect the actual deliverables: read the files, run the commands, check the artifacts. Where a criterion is verifiable by running code or checking a file, do it. Do not take the executor's word.
3. Verify the acceptance criteria one at a time. Immediately after you check each single criterion, call goal_audit_criterion with { taskId, index, passed, reason }. index is the 1-based position of that criterion in the task's numbered acceptance-criteria list. This drives the user's live progress bar, so record criteria as you go and never batch them at the end.
4. Immediately after verifying a task, call goal_audit_task with { taskId, passed, reason }. Do this for every task assigned to you.
5. Keep working until every criterion is either verified or disproven.

## Verdict
When every assigned task has been recorded, call goal_audit_result exactly once with:
- approved: true if EVERY acceptance criterion of EVERY task assigned to you is met, else false.
- feedback: a concise verdict explaining what you verified and, on rejection, what failed.
- failedTasks: only when approved=false, the list of { id, reason } for each assigned task that did not meet its criteria. Omit the field when approved=true.

Be strict but fair. A single unmet criterion means rejection.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "auditing" | "completed" | "failed" | "paused" | "stopped";

interface GoalState {
	goal: string;
	refinedGoal: string | null;
	status: GoalStatus;
	tasks: TaskState[];
	result: string | null;
	auditFeedback: string | null;
	auditLog: string[];
	audit?: AuditRunState | null;
	yoloMode: boolean;
	yoloSessionId: string | null;
	createdAt: number;
	updatedAt: number;
}

interface AuditRunState {
	startedAt: number;
	finishedAt: number | null;
	strategy: "per-task";
	auditors: number;
	shards: AuditShardState[];
}

interface AuditShardState {
	id: string;
	taskIds: string[];
	status: "queued" | "running" | "verdict" | "error";
	worktree: string | null;
	verified: number;
	approved: boolean | null;
	feedback: string | null;
	failedTasks: { id: string; reason: string }[];
	results: Record<string, { passed: boolean; reason: string | null }>;
}

interface AuditConfig {
	auditors: number;
	maxConcurrency: number;
	worktree: boolean;
	linkPaths: string[];
	timeoutMs: number;
	thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

// Per-criterion verification state. The array is parallel to
// acceptanceCriteria, so criteriaStatus[i] belongs to acceptanceCriteria[i].
// Only settled verdicts are persisted; the "currently verifying" cell is
// derived at render time from the auditor that owns the task, which keeps the
// auditor's tool surface to one call per criterion.
type CriterionStatus = "pending" | "passed" | "failed";

interface TaskState {
	id: string;
	description: string;
	contract: string;
	acceptanceCriteria: string[];
	status: "pending" | "approved" | "in-progress" | "completed" | "failed";
	auditResult: string | null;
	error: string | null;
	// Optional so state files written before per-criterion tracking still load.
	criteriaStatus?: CriterionStatus[];
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function getStateDir(): string {
	return path.join(process.cwd(), ".pi", "goal");
}

function getStatePath(): string {
	return path.join(getStateDir(), "state.json");
}

function ensureStateDir(): void {
	const dir = getStateDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState(): GoalState | null {
	const p = getStatePath();
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as GoalState;
	} catch {
		return null;
	}
}

function saveState(state: GoalState): void {
	ensureStateDir();
	state.updatedAt = Date.now();
	fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

function clearState(): void {
	const p = getStatePath();
	if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Per-criterion progress helpers
// ---------------------------------------------------------------------------

function pendingCriteria(count: number): CriterionStatus[] {
	return Array.from({ length: Math.max(0, count) }, () => "pending" as CriterionStatus);
}

// Normalize a task's criterion array to the length of its acceptance criteria,
// so a state file from an older run (or a hand-edited plan) never yields a bar
// that is out of sync with the task definition.
function taskCriteriaStatus(task: TaskState): CriterionStatus[] {
	const total = task.acceptanceCriteria.length;
	const raw = task.criteriaStatus ?? [];
	const out: CriterionStatus[] = [];
	for (let i = 0; i < total; i++) {
		const value = raw[i];
		out.push(value === "passed" || value === "failed" ? value : "pending");
	}
	return out;
}

// ---------------------------------------------------------------------------
// Audit configuration. Lives next to the state file in .pi/goal/config.json.
// Environment variables override the file, so one-off runs do not need a file
// edit. Auditors are capped by the number of tasks at dispatch time.
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT_CONFIG: AuditConfig = {
	auditors: 3,
	maxConcurrency: 3,
	worktree: true,
	linkPaths: ["node_modules", ".venv", "venv"],
	timeoutMs: 15 * 60 * 1000,
	thinkingLevel: "low",
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (/^(1|true|on|yes)$/i.test(value)) return true;
		if (/^(0|false|off|no)$/i.test(value)) return false;
	}
	return fallback;
}

function isThinkingLevel(value: unknown): value is AuditConfig["thinkingLevel"] {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function getAuditConfigPath(): string {
	return path.join(getStateDir(), "config.json");
}

function loadAuditConfig(): AuditConfig {
	let raw: Record<string, unknown> = {};
	const configPath = getAuditConfigPath();
	if (fs.existsSync(configPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
			const audit = parsed.audit;
			raw = audit && typeof audit === "object" ? (audit as Record<string, unknown>) : parsed;
		} catch {
			raw = {};
		}
	}
	const env = process.env;
	return {
		auditors: clampInt(env.PI_GOAL_AUDITORS ?? raw.auditors, 1, 16, DEFAULT_AUDIT_CONFIG.auditors),
		maxConcurrency: clampInt(
			env.PI_GOAL_AUDIT_CONCURRENCY ?? raw.maxConcurrency,
			1,
			8,
			DEFAULT_AUDIT_CONFIG.maxConcurrency,
		),
		worktree: parseBool(env.PI_GOAL_AUDIT_WORKTREE ?? raw.worktree, DEFAULT_AUDIT_CONFIG.worktree),
		linkPaths: Array.isArray(raw.linkPaths)
			? raw.linkPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
			: DEFAULT_AUDIT_CONFIG.linkPaths,
		timeoutMs: clampInt(
			env.PI_GOAL_AUDIT_TIMEOUT_MS ?? raw.timeoutMs,
			30_000,
			3_600_000,
			DEFAULT_AUDIT_CONFIG.timeoutMs,
		),
		thinkingLevel: isThinkingLevel(raw.thinkingLevel) ? raw.thinkingLevel : DEFAULT_AUDIT_CONFIG.thinkingLevel,
	};
}

function saveAuditConfig(patch: Partial<AuditConfig>): AuditConfig {
	const configPath = getAuditConfigPath();
	let existing: Record<string, unknown> = {};
	if (fs.existsSync(configPath)) {
		try {
			existing = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		} catch {
			existing = {};
		}
	}
	const audit = (existing.audit && typeof existing.audit === "object" ? existing.audit : {}) as Record<string, unknown>;
	ensureStateDir();
	fs.writeFileSync(
		configPath,
		JSON.stringify({ ...existing, audit: { ...audit, ...patch } }, null, 2),
		"utf-8",
	);
	return loadAuditConfig();
}

// Yolo mode is persisted in the goal state so it survives process lifecycles
// (module reloads, /reload, process restarts within the same directory). It is
// scoped to the session that enabled it: effective when the recorded
// yoloSessionId matches the current session id. A different session (e.g. after
// /new) therefore starts with yolo off, which also fixes the previous
// module-scope variable leaking yolo across sessions in the same process.
function isYoloActive(ctx: ExtensionContext): boolean {
	const state = loadState();
	if (!state || state.yoloMode !== true) return false;
	return state.yoloSessionId === ctx.sessionManager.getSessionId();
}

// ---------------------------------------------------------------------------
// Beep integration: page the user when the agent is about to block on input.
// The emit goes onto pi's shared extension event bus, which pi-beep listens
// on; when pi-beep is not loaded nothing happens. Only beep when the tool is
// actually going to block on the user in the terminal: interactive mode and
// yolo off (yolo auto-answers/auto-approves, so no attention is needed).
// ---------------------------------------------------------------------------
let piEvents: ExtensionAPI["events"] | undefined;

function maybeBeep(ctx: ExtensionContext, title: string, body: string): void {
	if (!piEvents || ctx.mode !== "tui" || isYoloActive(ctx)) return;
	piEvents.emit(BEEP_EVENT, { title, body });
}

// Tail-truncate a line for narrow widget columns: keep the last maxWidth
// visible characters so the viewer sees
// the most recent tokens of a growing line (e.g. the auditor's thinking
// stream) instead of the stale head. A leading "label: " prefix (like
// "thinking: ") is preserved so the row stays recognizable. ANSI-free by
// design (styling is applied at merge time).
function tailTruncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
	if (maxWidth <= 0 || text.length === 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) return ellipsis.slice(0, maxWidth);

	// Keep a leading "label: " prefix (e.g. "thinking: ") so the row stays
	// recognizable even when the line overflows; only the content tail is cut.
	// The label is kept only if the ellipsis plus at least one content cell fits.
	let label = "";
	let content = text;
	const labelMatch = text.match(/^[^:]{1,24}: /);
	if (labelMatch) {
		const candidate = labelMatch[0];
		if (visibleWidth(candidate) + ellipsisWidth + 1 <= maxWidth) {
			label = candidate;
			content = text.slice(label.length);
		}
	}
	const labelWidth = visibleWidth(label);
	const budget = maxWidth - ellipsisWidth - labelWidth;
	if (budget <= 0) return label + ellipsis;

	// Fast path: pure printable ASCII content (1 char == 1 cell).
	if (/^[\x20-\x7e]*$/.test(content)) {
		return label + ellipsis + content.slice(-budget);
	}

	// Slow path for wide/emoji content: walk graphemes from the end, keeping
	// visible width within budget.
	const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(content)];
	const kept: string[] = [];
	let width = 0;
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i].segment;
		const w = visibleWidth(seg);
		if (width + w > budget) break;
		kept.unshift(seg);
		width += w;
	}
	if (kept.length === 0) return label + ellipsis;
	return label + ellipsis + kept.join("");
}

// ---------------------------------------------------------------------------
// Goal paraphrasing (cheap heuristic for short widget titles)
// ---------------------------------------------------------------------------

function paraphraseGoal(goal: string): string {
	const trimmed = goal.trim().replace(/\s+/g, " ");
	// Take the first sentence as a paraphrase; no hard character cap.
	const firstStop = trimmed.search(/[.!?]/);
	if (firstStop > 0) return trimmed.slice(0, firstStop + 1);
	return trimmed;
}

// ---------------------------------------------------------------------------
// Widget: task window around the current task (3-window)
// ---------------------------------------------------------------------------

function buildTaskWindow(tasks: TaskState[], currentIndex: number, availWidth: number, maxLines = 4): string {
	if (tasks.length === 0) return "";
	// Center the window around the current task: show t-1, t, t+1, t+2.
	const start = Math.max(0, currentIndex - 1);
	const end = Math.min(tasks.length, start + maxLines);
	const prefixLen = 4; // "> o " = 4 chars
	const maxDescLen = Math.max(10, availWidth - prefixLen);
	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const task = tasks[i];
		const marker = i === currentIndex ? ">" : " ";
		const icon =
			task.status === "completed"
				? "+"
				: task.status === "failed"
					? "x"
					: task.status === "in-progress"
						? ">"
						: task.status === "approved"
							? "*"
						: "o";
		const desc = task.description.length > maxDescLen ? task.description.slice(0, maxDescLen - 1) + "..." : task.description;
		lines.push(`${marker} ${icon} ${desc}`);
	}
	return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Widget rendering
// The live widget is built by refreshWidget (Container + cached Text[]), which
// calls renderWidgetLines below. (An earlier GoalWidget class was dead code.)
// ---------------------------------------------------------------------------
// Render the widget as plain styled strings (theme + colors applied).

function renderWidgetLines(
	state: GoalState,
	width: number,
	rows: number,
	theme: ThemeLike | undefined,
	yoloActive: boolean,
): string[] {
	const style = theme
		? makeStyleHelpers(theme)
		: {
				bold: (s: string) => s,
				italic: (s: string) => s,
				fg: (_c: string, s: string) => s,
				muted: (s: string) => s,
				paint: (_groupIndex: number, s: string) => s,
			};

	const innerWidth = Math.max(20, width - 2);
	const hr = style.fg("border", "─".repeat(innerWidth));

	const total = state.tasks.length;
	const completed = state.tasks.filter((t) => t.status === "completed").length;
	const failed = state.tasks.filter((t) => t.status === "failed").length;
	const currentIndex = state.tasks.findIndex((t) => t.status === "in-progress" || t.status === "approved");

	const title = (state.refinedGoal || state.goal).trim() || "(no goal yet)";
	const paraphrased = paraphraseGoal(title);

	// Cap widget height to prevent scrolling off terminal screen and causing redraw flickers
	const maxWidgetLines = Math.max(5, Math.min(8, Math.floor(rows * 0.35)));

	const out: string[] = [];

	// Header row: GOAL (paraphrased)
	const headerLabel = style.bold(style.fg("accent", "GOAL"));
	const yoloBadge = yoloActive ? style.bold(style.fg("warning", " YOLO ")) : "";
	const statusBadge = state.status === "auditing"
		? style.bold(style.fg("warning", " AUDITING "))
		: state.status === "paused"
			? style.bold(style.fg("muted", " PAUSED "))
			: style.fg("muted", " active ");
	out.push(`${headerLabel}${style.fg("dim", " · ")}${style.italic(paraphrased)}${style.fg("dim", "  ")}${yoloBadge}${statusBadge}`);

	// Divider
	out.push(style.fg("dim", hr));

	if (state.status === "auditing") {
		// Criteria bar: one cell per acceptance criterion, grouped and colored
		// per task, with the criterion under verification animating.
		const groups = buildCriterionGroups(state, "audit");
		const barWidth = Math.max(8, innerWidth - 2);
		const barRows = renderCriterionRows(groups, barWidth, style);
		const shownRows = barRows.slice(0, 2);
		if (shownRows.length === 0) {
			out.push(`  ${style.fg("dim", "waiting for the first criterion verdict...")}`);
		} else {
			for (let i = 0; i < shownRows.length; i++) {
				const truncated = i === shownRows.length - 1 && barRows.length > shownRows.length;
				out.push(`  ${shownRows[i]}${truncated ? style.fg("dim", "…") : ""}`);
			}
		}
		const legend = renderCriterionLegend(groups, state.tasks, Math.max(10, innerWidth - 2), style);
		if (legend) out.push(`  ${legend}`);

		// Active task being verified by whichever auditor is running.
		const active = findActiveAuditTask(state);
		if (active) {
			const taskPrefix = style.bold(style.fg("warning", `Checking ${active.auditorId}:`));
			const maxDesc = Math.max(10, innerWidth - visibleWidth(taskPrefix) - 12);
			const desc = truncateToWidth(active.task.description, maxDesc, "...", false);
			out.push(`  ${taskPrefix} [${active.task.id}] ${desc}`);
		} else if (state.auditFeedback && state.auditFeedback !== "auditor pending...") {
			const verdictLabel = style.bold(style.fg("accent", "Verdict:"));
			const maxVerdict = Math.max(10, innerWidth - visibleWidth(verdictLabel) - 6);
			const verdictText = truncateToWidth(state.auditFeedback, maxVerdict, "...", false);
			out.push(`  ${verdictLabel} ${verdictText}`);
		} else {
			const pendingShard = (state.audit?.shards ?? []).some((shard) => shard.status === "queued");
			out.push(
				`  ${style.fg("dim", pendingShard ? "Waiting for the next auditor slot..." : "Auditors are concluding verification...")}`,
			);
		}

		// Latest log line or streaming thinking delta (any auditor).
		const log = state.auditLog || [];
		if (log.length > 0) {
			const lastRaw = sanitizeLogLine(log[log.length - 1]);
			const isThinking = lastRaw.includes("] thinking: ");
			const maxW = Math.max(10, innerWidth - 6);
			const displayLog = isThinking
				? tailTruncateToWidth(lastRaw, maxW)
				: truncateToWidth(lastRaw, maxW, "...", false);
			const styledLog = isThinking ? style.fg("dim", displayLog) : style.fg("muted", displayLog);
			out.push(`  ${styledLog}`);
		} else {
			out.push(`  ${style.fg("dim", "Waiting for auditor output...")}`);
		}

		out.push(style.fg("dim", hr));
		return out;
	}

	// Progress: criteria bar grouped per task, with the task and percent counters.
	if (total > 0) {
		const pct = Math.round((completed / total) * 100);
		const progressLabel = style.fg("muted", `${completed}/${total} `);
		const percentLabel = style.fg("accent", `${pct}%`);
		const failedLabel = failed > 0 ? style.fg("error", `  ${failed} failed`) : "";
		const reserved = visibleWidth(progressLabel) + visibleWidth(percentLabel) + visibleWidth(failedLabel) + 2;
		const barWidth = innerWidth - reserved;
		const barRows = barWidth >= 8 ? renderCriterionRows(buildCriterionGroups(state, "exec"), barWidth, style).slice(0, 2) : [];
		out.push(`${progressLabel}${barRows[0] ?? ""}  ${percentLabel}${failedLabel}`);
		// Continuation rows line up with the bar, not with the counters.
		const barIndent = " ".repeat(visibleWidth(progressLabel));
		for (let i = 1; i < barRows.length; i++) out.push(`${barIndent}${barRows[i]}`);
	}

	// Task window: dynamic line budget based on terminal rows (leaves room for header, progress, divider)
	const taskLinesBudget = Math.max(1, maxWidgetLines - 4);
	if (total > 0) {
		const window = buildTaskWindow(state.tasks, currentIndex, innerWidth, taskLinesBudget);
		for (const line of window.split("\n")) {
			const styled = styleTaskLine(line, style, currentIndex);
			out.push(`  ${styled}`);
		}
	} else {
		out.push(style.fg("dim", "  no tasks planned yet"));
	}

	out.push(style.fg("dim", hr));
	return out;
}

interface ThemeLike {
	fg(name: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	// Present on the host Theme; used to pick truecolor over 256-color escapes
	// for the per-task group hues.
	getColorMode?(): string;
}

function makeStyleHelpers(theme: ThemeLike) {
	// Canonical color names used by renderWidgetLines. A host theme is
	// expected to understand these; if it does not (or its fg throws),
	// we fall back to plain text rather than crashing the widget.
	const WIDGET_COLORS = ["accent", "border", "warning", "muted", "dim", "text", "success", "error"];

	const fg = (c: string, s: string): string => {
		if (!WIDGET_COLORS.includes(c)) return s;
		try {
			return theme.fg(c, s);
		} catch {
			return s;
		}
	};

	// Per-task-group hues live outside the theme palette, so they need raw
	// ANSI. The mode comes from the theme when it exposes one; 256-color is
	// the safe default because every terminal that renders the rest of the
	// widget understands it.
	const colorMode = (): "truecolor" | "256color" => {
		try {
			return theme.getColorMode?.() === "truecolor" ? "truecolor" : "256color";
		} catch {
			return "256color";
		}
	};

	const paint = (groupIndex: number, s: string): string => {
		const color = GROUP_COLORS[((groupIndex % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length];
		const ansi =
			colorMode() === "truecolor" ? `\x1b[38;2;${color.rgb.join(";")}m` : `\x1b[38;5;${color.xterm}m`;
		return `${ansi}${s}\x1b[39m`;
	};

	return {
		fg,
		paint,
		bold: (s: string) => theme.bold(s),
		italic: (s: string) => theme.italic(s),
		muted: (s: string) => fg("muted", s),
	};
}

// ---------------------------------------------------------------------------
// Criteria progress bar
// One braille cell per acceptance criterion, in task order. A cell fills
// vertically: empty cells sit on their base dot, verified cells are full, and
// the criterion an auditor is currently verifying cycles through vertical fill
// frames so the bar visibly moves while it works.
//
// Every cell of a task shares that task's color, and consecutive tasks get
// different hues so group boundaries read at a glance. Failed criteria break
// the group color on purpose: a failure must never blend into its neighbors.
// ---------------------------------------------------------------------------

type CriterionCell = "pending" | "active" | "done" | "failed";

interface CriterionGroup {
	taskIndex: number;
	cells: CriterionCell[];
}

const CRITERION_GLYPHS: Record<"pending" | "done" | "failed", string> = {
	pending: "⠤",
	done: "⠿",
	failed: "⠭",
};

// Vertical fill frames. Every glyph is a four-dot column pattern, so stepping
// through them reads as a bar filling inside the cell rather than a rotation.
const CRITERION_ACTIVE_FRAMES = ["⠼", "⠶", "⠧", "⠏", "⠛", "⠹"];

// Task group hues, as xterm-256 index plus the matching truecolor triplet. Ten
// distinct hues before any repeat, which covers realistic plans; longer plans
// wrap around.
const GROUP_COLORS: Array<{ xterm: number; rgb: [number, number, number] }> = [
	{ xterm: 203, rgb: [255, 95, 95] }, // red
	{ xterm: 111, rgb: [135, 175, 255] }, // blue
	{ xterm: 221, rgb: [255, 215, 95] }, // yellow
	{ xterm: 114, rgb: [135, 215, 135] }, // green
	{ xterm: 176, rgb: [215, 135, 215] }, // magenta
	{ xterm: 117, rgb: [135, 215, 255] }, // cyan
	{ xterm: 215, rgb: [255, 175, 95] }, // orange
	{ xterm: 141, rgb: [175, 135, 255] }, // violet
	{ xterm: 211, rgb: [255, 135, 175] }, // pink
	{ xterm: 191, rgb: [215, 255, 95] }, // lime
];

let animationTick = 0;

// True when an auditor is currently responsible for this task, which is what
// makes its next pending criterion animate.
function taskUnderVerification(state: GoalState, taskId: string): boolean {
	const shards = state.audit?.shards;
	if (!shards || shards.length === 0) return false;
	for (const shard of shards) {
		if (shard.taskIds.includes(taskId)) return shard.status === "running";
	}
	return false;
}

function criterionCells(task: TaskState, state: GoalState, mode: "audit" | "exec"): CriterionCell[] {
	const cells = taskCriteriaStatus(task).map<CriterionCell>((status) => {
		if (status === "passed") return "done";
		if (status === "failed") return "failed";
		return "pending";
	});
	if (cells.length === 0) return cells;

	if (mode === "exec") {
		// Until an auditor records real per-criterion results, the task's own
		// status is the only progress signal there is.
		if (task.status === "completed") return cells.map(() => "done" as CriterionCell);
		if (task.status === "failed") return cells.map(() => "failed" as CriterionCell);
	}

	// "approved" only means the task may start, so only an in-progress task
	// animates during execution.
	const working = mode === "audit" ? taskUnderVerification(state, task.id) : task.status === "in-progress";
	if (working) {
		const next = cells.indexOf("pending");
		if (next !== -1) cells[next] = "active";
	}
	return cells;
}

function buildCriterionGroups(state: GoalState, mode: "audit" | "exec"): CriterionGroup[] {
	return state.tasks
		.map((task, taskIndex) => ({ taskIndex, cells: criterionCells(task, state, mode) }))
		.filter((group) => group.cells.length > 0);
}

function criterionGlyph(cell: CriterionCell): string {
	if (cell === "active") return CRITERION_ACTIVE_FRAMES[animationTick % CRITERION_ACTIVE_FRAMES.length];
	return CRITERION_GLYPHS[cell];
}

function paintCriterionCells(cells: CriterionCell[], groupIndex: number, style: ReturnType<typeof makeStyleHelpers>): string {
	let out = "";
	let run = "";
	let runFailed = false;
	const flushRun = (): void => {
		if (run.length === 0) return;
		out += runFailed ? style.fg("error", run) : style.paint(groupIndex, run);
		run = "";
	};
	for (const cell of cells) {
		const failed = cell === "failed";
		if (failed !== runFailed) {
			flushRun();
			runFailed = failed;
		}
		run += criterionGlyph(cell);
	}
	flushRun();
	return out;
}

// Lay the groups out left to right, wrapping at width. A group that does not
// fit in the remaining cells moves to the next row whole; only a group longer
// than a full row is split.
function renderCriterionRows(
	groups: CriterionGroup[],
	width: number,
	style: ReturnType<typeof makeStyleHelpers>,
): string[] {
	if (width <= 0 || groups.length === 0) return [];
	const rows: string[] = [];
	let current = "";
	let currentWidth = 0;
	const flush = (): void => {
		if (current.length === 0) return;
		rows.push(current);
		current = "";
		currentWidth = 0;
	};

	for (const group of groups) {
		const size = group.cells.length;
		if (currentWidth > 0 && currentWidth + size > width && size <= width) flush();
		let offset = 0;
		while (offset < size) {
			if (currentWidth >= width) flush();
			const take = Math.min(width - currentWidth, size - offset);
			current += paintCriterionCells(group.cells.slice(offset, offset + take), group.taskIndex, style);
			currentWidth += take;
			offset += take;
			if (offset < size) flush();
		}
	}
	flush();
	return rows;
}

// Legend: which color belongs to which task, plus that task's verified count.
// Without it the colors are decorative.
function renderCriterionLegend(
	groups: CriterionGroup[],
	tasks: TaskState[],
	width: number,
	style: ReturnType<typeof makeStyleHelpers>,
): string {
	if (groups.length === 0) return "";
	const parts = groups.map((group) => {
		const task = tasks[group.taskIndex];
		const done = group.cells.filter((cell) => cell === "done").length;
		const label = truncateToWidth(task.id, 16, "...", false);
		return style.paint(group.taskIndex, `${label} ${done}/${group.cells.length}`);
	});

	let out = "";
	let shown = 0;
	for (const part of parts) {
		const next = out.length > 0 ? `${out}${style.fg("dim", " · ")}${part}` : part;
		// Reserve cells for a "+N" marker when the legend has to drop entries.
		if (visibleWidth(next) + 4 > width) break;
		out = next;
		shown += 1;
	}
	if (out.length === 0) return truncateToWidth(parts[0] ?? "", width, "...", false);
	const hidden = groups.length - shown;
	return hidden > 0 ? `${out}${style.fg("dim", ` +${hidden}`)}` : out;
}

function findActiveAuditTask(state: GoalState): { auditorId: string; task: TaskState } | null {
	const shards = state.audit?.shards;
	if (!shards) return null;
	for (const shard of shards) {
		if (shard.status !== "running") continue;
		const task = state.tasks.find((t) => shard.taskIds.includes(t.id) && !(shard.results || {})[t.id]);
		if (task) return { auditorId: shard.id, task };
	}
	return null;
}

function styleTaskLine(line: string, style: ReturnType<typeof makeStyleHelpers>, currentIndex: number): string {
	// Lines look like: "> >  do the thing" or "   + done"
	const isCurrent = line.trimStart().startsWith(">");
	const trimmed = line.trimStart().replace(/^[> ]\s*/, "");
	const iconMatch = trimmed.match(/^([+x>*o])\s+(.*)$/);
	if (!iconMatch) return line;
	const icon = iconMatch[1];
	const text = iconMatch[2];
	const iconStyled =
		icon === "+"
			? style.fg("success", "+")
			: icon === "x"
				? style.fg("error", "x")
				: icon === ">"
					? style.fg("accent", ">")
					: icon === "*"
						? style.fg("muted", "*")
						: style.fg("dim", "o");
	const textStyled = isCurrent
		? style.bold(style.fg("text", text))
		: icon === "+"
			? style.fg("muted", text)
			: icon === "x"
				? style.fg("error", text)
				: style.fg("text", text);
	// Reattach the leading marker
	const marker = isCurrent ? style.bold(style.fg("accent", ">")) : " ";
	return `${marker} ${iconStyled} ${textStyled}`;
}


// ---------------------------------------------------------------------------
// Plan formatting: full task plan emitted to chat transcript
// ---------------------------------------------------------------------------

function formatPlanMarkdown(params: {
	refinedGoal: string;
	tasks: { id: string; description: string; contract: string; acceptanceCriteria: string[] }[];
}): string {
	const sections: string[] = [];
	sections.push(`## Refined Goal\n${params.refinedGoal}`);
	sections.push(`### Planned Tasks (${params.tasks.length})`);
	for (let i = 0; i < params.tasks.length; i++) {
		const t = params.tasks[i];
		const criteria = t.acceptanceCriteria.map((c) => `  * ${c}`).join("\n");
		sections.push(
			`**${i + 1}. ${t.description}** \`[${t.id}]\`\n` +
			`* **Contract:** ${t.contract}\n` +
			`* **Acceptance Criteria:**\n${criteria}`,
		);
	}
	return sections.join("\n\n");
}

function formatAuditReportMarkdown(
	state: GoalState | null,
	approved: boolean,
	feedback: string,
	failedTasks?: TaskState[],
): string {
	const sections: string[] = [];
	const statusBadge = approved ? "**STATUS: PASSED**" : "**STATUS: REJECTED**";
	sections.push(`## ${statusBadge}\n\n**Auditor Feedback:**\n${feedback}`);

	if (state && state.tasks.length > 0) {
		sections.push(`### Task Verification Summary`);
		for (let i = 0; i < state.tasks.length; i++) {
			const t = state.tasks[i];
			const isDone = t.status === "completed";
			const icon = isDone ? "[PASS]" : "[FAIL]";
			const reason = t.auditResult || t.error || (isDone ? "Verified against acceptance criteria" : "Criteria not met");
			const criteria = taskCriteriaStatus(t);
			const verified = criteria.filter((s) => s === "passed").length;
			const criteriaLabel = criteria.length > 0 ? `\n  * Criteria: ${verified}/${criteria.length} verified` : "";
			const failedCriteria = criteria
				.map((status, index) => ({ status, criterion: t.acceptanceCriteria[index] }))
				.filter((entry) => entry.status === "failed")
				.map((entry) => entry.criterion);
			const failedLabel = failedCriteria.length > 0 ? `\n  * Failed criteria: ${failedCriteria.join("; ")}` : "";
			sections.push(`* **${icon} Task ${i + 1} (${t.id}):** ${t.description}\n  * Detail: ${reason}${criteriaLabel}${failedLabel}`);
		}
	}

	if (!approved && failedTasks && failedTasks.length > 0) {
		sections.push(`### Tasks Requiring Rework`);
		for (const ft of failedTasks) {
			sections.push(`* **${ft.id}:** ${ft.description}\n  * Reason: ${ft.error || ft.auditResult || feedback}`);
		}
	}

	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Plan approval dialog
// The plan must be visible to the user BEFORE they answer the approval prompt.
// pi.sendMessage() during a streaming turn only queues the message into the
// agent's steering queue; it does not render to the transcript until the turn
// settles, which is after this tool has already returned (and after the old
// select dialog would have been answered). So instead of relying on the
// transcript, the approval dialog embeds the FULL plan (scrollable) alongside
// the approval options, plus a custom message is still emitted to the transcript
// for session history and later reference.
// ---------------------------------------------------------------------------

const APPROVAL_OPTIONS: SelectItem[] = [
	{ value: "Yes, proceed", label: "Yes, proceed", description: "Approve the plan and start executing" },
	{ value: "No, revise", label: "No, revise", description: "Reject it and ask for a revised plan" },
	{ value: "I have a comment", label: "I have a comment", description: "Send feedback, then the plan is revised" },
];

/**
 * Modal overlay component: full plan in a scrollable pane on top, the approval
 * options underneath. Rendering is bounded to the terminal: the plan pane shows
 * exactly viewportRows lines, so the overlay never exceeds the terminal and the
 * TUI's maxHeight clipping never eats the options or the hint line.
 */
class PlanApprovalDialog implements Component {
	private readonly planLines: string[];
	private readonly viewportRows: number;
	private readonly showHint: boolean;
	private readonly selectList: SelectList;
	private readonly style: ThemeLike;
	private scrollTop = 0;
	readonly width: number;
	readonly expectedHeight: number;

	constructor(
		planMarkdown: string,
		termCols: number,
		termRows: number,
		style: ThemeLike,
		done: (result: string | null) => void,
	) {
		this.style = style;
		this.width = Math.max(48, Math.min(termCols - 2, Math.round(termCols * 0.9)));
		// The TUI clamps an overlay's maxHeight to termRows - 4 (margin 2 top and
		// bottom). Budget the plan viewport so the dialog's total line count can
		// never exceed that hard cap. Fixed chrome is title + separator above and
		// separator + 3 option rows below = 6 rows, plus 1 row reserved for the
		// scroll indicator and (when there is room) 1 row for the hint. The plan
		// pane shrinks first, so the option list is always visible; on terminals
		// too short for the hint it is dropped rather than clipped.
		const available = Math.max(6, termRows - 4);
		this.showHint = available >= 9;
		const chrome = 6 + (this.showHint ? 1 : 0);
		this.viewportRows = Math.max(1, Math.min(42, available - chrome - 1));
		this.selectList = new SelectList(APPROVAL_OPTIONS, APPROVAL_OPTIONS.length, getSelectListTheme());
		this.selectList.onSelect = (item) => done(item.value);
		this.selectList.onCancel = () => done(null);
		this.planLines = new Markdown(planMarkdown, 1, 0, getMarkdownTheme()).render(this.width);
		// Exact rendered height, never above the TUI's maxHeight clamp:
		// chrome + plan viewport + scroll indicator (only when the plan overflows).
		this.expectedHeight = chrome + this.viewportRows + (this.planLines.length > this.viewportRows ? 1 : 0);
	}

	private get maxScroll(): number {
		return Math.max(0, this.planLines.length - this.viewportRows);
	}

	private get step(): number {
		return Math.max(3, Math.floor(this.viewportRows * 0.6));
	}

	handleInput(data: string): void {
		if (this.maxScroll > 0) {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.pageUp")) {
				this.scrollTop = Math.max(0, this.scrollTop - this.step);
				return;
			}
			if (kb.matches(data, "tui.select.pageDown")) {
				this.scrollTop = Math.min(this.maxScroll, this.scrollTop + this.step);
				return;
			}
		}
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		// SelectList and Markdown manage their own caches; nothing else to clear.
	}

	render(width: number): string[] {
		const style = this.style;
		const inner = Math.min(this.width, Math.max(20, width));
		const pad = (s: string): string => {
			const w = visibleWidth(s);
			return w >= inner ? s : s + " ".repeat(inner - w);
		};
		const hr = style.fg("border", "─".repeat(inner));

		const out: string[] = [];
		out.push(pad(style.bold(style.fg("accent", " Proposed Goal Plan"))));
		out.push(pad(hr));

		const start = this.scrollTop;
		for (let i = start; i < start + this.viewportRows && i < this.planLines.length; i++) {
			out.push(pad(this.planLines[i]));
		}
		if (this.planLines.length > this.viewportRows) {
			const end = Math.min(this.planLines.length, start + this.viewportRows);
			out.push(pad(style.fg("muted", `  (${start + 1}-${end} of ${this.planLines.length} lines · PgUp/PgDn scroll)`)));
		}

		out.push(pad(hr));
		for (const line of this.selectList.render(inner)) {
			out.push(pad(line));
		}
		if (this.showHint) {
			out.push(pad(style.fg("dim", "  ↑↓ choose · PgUp/PgDn scroll plan · Enter select · Esc cancel")));
		}
		return out;
	}
}

/**
 * Show the plan approval prompt. Non-yolo: a full-plan overlay dialog. Yolo:
 * the previous auto-approve select with a short timeout. Returns the chosen
 * option label, or undefined when cancelled.
 */
async function showPlanApproval(
	ctx: ExtensionContext,
	planMarkdown: string,
	yoloActive: boolean,
): Promise<string | undefined> {
	if (yoloActive) {
		const choice = await ctx.ui.select("Goal Plan (auto-approving...)", ["Yes, proceed"], { timeout: 1500 });
		return choice === undefined ? "Yes, proceed" : choice;
	}

	let component: PlanApprovalDialog | undefined;
	const choice = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			const term = (tui as { terminal?: { columns?: number; rows?: number } }).terminal;
			const cols = term?.columns ?? 80;
			const rows = term?.rows ?? 24;
			component = new PlanApprovalDialog(planMarkdown, cols, rows, theme as unknown as ThemeLike, done);
			return component;
		},
		{
			overlay: true,
			overlayOptions: () => ({
				width: component?.width,
				maxHeight: component?.expectedHeight,
				anchor: "center",
				margin: 2,
			}),
		},
	);
	return choice ?? undefined;
}

// ---------------------------------------------------------------------------
// Widget plumbing (state -> component)
// ---------------------------------------------------------------------------

let activeWidgetCtx: ExtensionContext | null = null;
let activeWatcher: fs.FSWatcher | null = null;

// Widget cache: reuse the same Container + Text children across refreshes.
// Text.setText() updates content in-place, so the TUI differential renderer
// only repaints changed cells instead of rebuilding the component tree.
let widgetCache: { container: Container; texts: Text[] } | null = null;

// Clear the live widget and drop the cached Container/Text so a future
// refresh rebuilds from fresh state. Centralized so every clear path
// (audit completion, rejection, fail, stop, delete, clear) stays consistent.
function clearWidget(ctx: ExtensionContext): void {
	stopWidgetAnimation();
	ctx.ui.setWidget("pi-goal", undefined);
	widgetCache = null;
}

// ---------------------------------------------------------------------------
// Animation ticker
// The in-progress criteria cells step through their vertical fill frames, so
// the widget has to be repainted while any cell is animating. The timer runs
// only when a cell is actually in flight, and it re-registers the widget with
// the same cached Container, so a tick is a cheap in-place text update.
// ---------------------------------------------------------------------------

const WIDGET_ANIMATION_MS = 110;
let widgetAnimationTimer: ReturnType<typeof setInterval> | null = null;

function widgetIsAnimating(state: GoalState): boolean {
	if (state.status === "auditing") {
		return buildCriterionGroups(state, "audit").some((group) => group.cells.includes("active"));
	}
	if (state.status === "active") {
		return buildCriterionGroups(state, "exec").some((group) => group.cells.includes("active"));
	}
	return false;
}

function startWidgetAnimation(): void {
	if (widgetAnimationTimer) return;
	widgetAnimationTimer = setInterval(() => {
		animationTick += 1;
		if (activeWidgetCtx) refreshWidget(activeWidgetCtx);
	}, WIDGET_ANIMATION_MS);
	// Do not keep the process alive just for a progress animation.
	(widgetAnimationTimer as { unref?: () => void }).unref?.();
}

function stopWidgetAnimation(): void {
	if (!widgetAnimationTimer) return;
	clearInterval(widgetAnimationTimer);
	widgetAnimationTimer = null;
}

function refreshWidget(ctx: ExtensionContext): void {
	const state = loadState();
	if (!state || state.status === "completed" || state.status === "failed" || state.status === "stopped") {
		stopWidgetAnimation();
		clearWidget(ctx);
		return;
	}
	if (widgetIsAnimating(state)) startWidgetAnimation();
	else stopWidgetAnimation();
	const yoloActive = isYoloActive(ctx);
	ctx.ui.setWidget("pi-goal", (tui, theme) => {
		const term = (tui as { terminal?: { columns?: number; rows?: number } }).terminal;
		const width = term?.columns ?? 80;
		const rows = term?.rows ?? 24;
		const lines = renderWidgetLines(state, width, rows, theme as unknown as ThemeLike | undefined, yoloActive);

		if (widgetCache) {
			const { container, texts } = widgetCache;
			// Cache hit: same line count -> update text in-place.
			if (texts.length === lines.length) {
				for (let i = 0; i < texts.length; i++) texts[i].setText(lines[i]);
				return container;
			}
			// Line count changed -> rebuild children.
			container.clear();
			widgetCache.texts = [];
			for (const line of lines) {
				const t = new Text(line, 0, 0);
				widgetCache.texts.push(t);
				container.addChild(t);
			}
			return container;
		}

		// First build.
		const container = new Container();
		const texts: Text[] = [];
		for (const line of lines) {
			const t = new Text(line, 0, 0);
			texts.push(t);
			container.addChild(t);
		}
		widgetCache = { container, texts };
		return container;
	});
}

function startWatcher(ctx: ExtensionContext): void {
	stopWatcher();
	const dir = getStateDir();
	ensureStateDir();
	try {
		activeWatcher = fs.watch(dir, (eventType, filename) => {
			if (filename && filename.endsWith("state.json")) {
				setTimeout(() => {
					if (activeWidgetCtx) refreshWidget(activeWidgetCtx);
				}, 50);
			}
		});
	} catch {
		// Some platforms reject fs.watch; the widget still refreshes on
		// tool calls and commands that explicitly call refreshWidget.
	}
}

function stopWatcher(): void {
	if (activeWatcher) {
		try {
			activeWatcher.close();
		} catch {}
		activeWatcher = null;
	}
}

// Extension tools and commands can run while the host agent is processing a
// turn. Queue injected work as a follow-up so Pi delivers it only after the
// current run settles instead of trying an unavailable immediate follow-up.
// Command/template expansion is enabled because callers may intentionally
// inject an extension command as well as plain workflow context.
function queueGoalMessage(
	api: ExtensionAPI,
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
): void {
	api.sendUserMessage(content, {
		deliverAs: "followUp",
		expandPromptTemplates: true,
	});
}

// ---------------------------------------------------------------------------
// Audit runner. Splits the task list into per-task shards and runs one
// isolated auditor per shard in parallel, each inside its own git worktree.
// Thinking tokens, tool calls, per-task verdicts and the final shard verdict
// all stream into state.auditLog / state.audit so the widget updates live.
// ---------------------------------------------------------------------------

const AUDITOR_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Collect the local AGENTS.md context files visible from the goal project's
// cwd, mirroring pi's own context-file discovery but restricted to the exact
// literal filename "AGENTS.md" (no CLAUDE.md, no AGENTS.override.md variants)
// and without pi's project-trust gating. Walks from cwd up to the filesystem
// root, dedupes by canonical path, and returns files root-first (outermost
// ancestor first, cwd last), matching pi's concatenation order. Each entry
// holds the file's path and its utf-8 content with any BOM stripped.
function findProjectAGENTS(cwd: string): Array<{ path: string; content: string }> {
	const found: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();
	let dir = cwd;
	while (true) {
		const filePath = path.join(dir, "AGENTS.md");
		if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			const canonical = fs.realpathSync(filePath);
			if (!seen.has(canonical)) {
				seen.add(canonical);
				const content = fs.readFileSync(filePath, "utf-8");
				found.push({ path: filePath, content: content.startsWith("\uFEFF") ? content.slice(1) : content });
			}
		}
		const parentDir = path.dirname(dir);
		if (parentDir === dir) break;
		dir = parentDir;
	}
	return found.reverse();
}

let auditInFlight: Promise<{ approved: boolean; feedback: string } | null> | null = null;
let auditFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Abort handles for the live auditor sessions. Stopping, pausing, failing or
// deleting a goal during an audit should not leave N model sessions running.
const activeAuditorAborts = new Set<() => void>();

function abortActiveAuditors(): void {
	for (const abort of activeAuditorAborts) {
		try {
			abort();
		} catch {}
	}
	activeAuditorAborts.clear();
}

// Thinking deltas arrive token by token for every auditor. Buffer them per
// auditor and persist each growing line on a short shared timer, so N
// concurrent auditors do not clobber each other's live thought line.
const thinkingBuffers = new Map<string, string>();
const thinkingLineIndex = new Map<string, number>();

function sanitizeLogLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ");
}

// The audit log is live activity only (the widget shows the tail, the final
// report is built from state.tasks). Cap it so a long parallel audit cannot
// grow state.json without bound. Indices used to update in-place thinking
// lines are shifted by the number of dropped entries.
const MAX_AUDIT_LOG_LINES = 500;

function trimAuditLog(state: GoalState): void {
	const log = state.auditLog || [];
	const overflow = log.length - MAX_AUDIT_LOG_LINES;
	if (overflow <= 0) return;
	state.auditLog = log.slice(overflow);
	for (const [id, index] of thinkingLineIndex) {
		const shifted = index - overflow;
		if (shifted >= 0) thinkingLineIndex.set(id, shifted);
		else thinkingLineIndex.delete(id);
	}
}

function appendAuditLog(lines: string[], auditorId?: string): void {
	const state = loadState();
	if (!state || state.status !== "auditing") return;
	const prefix = auditorId ? `[${auditorId}] ` : "";
	state.auditLog = [...(state.auditLog || []), ...lines.map((line) => prefix + sanitizeLogLine(line))];
	trimAuditLog(state);
	saveState(state);
}

function scheduleAuditThinkingFlush(auditorId: string, text: string): void {
	thinkingBuffers.set(auditorId, text);
	if (auditFlushTimer) return;
	auditFlushTimer = setTimeout(() => {
		auditFlushTimer = null;
		const state = loadState();
		if (!state || state.status !== "auditing") {
			thinkingBuffers.clear();
			thinkingLineIndex.clear();
			return;
		}
		for (const [id, raw] of thinkingBuffers) {
			const line = `[${id}] thinking: ${sanitizeLogLine(raw.trim())}`;
			const index = thinkingLineIndex.get(id);
			if (index !== undefined && state.auditLog[index]?.startsWith(`[${id}] thinking: `)) {
				state.auditLog[index] = line;
			} else {
				state.auditLog.push(line);
				thinkingLineIndex.set(id, state.auditLog.length - 1);
			}
		}
		trimAuditLog(state);
		thinkingBuffers.clear();
		saveState(state);
		if (activeWidgetCtx) refreshWidget(activeWidgetCtx);
	}, 100);
}

function auditLogError(message: string): void {
	const state = loadState();
	if (!state || state.status !== "auditing") return;
	state.auditLog = [...(state.auditLog || []), sanitizeLogLine(message)];
	state.auditFeedback = sanitizeLogLine(message).replace(/^[+x]\s*/, "");
	saveState(state);
}

function updateShardState(auditorId: string, patch: Partial<AuditShardState>): void {
	const state = loadState();
	if (!state?.audit) return;
	const shard = state.audit.shards.find((s) => s.id === auditorId);
	if (!shard) return;
	Object.assign(shard, patch);
	saveState(state);
}

function recordShardTask(auditorId: string, taskId: string, passed: boolean, reason: string | null): void {
	const state = loadState();
	if (!state?.audit) return;
	const shard = state.audit.shards.find((s) => s.id === auditorId);
	if (!shard) return;
	shard.results = { ...(shard.results || {}), [taskId]: { passed, reason } };
	shard.verified = Object.keys(shard.results).length;
	saveState(state);
}

// Persist one criterion verdict. Returns the criterion's text and the task's
// running count so the tool can answer with something the auditor can check
// against what it just verified.
function recordCriterion(
	taskId: string,
	index: number,
	passed: boolean,
): { ok: true; task: TaskState; criterion: string; done: number; total: number } | { ok: false; error: string } {
	const state = loadState();
	if (!state) return { ok: false, error: "No goal state found." };
	const task = state.tasks.find((t) => t.id === taskId);
	if (!task) {
		return { ok: false, error: `Task "${taskId}" not found. Available tasks: ${state.tasks.map((t) => t.id).join(", ")}` };
	}
	const total = task.acceptanceCriteria.length;
	if (!Number.isInteger(index) || index < 1 || index > total) {
		const list = task.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
		return {
			ok: false,
			error: `Criterion index ${index} is out of range for ${taskId} (1-${total}). Criteria:\n${list}`,
		};
	}
	const statuses = taskCriteriaStatus(task);
	statuses[index - 1] = passed ? "passed" : "failed";
	task.criteriaStatus = statuses;
	saveState(state);
	return {
		ok: true,
		task,
		criterion: task.acceptanceCriteria[index - 1],
		done: statuses.filter((s) => s === "passed" || s === "failed").length,
		total,
	};
}

function recordShardVerdict(
	auditorId: string,
	verdict: { approved: boolean; feedback: string; failedTasks: { id: string; reason: string }[] },
): void {
	const state = loadState();
	if (!state?.audit) return;
	const shard = state.audit.shards.find((s) => s.id === auditorId);
	if (!shard) return;
	shard.status = "verdict";
	shard.approved = verdict.approved;
	shard.feedback = verdict.feedback;
	shard.failedTasks = verdict.failedTasks;
	// The shard is fully processed once a verdict lands, even if the auditor
	// skipped a per-task record. Keep the progress track honest.
	shard.verified = shard.taskIds.length;
	saveState(state);
}

// Apply the auditor verdict to persisted state. Shared by the AUDITOR-ONLY
// goal_audit_result tool (external caller) and the parallel audit coordinator.
function applyAuditVerdict(params: { approved: boolean; feedback: string; failedTasks?: { id: string; reason: string }[] }): {
	approved: boolean;
	failedTaskCount: number;
} {
	const state = loadState();
	if (!state) {
		return { approved: params.approved, failedTaskCount: 0 };
	}

	state.auditFeedback = params.feedback;

	if (params.approved) {
		state.status = "completed";
		state.tasks = state.tasks.map((t) => ({
			...t,
			status: "completed" as const,
			auditResult: params.feedback,
		}));
		state.auditLog = [
			...(state.auditLog || []),
			"  ok goal_audit_result",
			"auditor finished",
			`PASSED: ${sanitizeLogLine(params.feedback)}`,
		];
		saveState(state);
		return { approved: true, failedTaskCount: 0 };
	}

	const failedIds = new Set((params.failedTasks || []).map((t) => t.id));
	const failedReasons = new Map((params.failedTasks || []).map((t) => [t.id, t.reason] as const));
	state.status = "active";
	state.tasks = state.tasks.map((t) => {
		if (failedIds.has(t.id)) {
			return {
				...t,
				status: "pending" as const,
				auditResult: failedReasons.get(t.id) || params.feedback,
				error: failedReasons.get(t.id) || null,
			};
		}
		return { ...t, status: "completed" as const, auditResult: params.feedback };
	});
	state.auditLog = [
		...(state.auditLog || []),
		"  ok goal_audit_result",
		"auditor finished",
		`REJECTED: ${sanitizeLogLine(params.feedback)}`,
	];
	for (const ft of params.failedTasks || []) {
		state.auditLog.push(`  - ${ft.id}: ${sanitizeLogLine(ft.reason)}`);
	}
	saveState(state);
	return { approved: false, failedTaskCount: failedIds.size };
}

function summarizeArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	try {
		if (toolName === "read" || toolName === "bash") {
			const v = a.path ?? a.command;
			if (typeof v === "string") return v.split(/\s+/).join(" ").slice(0, 80);
		}
		if (toolName === "write" || toolName === "edit") {
			const v = a.path;
			if (typeof v === "string") return v;
		}
		const first = Object.values(a).find((v) => typeof v === "string");
		if (typeof first === "string") return first.slice(0, 80);
	} catch {
		// fall through
	}
	return "";
}

function summarizeResult(result: unknown): string {
	if (result === null || result === undefined) return "";
	try {
		if (typeof result === "string") return result.replace(/\s+/g, " ").trim().slice(0, 100);
		if (typeof result === "object") {
			const text = (result as { text?: string }).text;
			if (typeof text === "string") return text.replace(/\s+/g, " ").trim().slice(0, 100);
		}
	} catch {
		// fall through
	}
	return "";
}

interface AuditAssignment {
	auditorId: string;
	total: number;
	tasks: TaskState[];
	worktree: string | null;
	statePath: string;
}

function buildAuditorSystemPrompt(state: GoalState, projectCwd: string, assignment: AuditAssignment): string {
	const tasks = assignment.tasks
		.map((t, i) => {
			const criteria = t.acceptanceCriteria.map((c, index) => `      ${index + 1}. ${c}`).join("\n");
			return `  ${i + 1}. ${t.id}: ${t.description}\n     contract: ${t.contract}\n     acceptance criteria:\n${criteria}`;
		})
		.join("\n\n");

	const worktreeNote = assignment.worktree
		? `You are working in an isolated git worktree at ${assignment.worktree}. It contains the project's current working-tree state (HEAD plus the executor's uncommitted changes). Run builds and tests here. Do not read or write any other worktree.`
		: "You are working in the project's main working tree. Other auditors may be running concurrently, so avoid destructive commands.";
	const assignmentText = [
		`You are ${assignment.auditorId} of ${assignment.total} auditors running in parallel.`,
		`You verify ONLY the ${assignment.tasks.length} task(s) listed below. Other auditors verify the remaining tasks.`,
		"Your approval alone does NOT complete the goal. The coordinator merges every auditor's verdict.",
		worktreeNote,
	].join("\n");

	const prompt = AUDITOR_SYSTEM_PROMPT_TEMPLATE
		.replaceAll("__STATEPATH__", assignment.statePath)
		.replace("__GOAL__", state.refinedGoal || state.goal)
		.replace("__RESULT__", state.result || "(none provided)")
		.replace("__ASSIGNMENT__", assignmentText)
		.replace("__TASKS__", tasks);

	// Fold the project's local AGENTS.md files into the auditor system prompt
	// as a single trailing section. The auditor session is fully isolated
	// (noContextFiles: true), so the content must travel inside this prompt
	// string; there is nothing to append when no AGENTS.md exists.
	const agentsFiles = findProjectAGENTS(projectCwd);
	if (agentsFiles.length === 0) return prompt;
	const content = agentsFiles.map((f) => f.content.trimEnd()).join("\n\n");
	return `${prompt}\n\n<system>\n${content}\n</system>`;
}

// ---------------------------------------------------------------------------
// Git worktree isolation
// ---------------------------------------------------------------------------

function runGit(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf-8",
		input,
		stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
		maxBuffer: 128 * 1024 * 1024,
	});
}

interface AuditWorktree {
	dir: string;
	cleanup: () => void;
}

// Create a detached worktree at HEAD, then overlay the executor's uncommitted
// work (tracked diff plus untracked, non-ignored files) so the auditor sees
// exactly what was delivered rather than a stale commit. Heavy dependency
// directories are symlinked from the main tree so tests can run without a
// fresh install in every worktree. Returns null when the project is not a git
// repository (or the worktree cannot be prepared), in which case the caller
// falls back to the shared working tree.
// Cheap preflight used by the coordinator: can this project host worktrees at
// all? When it cannot, parallel auditors would share one working tree and
// collide on builds, locks and test ports, so the coordinator drops to one
// auditor at a time.
function canIsolateWithWorktrees(projectCwd: string): boolean {
	try {
		const repoRoot = runGit(projectCwd, ["rev-parse", "--show-toplevel"]).trim();
		if (!repoRoot) return false;
		runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

function createAuditWorktree(projectCwd: string, shardId: string, cfg: AuditConfig): AuditWorktree | null {
	if (!cfg.worktree) return null;

	let repoRoot: string;
	try {
		repoRoot = runGit(projectCwd, ["rev-parse", "--show-toplevel"]).trim();
		runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		return null;
	}
	if (!repoRoot) return null;

	// Include the pid so two pi processes auditing the same repository do not
	// fight over (and delete) each other's worktree paths.
	const dir = path.join(repoRoot, ".pi", "goal", "audit", `${shardId}-${process.pid}`);
	const cleanup = (): void => {
		// Remove linked dependency directories first so a recursive delete can
		// never wander into the main tree through a symlink.
		for (const name of cfg.linkPaths) {
			try {
				const linked = path.join(dir, name);
				if (fs.lstatSync(linked).isSymbolicLink()) fs.unlinkSync(linked);
			} catch {}
		}
		try {
			runGit(repoRoot, ["worktree", "remove", "--force", dir]);
		} catch {}
		try {
			runGit(repoRoot, ["worktree", "prune"]);
		} catch {}
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	};

	try {
		try {
			runGit(repoRoot, ["worktree", "prune"]);
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		runGit(repoRoot, ["worktree", "add", "--detach", "--force", dir, "HEAD"]);

		// Tracked but uncommitted changes (staged and unstaged).
		const patch = runGit(repoRoot, ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff"]);
		if (patch.trim().length > 0) {
			runGit(dir, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
		}

		// Untracked, non-ignored files the executor created. Skip the pi state
		// directory and anything unreasonably large.
		const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
		for (const rel of untracked.split("\0")) {
			if (!rel) continue;
			if (rel === ".pi" || rel.startsWith(".pi/") || rel === ".git" || rel.startsWith(".git/")) continue;
			const src = path.join(repoRoot, rel);
			const dst = path.join(dir, rel);
			try {
				const stat = fs.statSync(src);
				if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
				fs.mkdirSync(path.dirname(dst), { recursive: true });
				fs.copyFileSync(src, dst);
			} catch {
				// A file can disappear between listing and copying; ignore it.
			}
		}

		// Link dependency directories (node_modules, .venv, ...) so test and
		// build commands resolve without reinstalling in every worktree.
		for (const name of cfg.linkPaths) {
			const src = path.join(repoRoot, name);
			const dst = path.join(dir, name);
			try {
				if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
				const isDir = fs.statSync(src).isDirectory();
				fs.symlinkSync(src, dst, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file");
			} catch {}
		}
	} catch {
		cleanup();
		return null;
	}

	return { dir, cleanup };
}

// ---------------------------------------------------------------------------
// Sharding and concurrency
// ---------------------------------------------------------------------------

// Round-robin distribution keeps shard sizes balanced regardless of task
// count. Each task is verified by exactly one auditor.
function shardTasks(tasks: TaskState[], auditorCount: number): TaskState[][] {
	if (tasks.length === 0) return [];
	const count = Math.max(1, Math.min(auditorCount, tasks.length));
	const shards: TaskState[][] = Array.from({ length: count }, () => []);
	tasks.forEach((task, index) => shards[index % count].push(task));
	return shards;
}

async function runWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

// ---------------------------------------------------------------------------
// Per-auditor tools
// ---------------------------------------------------------------------------

interface ShardSink {
	results: Map<string, { passed: boolean; reason: string | null }>;
	verdict: { approved: boolean; feedback: string; failedTasks: { id: string; reason: string }[] } | null;
}

// Record the verdict for a single task. Called by the auditor after verifying
// each assigned task, which is what drives the per-shard progress track. The
// per-criterion detail comes from goal_audit_criterion, which the auditor calls
// as it works.
function makeAuditTaskTool(auditorId: string, allowedTaskIds: Set<string>, sink: ShardSink) {
	return defineTool({
		name: "goal_audit_task",
		label: `Record task verdict (${auditorId})`,
		description: `AUDITOR-ONLY (${auditorId}). Record the verdict for ONE assigned task after verifying its acceptance criteria (recording each one with goal_audit_criterion as you go). Call this once per assigned task, before submitting the shard verdict.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The id of the assigned task" }),
			passed: Type.Boolean({ description: "True if every acceptance criterion of this task is met" }),
			reason: Type.Optional(Type.String({ description: "Why the task passed or failed" })),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params) {
			if (!allowedTaskIds.has(params.taskId)) {
				return {
					content: [
						{
							type: "text",
							text: `Task ${params.taskId} is not assigned to ${auditorId}. Assigned tasks: ${[...allowedTaskIds].join(", ")}`,
						},
					],
					details: { error: "not_assigned" as string | null, taskId: params.taskId, passed: false },
				};
			}
			const reason = params.reason ?? null;
			sink.results.set(params.taskId, { passed: params.passed, reason });
			recordShardTask(auditorId, params.taskId, params.passed, reason);
			appendAuditLog(
				[`${params.passed ? "PASS" : "FAIL"} ${params.taskId}${reason ? `: ${reason}` : ""}`],
				auditorId,
			);
			return {
				content: [
					{
						type: "text",
						text: `Recorded ${params.passed ? "PASS" : "FAIL"} for ${params.taskId}. Continue with the next assigned task.`,
					},
				],
				details: { error: null as string | null, taskId: params.taskId, passed: params.passed },
			};
		},
	});
}

// Record one acceptance criterion. This is the granular signal behind the
// criteria bar: the auditor calls it as it verifies, so the bar fills cell by
// cell instead of jumping a whole task at a time.
function makeAuditCriterionTool(auditorId: string, allowedTaskIds: Set<string>) {
	return defineTool({
		name: "goal_audit_criterion",
		label: `Record criterion verdict (${auditorId})`,
		description: `AUDITOR-ONLY (${auditorId}). Record the verdict for ONE acceptance criterion of an assigned task, immediately after you check it. index is the 1-based position of the criterion in that task's acceptance-criteria list. Call this once per criterion as you verify it, never as a batch at the end, so the user sees the progress bar advance while you work.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The id of the assigned task" }),
			index: Type.Integer({ minimum: 1, description: "1-based position of the acceptance criterion inside that task" }),
			passed: Type.Boolean({ description: "True if this criterion is met, false if it is not" }),
			reason: Type.Optional(Type.String({ description: "Short evidence for the verdict on this criterion" })),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params) {
			if (!allowedTaskIds.has(params.taskId)) {
				return {
					content: [
						{
							type: "text",
							text: `Task ${params.taskId} is not assigned to ${auditorId}. Assigned tasks: ${[...allowedTaskIds].join(", ")}`,
						},
					],
					details: { error: "not_assigned" as string | null, taskId: params.taskId, index: params.index },
				};
			}

			const recorded = recordCriterion(params.taskId, params.index, params.passed);
			if (!recorded.ok) {
				return {
					content: [{ type: "text", text: recorded.error }],
					details: { error: "bad_criterion" as string | null, taskId: params.taskId, index: params.index },
				};
			}

			const marker = params.passed ? "PASS" : "FAIL";
			appendAuditLog(
				[
					`${marker} ${params.taskId} criterion ${params.index}/${recorded.total} (${recorded.done}/${recorded.total}): ${sanitizeLogLine(recorded.criterion).slice(0, 80)}`,
				],
				auditorId,
			);
			if (activeWidgetCtx) refreshWidget(activeWidgetCtx);

			return {
				content: [
					{
						type: "text",
						text: `Recorded ${marker} for ${params.taskId} criterion ${params.index}/${recorded.total} (${recorded.done}/${recorded.total} criteria recorded). Continue with the next criterion.`,
					},
				],
				details: {
					error: null as string | null,
					taskId: params.taskId,
					index: params.index,
					passed: params.passed,
					done: recorded.done,
					total: recorded.total,
				},
			};
		},
	});
}

// Submit the shard-level verdict. It does not finalize the goal; the
// coordinator merges every shard's verdict afterwards.
function makeAuditVerdictTool(auditorId: string, allowedTaskIds: Set<string>, sink: ShardSink) {
	return defineTool({
		name: "goal_audit_result",
		label: `Submit audit result (${auditorId})`,
		description: `AUDITOR-ONLY (${auditorId}). Submit the verdict for the tasks assigned to ${auditorId}. The coordinator merges all auditor verdicts. Do not assume your approval completes the goal.`,
		parameters: Type.Object({
			approved: Type.Boolean({
				description: "True if every acceptance criterion of every task assigned to you is met",
			}),
			feedback: Type.String({ description: "The auditor's verdict and reasoning" }),
			failedTasks: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						reason: Type.String(),
					}),
					{ description: "Assigned tasks that did not meet their acceptance criteria (only when approved=false)" },
				),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params) {
			const failedTasks = (params.failedTasks || []).filter((t) => allowedTaskIds.has(t.id));
			// Fold in per-task failures the auditor already recorded, even if
			// it forgot to repeat them in failedTasks.
			for (const [id, result] of sink.results) {
				if (!result.passed && !failedTasks.some((t) => t.id === id)) {
					failedTasks.push({ id, reason: result.reason || params.feedback });
				}
			}
			// A shard-level rejection without any named failure fails the
			// whole shard; this keeps the coordinator conservative.
			if (!params.approved && failedTasks.length === 0) {
				for (const id of allowedTaskIds) failedTasks.push({ id, reason: params.feedback });
			}
			const approved = params.approved && failedTasks.length === 0;
			sink.verdict = { approved, feedback: params.feedback, failedTasks };
			recordShardVerdict(auditorId, { approved, feedback: params.feedback, failedTasks });
			appendAuditLog([`verdict: ${approved ? "PASS" : "FAIL"}`], auditorId);
			return {
				content: [
					{
						type: "text",
						text: `Verdict recorded for ${auditorId}. The coordinator merges all auditor verdicts; do not assume the goal is complete.`,
					},
				],
				details: { approved, failedTaskCount: failedTasks.length },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// One auditor session
// ---------------------------------------------------------------------------

async function runOneAuditor(args: {
	auditorId: string;
	totalAuditors: number;
	shardTasks: TaskState[];
	sink: ShardSink;
	modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
	ctx: ExtensionContext;
	cfg: AuditConfig;
}): Promise<void> {
	const { auditorId, totalAuditors, shardTasks: tasks, sink, modelRuntime, ctx, cfg } = args;
	const allowedTaskIds = new Set(tasks.map((t) => t.id));
	const worktree = createAuditWorktree(ctx.cwd, auditorId, cfg);
	const sessionCwd = worktree?.dir ?? ctx.cwd;

	updateShardState(auditorId, { status: "running", worktree: worktree?.dir ?? null });
	appendAuditLog(
		[
			`started: ${tasks.length} task(s)${worktree ? ` in ${path.relative(ctx.cwd, worktree.dir)}` : " in the shared working tree"}`,
		],
		auditorId,
	);
	if (cfg.worktree && !worktree) {
		appendAuditLog(["worktree unavailable; using the shared working tree"], auditorId);
	}

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let abortSession: (() => void) | undefined;
	let unsubscribe: () => void = () => {};
	let timedOut = false;

	try {
		const prompt = buildAuditorSystemPrompt(loadState() || ({} as GoalState), ctx.cwd, {
			auditorId,
			total: totalAuditors,
			tasks,
			worktree: worktree?.dir ?? null,
			statePath: getStatePath(),
		});

		const loader = new DefaultResourceLoader({
			cwd: sessionCwd,
			agentDir: getAgentDir(),
			systemPrompt: prompt,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const created = await createAgentSession({
			modelRuntime,
			cwd: sessionCwd,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(sessionCwd),
			model: ctx.model,
			thinkingLevel: cfg.thinkingLevel,
			tools: [...AUDITOR_TOOLS, "goal_audit_criterion", "goal_audit_task", "goal_audit_result"],
			customTools: [
				makeAuditCriterionTool(auditorId, allowedTaskIds),
				makeAuditTaskTool(auditorId, allowedTaskIds, sink),
				makeAuditVerdictTool(auditorId, allowedTaskIds, sink),
			],
		});
		session = created.session;
		abortSession = (): void => {
			void session?.abort();
		};
		activeAuditorAborts.add(abortSession);

		let thinkingBuf = "";
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update") {
				const ev = event.assistantMessageEvent;
				if (ev.type === "thinking_delta") {
					thinkingBuf += ev.delta;
					scheduleAuditThinkingFlush(auditorId, thinkingBuf);
					return;
				}
				if (ev.type === "thinking_end") {
					thinkingBuf = "";
				}
				return;
			}

			if (event.type === "tool_execution_start") {
				const arg = summarizeArgs(event.toolName, event.args);
				appendAuditLog([`tool: ${event.toolName}${arg ? ` ${arg}` : ""}`], auditorId);
				return;
			}

			if (event.type === "tool_execution_end") {
				const summary = summarizeResult(event.result);
				const marker = event.isError ? "FAIL" : "ok";
				appendAuditLog([`  ${marker} ${event.toolName}${summary ? ` -> ${summary}` : ""}`], auditorId);
				if (event.toolName === "goal_audit_result" && !event.isError) {
					// The verdict tool already recorded the shard result, so
					// generation is done; stop token generation before any
					// follow-up turn. A failed verdict call is left alone.
					void session?.abort();
				}
				return;
			}

			if (event.type === "agent_end") {
				appendAuditLog(["turn ended"], auditorId);
			}
		});

		const timer = setTimeout(() => {
			timedOut = true;
			appendAuditLog([`timed out after ${Math.round(cfg.timeoutMs / 1000)}s`], auditorId);
			void session?.abort();
		}, cfg.timeoutMs);

		try {
			await session.prompt(
				`You are ${auditorId}. Read your assignment, verify every assigned task, record each acceptance criterion with goal_audit_criterion as you verify it, record each finished task with goal_audit_task, then submit your shard verdict with goal_audit_result.`,
			);

			let followUps = 0;
			while (!sink.verdict && !timedOut && followUps < 2) {
				followUps += 1;
				appendAuditLog([`no verdict yet; following up (${followUps}/2)`], auditorId);
				await session.prompt(
					"You have not submitted your shard verdict. Record any remaining criterion with goal_audit_criterion, record any remaining assigned task with goal_audit_task, then call goal_audit_result exactly once with approved (boolean), feedback (string), and on rejection the failedTasks (id and reason). Do not end your turn before calling it.",
				);
			}
		} finally {
			clearTimeout(timer);
		}

		if (!sink.verdict) {
			updateShardState(auditorId, { status: "error" });
			appendAuditLog(["finished without a verdict"], auditorId);
		}
	} catch (err) {
		// A verdict recorded before the abort still counts; only a shard that
		// never produced one is marked as errored.
		if (!sink.verdict) {
			updateShardState(auditorId, { status: "error" });
			appendAuditLog([`FAILED: ${(err as Error).message}`], auditorId);
		}
	} finally {
		if (abortSession) activeAuditorAborts.delete(abortSession);
		try {
			unsubscribe();
		} catch {}
		try {
			session?.dispose();
		} catch {}
		worktree?.cleanup();
		updateShardState(auditorId, { worktree: null });
	}
}

// ---------------------------------------------------------------------------
// Parallel audit coordinator
// ---------------------------------------------------------------------------

function runAudit(ctx: ExtensionContext, _api: ExtensionAPI): Promise<{ approved: boolean; feedback: string } | null> {
	if (auditInFlight) return auditInFlight;

	auditInFlight = (async () => {
		const state = loadState();
		if (!state || state.status !== "auditing") return null;

		const cfg = loadAuditConfig();

		// Every audit round starts from a clean criteria bar: stale verdicts from
		// a previous round must not make a task look verified before this round's
		// auditor has actually looked at it.
		state.tasks = state.tasks.map((task) => ({ ...task, criteriaStatus: pendingCriteria(task.acceptanceCriteria.length) }));

		const shards = shardTasks(state.tasks, cfg.auditors);
		const sinks: ShardSink[] = shards.map(() => ({ results: new Map(), verdict: null }));

		const worktreeFallback = cfg.worktree && !canIsolateWithWorktrees(ctx.cwd);
		if (worktreeFallback) cfg.maxConcurrency = 1;

		state.audit = {
			startedAt: Date.now(),
			finishedAt: null,
			strategy: "per-task",
			auditors: shards.length,
			shards: shards.map((tasks, index) => ({
				id: `A${index + 1}`,
				taskIds: tasks.map((t) => t.id),
				status: "queued",
				worktree: null,
				verified: 0,
				approved: null,
				feedback: null,
				failedTasks: [],
				results: {},
			})),
		};
		state.auditLog = [
			`Dispatching ${shards.length} auditor(s) across ${state.tasks.length} task(s) with concurrency ${Math.min(cfg.maxConcurrency, Math.max(1, shards.length))}.`,
			...(worktreeFallback
				? ["git worktree isolation unavailable; running auditors one at a time in the shared working tree."]
				: []),
		];
		saveState(state);
		refreshWidget(ctx);

		let modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
		try {
			modelRuntime = await ModelRuntime.create();
		} catch (err) {
			auditLogError(`FAILED: could not initialize model runtime: ${(err as Error).message}`);
			throw err;
		}

		try {
			await runWithConcurrency(shards, cfg.maxConcurrency, async (tasks, index) => {
				await runOneAuditor({
					auditorId: `A${index + 1}`,
					totalAuditors: shards.length,
					shardTasks: tasks,
					sink: sinks[index],
					modelRuntime,
					ctx,
					cfg,
				});
			});
		} finally {
			thinkingBuffers.clear();
			thinkingLineIndex.clear();
		}

		// The goal may have been stopped, paused, failed or deleted while the
		// auditors were running. In that case their verdicts must not resurrect
		// or complete it.
		const afterRun = loadState();
		if (!afterRun || afterRun.status !== "auditing") {
			return null;
		}

		// Merge shard verdicts. A task fails if its auditor rejected it or if
		// the auditor never produced a verdict (timeout, crash, abort).
		const failedTasks: { id: string; reason: string }[] = [];
		const feedbackParts: string[] = [];
		for (let index = 0; index < shards.length; index++) {
			const auditorId = `A${index + 1}`;
			const verdict = sinks[index].verdict;
			if (!verdict) {
				for (const task of shards[index]) {
					failedTasks.push({ id: task.id, reason: `${auditorId} produced no verdict (timeout or error).` });
				}
				feedbackParts.push(`${auditorId} [${shards[index].map((t) => t.id).join(", ")}]: NO VERDICT`);
				updateShardState(auditorId, { status: "error" });
				continue;
			}
			failedTasks.push(...verdict.failedTasks);
			feedbackParts.push(
				`${auditorId} [${shards[index].map((t) => t.id).join(", ")}]: ${verdict.approved ? "PASS" : "FAIL"} - ${verdict.feedback}`,
			);
		}

		const approved = failedTasks.length === 0;
		const feedback = approved
			? `All ${state.tasks.length} task(s) verified by ${shards.length} auditor(s) in parallel.\n\n${feedbackParts.join("\n\n")}`
			: feedbackParts.join("\n\n");

		applyAuditVerdict({ approved, feedback, failedTasks });

		const finalState = loadState();
		if (finalState) {
			// Carry the per-task reasons into the report so every task shows the
			// evidence its own auditor produced, not just the merged blob.
			const perTask = new Map<string, string>();
			for (const sink of sinks) {
				for (const [id, result] of sink.results) {
					if (result.reason) perTask.set(id, result.reason);
					else if (result.passed) perTask.set(id, "Verified against acceptance criteria");
					// A failure without a reason keeps the verdict's failure reason.
				}
			}
			if (perTask.size > 0) {
				finalState.tasks = finalState.tasks.map((task) =>
					perTask.has(task.id) ? { ...task, auditResult: perTask.get(task.id)! } : task,
				);
			}
			if (finalState.audit) {
				finalState.audit.finishedAt = Date.now();
			}
			saveState(finalState);
		}
		if (activeWidgetCtx) refreshWidget(activeWidgetCtx);

		return { approved, feedback };
	})().finally(() => {
		auditInFlight = null;
		thinkingBuffers.clear();
		thinkingLineIndex.clear();
	});

	return auditInFlight!;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Wire the beep helper to the inter-extension event bus. Set here (not at
	// module scope) because this is where the ExtensionAPI is first available.
	piEvents = pi.events;

	// -----------------------------------------------------------------------
	// Custom message renderers
	// -----------------------------------------------------------------------

	pi.registerMessageRenderer("goal_plan", (message, _options, theme) => {
		const container = new Container();
		container.addChild(new Spacer(1));
		const header = theme.bold(theme.fg("accent", "Proposed Goal Plan"));
		container.addChild(new Text(header, 1, 0));
		container.addChild(new Spacer(1));

		let text = "";
		if (typeof message.content === "string") {
			text = message.content;
		} else if (Array.isArray(message.content)) {
			text = message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}
		container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
		container.addChild(new Spacer(1));
		return container;
	});

	pi.registerMessageRenderer("goal_audit_report", (message, _options, theme) => {
		const container = new Container();
		container.addChild(new Spacer(1));
		const details = (message.details ?? {}) as { approved?: boolean };
		const isApproved = details.approved === true;
		const titleColor = isApproved ? "success" : "warning";
		const titleText = isApproved ? "Goal Audit Report (PASSED)" : "Goal Audit Report (REJECTED)";
		const header = theme.bold(theme.fg(titleColor, titleText));
		container.addChild(new Text(header, 1, 0));
		container.addChild(new Spacer(1));

		let text = "";
		if (typeof message.content === "string") {
			text = message.content;
		} else if (Array.isArray(message.content)) {
			text = message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}
		container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
		container.addChild(new Spacer(1));
		return container;
	});

	// -----------------------------------------------------------------------
	// Lifecycle: restore widget on session start
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		activeWidgetCtx = ctx;
		startWatcher(ctx);
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopWatcher();
		stopWidgetAnimation();
		activeWidgetCtx = null;
	});

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "goal_ask",
		label: "Ask about goal",
		description:
			"Ask the user a clarifying question. Choose the question type with this decision framework: radio_answers when the user picks exactly one from a small enumerable set (provide options), multiple_answers when several independent choices are all valid, open_ended when the answers are unbounded or unknown. Options lists automatically include \"Others (custom answer)\" as an escape hatch. The recommended option for radio_answers (the \"recommended\" param, or the first option when omitted) is moved to the front, marked with a \"*\" prefix, and pre-selected as the default in the UI.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			type: Type.Optional(
				Type.Union(
					[
						Type.Literal("open_ended"),
						Type.Literal("multiple_answers"),
						Type.Literal("radio_answers"),
					],
					{ default: "open_ended", description: "How to present the question" },
				),
			),
			options: Type.Optional(
				Type.Array(Type.String(), { description: "Options for radio_answers and multiple_answers" }),
			),
			recommended: Type.Optional(
				Type.String({ description: "Recommended option for radio_answers. It is moved to the front and pre-selected. If not set or not one of the options, the first option is used." }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Cannot ask: not in interactive mode" }],
					details: { question: params.question, type: params.type || "open_ended", answer: null },
				};
			}

			const type = params.type || "open_ended";
			const question = params.question;
			const options = params.options || [];

			let answer: string | string[] | null = null;

			if (type === "radio_answers") {
				if (options.length === 0) {
					return {
						content: [{ type: "text", text: "radio_answers requires non-empty options array." }],
						details: { question, type, answer: null },
					};
				}
				const recommended =
					params.recommended && options.includes(params.recommended) ? params.recommended : options[0];
				// The stock ui.select starts its cursor on the first entry, so the
				// recommended answer has to live at index 0 to be the default
				// selection. Normalize the order up front: recommended first, the
				// rest in their original relative order. This also keeps the star
				// marker on index 0 no matter where the model placed the option.
				const orderedOptions = [recommended, ...options.filter((opt) => opt !== recommended)];
				const displayOptions = orderedOptions.map((opt) => (opt === recommended ? `* ${opt}` : opt));
				if (isYoloActive(ctx)) {
					answer = recommended;
				} else {
					maybeBeep(ctx, "Goal question", question);
					const selectOptions = [...displayOptions, CUSTOM_OPTION];
					const choice = await ctx.ui.select(question, selectOptions);
					const strippedChoice = choice?.replace(/^\* /, "") ?? null;
					if (strippedChoice === CUSTOM_OPTION) {
						const custom = await ctx.ui.input(`${question} (custom answer)`, "Type your answer");
						answer = custom ?? null;
					} else {
						answer = strippedChoice ?? null;
					}
				}
			} else if (type === "multiple_answers") {
				if (isYoloActive(ctx)) {
					const recommended =
						params.recommended && options.includes(params.recommended)
							? params.recommended
							: options.length > 0
								? options[0]
								: "";
					answer = recommended ? [recommended] : [];
				} else {
					maybeBeep(ctx, "Goal question", question);
					const allOptions = options.length > 0 ? [...options, CUSTOM_OPTION] : [CUSTOM_OPTION];
					const placeholder = `Comma-separated values. Options: ${allOptions.join(", ")}`;
					const raw = await ctx.ui.input(question, placeholder);
					if (raw) {
						const parts = raw
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						const otherIdx = parts.findIndex(
							(p) => p.toLowerCase() === CUSTOM_OPTION.toLowerCase() || p.toLowerCase() === "others",
						);
						if (otherIdx !== -1) {
							const custom = await ctx.ui.input(`${question} (custom answer)`, "Type your custom answer");
							if (custom) {
								parts[otherIdx] = custom.trim();
							} else {
								parts.splice(otherIdx, 1);
							}
						}
						answer = parts;
					} else {
						answer = null;
					}
				}
			} else {
				// open_ended
				if (isYoloActive(ctx)) {
					return {
						content: [{ type: "text", text: "Error: open-ended questions are not available in yolo mode. Use radio_answers or multiple_answers instead." }],
						details: { question, type, answer: null, yoloBlocked: true },
					};
				}
				maybeBeep(ctx, "Goal question", question);
				const raw = await ctx.ui.input(question, "Type your answer and press Enter");
				answer = raw ?? null;
			}

			if (answer === null) {
				return {
					content: [{ type: "text", text: "User did not provide an answer." }],
					details: { question, type, answer: null },
				};
			}

			const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
			return {
				content: [{ type: "text", text: answerText }],
				details: { question, type, answer },
			};
		},
	});

	pi.registerTool({
		name: "goal_approve_plan",
		label: "Approve goal plan",
		description:
			"Submit a task plan for user approval. The user reviews the refined goal and the full details of every task (description, contract, acceptance criteria) in an approval dialog, then approves or rejects. Do not call this together with any other tool in the same message; it blocks until the user answers.",
		parameters: Type.Object({
			refinedGoal: Type.String({ description: "The refined goal after clarification" }),
			tasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "Short unique identifier, e.g. task-1" }),
					description: Type.String({ description: "One-line description of the task" }),
					contract: Type.String({ description: "Detailed instructions for the worker" }),
					acceptanceCriteria: Type.Array(Type.String({ description: "Verifiable criteria" })),
				}),
				{ minItems: 1 },
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Cannot ask for approval: not in interactive mode" }],
					details: { approved: false },
				};
			}

			// Save the refined goal and tasks to state
			const state = loadState() || {
				goal: params.refinedGoal,
				refinedGoal: params.refinedGoal,
				status: "active" as GoalStatus,
				tasks: [],
				result: null,
				auditFeedback: null,
				auditLog: [],
				yoloMode: false,
				yoloSessionId: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			state.refinedGoal = params.refinedGoal;
			state.goal = state.goal || params.refinedGoal;
			state.tasks = params.tasks.map((t) => ({
				...t,
				status: "pending" as const,
				auditResult: null,
				error: null,
				criteriaStatus: pendingCriteria(t.acceptanceCriteria.length),
			}));
			state.status = "active";
			state.auditFeedback = null;
			saveState(state);
			
			// Emit the full, untruncated plan to the chat transcript for session
			// history (the approval dialog below already shows the full plan, so
			// the user reviews it there while this tool is still running).
			const planMarkdown = formatPlanMarkdown(params);
			pi.sendMessage({
				customType: "goal_plan",
				content: planMarkdown,
				display: true,
				details: { refinedGoal: params.refinedGoal, tasks: params.tasks },
			});

			refreshWidget(ctx as ExtensionContext);

			let choice: string | undefined;
			const yoloActive = isYoloActive(ctx);
			if (!yoloActive) {
				maybeBeep(ctx, "Plan approval needed", paraphraseGoal(params.refinedGoal));
			}
			choice = await showPlanApproval(ctx as ExtensionContext, planMarkdown, yoloActive);

			if (choice === "Yes, proceed") {
				state.tasks = state.tasks.map((t) => ({ ...t, status: "approved" as const }));
				saveState(state);
				refreshWidget(ctx as ExtensionContext);
				return {
					content: [{ type: "text", text: "Plan approved. Proceed with execution." }],
					details: { approved: true, refinedGoal: params.refinedGoal, tasks: params.tasks },
				};
			}

			if (choice === "I have a comment") {
				const comment = await ctx.ui.input("Your feedback on the plan", "Type your comment and press Enter");
				if (comment) {
					return {
						content: [{ type: "text", text: `User commented: ${comment}` }],
						details: { approved: false, comment, refinedGoal: params.refinedGoal, tasks: params.tasks },
					};
				}
			}

			return {
				content: [{ type: "text", text: "Plan rejected. Revise and resubmit." }],
				details: { approved: false },
			};
		},
	});

	pi.registerTool({
		name: "goal_update_task",
		label: "Update task status",
		description:
			"Mark a task as in-progress or completed. The widget updates immediately. " +
			"Call this right after you finish a task. Do not procrastinate.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The task id to update" }),
			status: Type.Union([Type.Literal("in-progress"), Type.Literal("completed")], {
				description: "New status for the task",
			}),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState();
			if (!state) {
				return {
					content: [{ type: "text", text: "No active goal." }],
					details: { error: "no_state" },
				};
			}

			const task = state.tasks.find((t) => t.id === params.taskId);
			if (!task) {
				const ids = state.tasks.map((t) => t.id).join(", ");
				return {
					content: [{ type: "text", text: `Task "${params.taskId}" not found. Available tasks: ${ids}` }],
					details: { error: "task_not_found" },
				};
			}

			task.status = params.status;
			saveState(state);
			refreshWidget(ctx as ExtensionContext);

			return {
				content: [
					{
						type: "text",
						text: `Task "${params.taskId}" marked as ${params.status}.`,
					},
				],
				details: {
					taskId: params.taskId,
					status: params.status,
					allCompleted: state.tasks.every((t) => t.status === "completed"),
				},
			};
		},
	});

	pi.registerTool({
		name: "goal_complete",
		label: "Complete goal",
		description:
			"Submit the goal for audit. Requires every task to be marked completed first. " +
			"This dispatches parallel isolated auditors (one per task shard) and blocks until the coordinator merges their verdicts. Do not attempt to spawn the auditors yourself.",
		parameters: Type.Object({
			summary: Type.String({ description: "Summary of what was accomplished" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState();
			if (!state) {
				return {
					content: [{ type: "text", text: "No goal to complete." }],
					details: { error: "no_state" },
				};
			}

			if (state.status === "auditing") {
				return {
					content: [{ type: "text", text: "An audit is already in progress. Wait for the coordinator to deliver its verdict." }],
					details: { error: "audit_in_progress" },
				};
			}

			// Enforce: every task must be completed before audit
			const incompleteTasks = state.tasks.filter((t) => t.status !== "completed");
			if (incompleteTasks.length > 0) {
				const list = incompleteTasks.map((t) => `- ${t.id}: ${t.description} (${t.status})`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `Cannot audit: ${incompleteTasks.length} task(s) not yet completed.\n\nMark each one done with goal_update_task, then call goal_complete again.\n\n${list}`,
						},
					],
					details: { error: "incomplete_tasks", incompleteTasks: incompleteTasks.map((t) => t.id) },
				};
			}

			state.status = "auditing";
			state.result = params.summary;
			state.auditFeedback = "auditor pending...";
			state.audit = null;
			state.auditLog = [
				"Goal submitted for audit. Dispatching parallel auditors per task...",
			];
			saveState(state);
			refreshWidget(ctx as ExtensionContext);

			// Dispatch one isolated auditor per task shard in parallel and stream
			// their activity into the widget panel. The tool blocks until the
			// coordinator merges every shard verdict.
			const result = await runAudit(ctx as ExtensionContext, pi);

			if (result === null) {
				return {
					content: [{ type: "text", text: "Audit did not complete. No verdict was reached." }],
					details: { submittedForAudit: true, approved: false, error: "no_verdict" },
				};
			}

			if (result.approved) {
				clearWidget(ctx as ExtensionContext);
				ctx.ui.setStatus("pi-goal", "");
				ctx.ui.notify(`Goal audited and completed.\n\n${result.feedback}`, "info");

				// Emit the full, untruncated audit report to the chat transcript
				const finalState = loadState();
				const reportMarkdown = formatAuditReportMarkdown(finalState, true, result.feedback);
				pi.sendMessage({
					customType: "goal_audit_report",
					content: reportMarkdown + "\n\nDon't forget to git commit conventionally.",
					display: true,
					details: { approved: true, feedback: result.feedback },
				});

				return {
					content: [{ type: "text", text: `Audit passed. Goal completed.\n\n${result.feedback}` }],
					details: { submittedForAudit: true, approved: true, feedback: result.feedback },
				};
			}

			// Rejected: hand the failing tasks back to the main agent.
			// The tool return value carries the full verdict to the agent. No
			// separate follow-up needed now that the tool call is already closed.
			const st = loadState();
			const failed = (st?.tasks || []).filter((t) => t.status !== "completed");
			const failedList = failed
				.map((t) => `- ${t.id}: ${t.description} (${t.error || "criteria not met"})`)
				.join("\n");

			const feedback = result.feedback;
			const text = `Audit rejected. Tasks reset to pending.\n\n**Auditor feedback:** ${feedback}\n\n**Tasks that need rework:**\n${failedList}\n\nRe-execute only the failing tasks, then call goal_complete again.`;

			// Emit the full, untruncated rejection report to the chat transcript
			const reportMarkdown = formatAuditReportMarkdown(st, false, feedback, failed);
			pi.sendMessage({
				customType: "goal_audit_report",
				content: reportMarkdown,
				display: true,
				details: { approved: false, feedback, failedTasks: failed },
			});

			return {
				content: [{ type: "text", text }],
				details: { submittedForAudit: true, approved: false, feedback },
			};
		},
	});

	pi.registerTool({
		name: "goal_audit_result",
		label: "Submit audit result",
		description:
			"AUDITOR-ONLY. Submit the verdict from an isolated auditor. If approved, the goal is completed. If rejected, the failed tasks are reset to pending so the host can re-execute. Only the in-process auditor should call this tool.",
		parameters: Type.Object({
			approved: Type.Boolean({ description: "True if the auditor verified all tasks meet their acceptance criteria" }),
			feedback: Type.String({ description: "The auditor's verdict and reasoning" }),
			failedTasks: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						reason: Type.String(),
					}),
					{ description: "Tasks that did not meet their acceptance criteria (only when approved=false)" },
				),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState();
			if (!state) {
				return {
					content: [{ type: "text", text: "No goal to audit." }],
					details: { error: "no_state" },
				};
			}

			if (state.status === "auditing" && state.audit?.shards?.length) {
				return {
					content: [
						{
							type: "text",
							text: "A parallel audit is already running. Only the in-process auditors may submit shard verdicts; the coordinator merges them.",
						},
					],
					details: { error: "audit_in_progress" },
				};
			}

			const result = applyAuditVerdict(params);

			if (result.approved) {
				clearWidget(ctx);
				ctx.ui.setStatus("pi-goal", "");
				ctx.ui.notify(`Goal audited and completed.\n\n${params.feedback}`, "info");

				const finalState = loadState();
				const reportMarkdown = formatAuditReportMarkdown(finalState, true, params.feedback);
				pi.sendMessage({
					customType: "goal_audit_report",
					content: reportMarkdown,
					display: true,
					details: { approved: true, feedback: params.feedback },
				});

				return {
					content: [{ type: "text", text: `Auditor approved. Goal completed.\n\n${params.feedback}` }],
					details: { approved: true },
				};
			}

			// Rejected: tell the main agent to re-execute the failing tasks.
			refreshWidget(ctx as ExtensionContext);

			const failedList = (params.failedTasks || [])
				.map((t) => `- ${t.id}: ${t.reason}`)
				.join("\n");

			const st = loadState();
			const failed = (st?.tasks || []).filter((t) => t.status !== "completed");
			const reportMarkdown = formatAuditReportMarkdown(st, false, params.feedback, failed);
			pi.sendMessage({
				customType: "goal_audit_report",
				content: reportMarkdown,
				display: true,
				details: { approved: false, feedback: params.feedback, failedTasks: failed },
			});

			queueGoalMessage(pi, [
				{
					type: "text",
					text: `The auditor rejected the work. Tasks reset to pending.\n\n**Auditor feedback:** ${params.feedback}\n\n**Tasks that need rework:**\n${failedList}\n\nRe-execute only the failing tasks. When everything passes, call \`goal_complete\` again to re-trigger the audit.`,
				},
			]);

			return {
				content: [
					{
						type: "text",
						text: `Auditor rejected. ${result.failedTaskCount} task(s) reset to pending. Re-execute and re-submit.`,
					},
				],
				details: { approved: false, failedTaskCount: result.failedTaskCount },
			};
		},
	});

	pi.registerTool({
		name: "goal_fail",
		label: "Fail goal",
		description: "Mark the goal as failed with a reason.",
		parameters: Type.Object({
			reason: Type.String({ description: "Why the goal could not be completed" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState();
			abortActiveAuditors();
			if (state) {
				state.status = "failed";
				state.result = params.reason;
				saveState(state);
			}
			stopWatcher();
			clearWidget(ctx);
			ctx.ui.setStatus("pi-goal", "");
			ctx.ui.notify(`Goal failed: ${params.reason}`, "error");
			return {
				content: [{ type: "text", text: `Goal failed: ${params.reason}` }],
				details: { failed: true, reason: params.reason },
			};
		},
	});

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("goal", {
		description: "Start a goal workflow. The agent refines, plans, and executes.",
		handler: async (args, ctx) => {
			const topic = args.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /goal <topic>", "error");
				return;
			}

			// Carry yolo state over from a previous goal in this session so it
			// persists across goals until toggled off or the session changes.
			const prevState = loadState();
			const state: GoalState = {
				goal: topic,
				refinedGoal: null,
				status: "active",
				tasks: [],
				result: null,
				auditFeedback: null,
				auditLog: [],
				yoloMode: prevState?.yoloMode ?? false,
				yoloSessionId: prevState?.yoloSessionId ?? null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			saveState(state);

			activeWidgetCtx = ctx as ExtensionContext;
			startWatcher(ctx as ExtensionContext);
			refreshWidget(ctx as ExtensionContext);
			ctx.ui.setStatus("pi-goal", "Active");

			queueGoalMessage(pi, [
				{
					type: "text",
					text: buildGoalInstructionPrompt(topic),
				},
			]);
		},
	});

	pi.registerCommand("goal-status", {
		description: "Show the current goal state",
		handler: async (_args, ctx) => {
			const state = loadState();
			if (!state) {
				ctx.ui.notify("No active goal. Start one with /goal <topic>", "info");
				return;
			}

			const lines = [
				`Goal: ${state.refinedGoal || state.goal}`,
				`Status: ${state.status}`,
				`YOLO: ${isYoloActive(ctx) ? "ON" : "OFF"}`,
				`Tasks: ${state.tasks.length} total`,
				"",
				...state.tasks.map((t) => {
					const icons: Record<string, string> = {
						pending: "o",
						approved: "*",
						"in-progress": ">",
						completed: "+",
						failed: "x",
					};
					const criteria = taskCriteriaStatus(t);
					const verified = criteria.filter((s) => s === "passed" || s === "failed").length;
					const criteriaLabel = criteria.length > 0 ? ` [${verified}/${criteria.length} criteria]` : "";
					return `  ${icons[t.status] || "o"} ${t.description} (${t.status})${criteriaLabel}`;
				}),
			];

			if (state.audit?.shards?.length) {
				lines.push("", `Auditors: ${state.audit.shards.length} (per-task, worktree-isolated)`);
				for (const shard of state.audit.shards) {
					const verdict = shard.approved === true ? "PASS" : shard.approved === false ? "FAIL" : shard.status;
					lines.push(`  ${shard.id} ${verdict} ${shard.verified}/${shard.taskIds.length} [${shard.taskIds.join(", ")}]`);
				}
			}

			if (state.auditFeedback) lines.push("", `Audit: ${state.auditFeedback}`);
			if (state.result) lines.push("", `Result: ${state.result}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("goal-pause", {
		description: "Pause the current goal. It can be resumed later with /goal-resume.",
		handler: async (_args, ctx) => {
			const state = loadState();
			if (!state) {
				ctx.ui.notify("No active goal to pause.", "info");
				return;
			}
			if (state.status !== "active" && state.status !== "auditing") {
				ctx.ui.notify(`Goal is in state "${state.status}", cannot pause.`, "warning");
				return;
			}
			abortActiveAuditors();
			state.status = "paused";
			saveState(state);
			ctx.ui.setStatus("pi-goal", "Paused");
			refreshWidget(ctx as ExtensionContext);
			ctx.ui.notify("Goal paused. Use /goal-resume to continue.", "info");
		},
	});

	pi.registerCommand("goal-resume", {
		description: "Resume a paused goal.",
		handler: async (_args, ctx) => {
			const state = loadState();
			if (!state) {
				ctx.ui.notify("No goal to resume.", "info");
				return;
			}
			if (state.status !== "paused") {
				ctx.ui.notify(`Goal is not paused (current: "${state.status}").`, "warning");
				return;
			}
			state.status = "active";
			state.updatedAt = Date.now();
			saveState(state);
			activeWidgetCtx = ctx as ExtensionContext;
			startWatcher(ctx as ExtensionContext);
			refreshWidget(ctx as ExtensionContext);
			ctx.ui.setStatus("pi-goal", "Active");

			const incomplete = state.tasks.filter((t) => t.status !== "completed");
			queueGoalMessage(pi,
				[
					{
						type: "text",
						text: `The goal was resumed. Continue executing the remaining tasks.

**Goal:** ${state.refinedGoal || state.goal}
**Remaining tasks:** ${incomplete.length}

${incomplete.map((t) => `- ${t.id}: ${t.description} (${t.status})`).join("\n")}

Continue where you left off. Mark each task done with goal_update_task when finished, then call goal_complete.`,
					},
				]);

			ctx.ui.notify("Goal resumed. Agent is picking up where it left off.", "info");
		},
	});

	pi.registerCommand("goal-yolo", {
		description: "Toggle yolo mode (session-scoped). When on: open-ended questions are blocked, recommended answers are auto-selected, and goal plans are auto-approved. Yolo applies only to the session that enabled it; a different session id starts with yolo off.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				let state = loadState();
				if (!state) {
					// No goal yet: persist yolo in a placeholder state so it carries
					// into the next /goal in this session.
					state = {
						goal: "",
						refinedGoal: null,
						status: "active" as GoalStatus,
						tasks: [],
						result: null,
						auditFeedback: null,
						auditLog: [],
						yoloMode: false,
						yoloSessionId: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					};
				}
				state.yoloMode = true;
				state.yoloSessionId = ctx.sessionManager.getSessionId();
				saveState(state);
				ctx.ui.notify("YOLO mode ON for this session. Open-ended questions blocked, recommended answers auto-selected, plans auto-approved.", "info");
			} else if (arg === "off") {
				const state = loadState();
				if (!state) {
					ctx.ui.notify("YOLO mode is OFF.", "info");
					return;
				}
				state.yoloMode = false;
				state.yoloSessionId = null;
				saveState(state);
				ctx.ui.notify("YOLO mode OFF.", "info");
			} else {
				const status = isYoloActive(ctx) ? "ON" : "OFF";
				ctx.ui.notify(`YOLO mode is currently ${status} for this session. Use /goal-yolo on or /goal-yolo off to change.`, "info");
				return;
			}
			if (activeWidgetCtx) refreshWidget(activeWidgetCtx);
		},
	});

	pi.registerCommand("goal-auditors", {
		description:
			"Show or set the parallel auditor configuration. Usage: /goal-auditors [n|auto]. n is 1-16; auto uses one auditor per task (up to 16). Persisted in .pi/goal/config.json and overridable with PI_GOAL_AUDITORS, PI_GOAL_AUDIT_CONCURRENCY, PI_GOAL_AUDIT_WORKTREE, PI_GOAL_AUDIT_TIMEOUT_MS.",
		handler: async (args, ctx) => {
			const cfg = loadAuditConfig();
			const arg = args.trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(
					[
						`Auditors: ${cfg.auditors}`,
						`Max concurrency: ${cfg.maxConcurrency}`,
						`Worktree isolation: ${cfg.worktree ? "on" : "off"}`,
						`Per-auditor timeout: ${Math.round(cfg.timeoutMs / 1000)}s`,
						`Linked paths: ${cfg.linkPaths.join(", ") || "(none)"}`,
						`Thinking level: ${cfg.thinkingLevel}`,
						"",
						"Change with /goal-auditors <n|auto>, or edit .pi/goal/config.json (audit.*).",
					].join("\n"),
					"info",
				);
				return;
			}

			if (arg === "auto") {
				const next = saveAuditConfig({ auditors: 16, maxConcurrency: 8 });
				ctx.ui.notify(
					`Auditors set to auto: one per task (up to ${next.auditors}), concurrency ${next.maxConcurrency}. Applies to the next goal_complete.`,
					"info",
				);
				return;
			}

			const n = Number.parseInt(arg, 10);
			if (!Number.isFinite(n) || n < 1 || n > 16) {
				ctx.ui.notify("Usage: /goal-auditors <1-16|auto>", "error");
				return;
			}
			const next = saveAuditConfig({ auditors: n, maxConcurrency: Math.min(n, 8) });
			ctx.ui.notify(
				`Auditors set to ${next.auditors} (concurrency ${next.maxConcurrency}). Applies to the next goal_complete.`,
				"info",
			);
		},
	});

	pi.registerCommand("goal-stop", {
		description: "Stop the current goal. The goal is marked as stopped and the widget is removed.",
		handler: async (_args, ctx) => {
			const state = loadState();
			if (!state) {
				ctx.ui.notify("No active goal to stop.", "info");
				return;
			}
			abortActiveAuditors();
			state.status = "stopped";
			state.result = "Stopped by user";
			saveState(state);
			stopWatcher();
			clearWidget(ctx);
			ctx.ui.setStatus("pi-goal", "");
			ctx.ui.notify("Goal stopped.", "info");
		},
	});

	pi.registerCommand("goal-delete", {
		description: "Delete the current goal and all its state.",
		handler: async (_args, ctx) => {
			const state = loadState();
			if (!state) {
				ctx.ui.notify("No goal to delete.", "info");
				return;
			}
			abortActiveAuditors();
			clearState();
			stopWatcher();
			clearWidget(ctx);
			ctx.ui.setStatus("pi-goal", "");
			ctx.ui.notify("Goal deleted.", "info");
		},
	});

	pi.registerCommand("goal-clear", {
		description: "Clear the current goal state (alias for /goal-delete)",
		handler: async (_args, ctx) => {
			const state = loadState();
			if (!state) {
				ctx.ui.notify("No goal to clear.", "info");
				return;
			}
			abortActiveAuditors();
			clearState();
			stopWatcher();
			clearWidget(ctx);
			ctx.ui.setStatus("pi-goal", "");
			ctx.ui.notify("Goal state cleared.", "info");
		},
	});
}