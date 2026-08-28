/**
 * pi-goal — Goal-driven agentic workflow extension
 *
 * Invoke with `/goal <topic>`. The command registers the goal and hands
 * control to the agent. The agent refines the goal, plans the work, and
 * executes it — using the provided tools to interact with the user.
 *
 * Tools:
 *   goal_ask            — ask the user a clarifying question
 *   goal_approve_plan   — submit a task plan for user approval
 *   goal_update_task    — mark a task in-progress or completed
 *   goal_complete       — submit the goal for audit (requires all tasks done)
 *   goal_audit_result   — submit the auditor's verdict
 *   goal_fail           — mark the goal as failed
 *
 * Widget tracking:
 *   A widget above the editor shows the goal and task progress. It is
 *   updated live (via a file watcher on the state file) and cleared when
 *   the goal is completed, failed, stopped, or deleted.
 *
 * Audit loop:
 *   `goal_complete` does not finalize the goal. It transitions the state
 *   to "auditing" and spawns an isolated auditor in-process via the pi SDK
 *   (createAgentSession) with a fresh, bounded context. The auditor's
 *   thinking tokens and tool calls are streamed live into the widget's
 *   audit log so the user watches the audit happen. The auditor submits
 *   its verdict through goal_audit_result (AUDITOR-ONLY), which either
 *   approves (transitioning to "completed") or rejects (returning tasks
 *   to "pending" so the host can re-execute and call goal_complete again).
 *
 * Built on the research from the pi-goal project:
 *   - Workers execute in fresh, bounded contexts
 *   - Execution and assessment are decoupled
 *   - Task state is externalized and versioned
 *   - The user is the decision maker, the agent is the guide
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, ScrollView, Text, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

const CUSTOM_OPTION = "Others (custom answer)";
let yoloMode = false;

const buildGoalInstructionPrompt = (topic: string): string =>
	`I want to accomplish this goal: ${topic}

Work through it step by step:

1. **Refine** \u2014 If the goal is vague or has missing constraints, use goal_ask to ask me clarifying questions. Use the right question type:
   - open_ended (default) for free-text input
   - multiple_answers when several independent choices are valid
   - radio_answers when picking a single option from a list (provide the candidate answers via options, putting your recommended one first)
   Ask ONE question at a time. Do not combine multiple clarifying questions into a single goal_ask call \u2014 each question is asked separately.
   Keep asking until you have a clear, actionable goal.

2. **Plan** \u2014 Decompose the goal into a small set of tasks. Each task needs a contract (what to do) and acceptance criteria (how to verify it is done). Tasks should be ordered so each builds on the completed state of the prior ones.

3. **Approve** \u2014 Use goal_approve_plan to submit the refined goal and task list for my approval. If I reject it, revise and resubmit.

4. **Execute** \u2014 Once approved, execute each task. Prefer spawning isolated subagents (fresh-context, worktree-isolated) per task so each one has a clean start. After each task, verify it yourself with a fresh, critical eye, then immediately call goal_update_task to mark it "completed". Do not move on to the next task before marking the current one done.

5. **Mark done** \u2014 After each task is complete, immediately call goal_update_task with taskId and status "completed". Do not procrastinate \u2014 mark it done right after verification.

6. **Complete** \u2014 When all tasks are marked done, call goal_complete with a summary. This spawns an isolated auditor in the background (handled by the goal extension, not by you). Its thinking and tool calls stream into the goal panel above the editor while it verifies the work.

7. **Audit result** \u2014 goal_audit_result is AUDITOR-ONLY. The in-process auditor calls it directly to submit its verdict; you do not call it. On rejection, fix the failing tasks (they will be reset to pending) and call goal_complete again. On approval, the goal is finalized.

The state file at .pi/goal/state.json is updated automatically. You can read it to track progress.`;

const AUDITOR_SYSTEM_PROMPT_TEMPLATE = `You are the goal auditor for an agentic workflow. Your job is to verify, with a fresh and critical eye, that the work delivered for a goal actually meets every acceptance criterion. You are an independent reviewer: trust nothing, verify everything yourself.

You have read-only verification tools (read, bash, grep, find, ls) plus write/edit only when you must create test artifacts; you must NEVER modify the goal's state file (.pi/goal/state.json).

## Goal
__GOAL__

## Claimed work summary (from the executor)
__RESULT__

## Tasks and acceptance criteria to verify
__TASKS__

## Procedure
1. Read the current state from .pi/goal/state.json to see what the executor claims.
2. For each task, inspect the actual deliverables: read the files, run the commands, check the artifacts. Where a criterion is verifiable by running code or checking a file, do it. Do not take the executor's word.
3. Keep working until every criterion is either verified or disproven.

## Verdict
When you are done, call the tool goal_audit_result exactly once with:
- approved: true if EVERY acceptance criterion of EVERY task is met, else false.
- feedback: a concise verdict explaining what you verified and, on rejection, what failed.
- failedTasks: only when approved=false, the list of { id, reason } for each task that did not meet its criteria. Omit the field when approved=true.

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
	createdAt: number;
	updatedAt: number;
}

interface TaskState {
	id: string;
	description: string;
	contract: string;
	acceptanceCriteria: string[];
	status: "pending" | "approved" | "in-progress" | "completed" | "failed";
	auditResult: string | null;
	error: string | null;
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
// Goal paraphrasing (cheap heuristic for short widget titles)
// ---------------------------------------------------------------------------

function paraphraseGoal(goal: string): string {
	const trimmed = goal.trim().replace(/\s+/g, " ");
	// Take the first sentence as a paraphrase — no hard character cap.
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

function renderWidgetLines(state: GoalState, width: number, theme: ThemeLike | undefined): string[] {
	const style = theme
		? makeStyleHelpers(theme)
		: { bold: (s: string) => s, italic: (s: string) => s, fg: (_c: string, s: string) => s, muted: (s: string) => s };

	const innerWidth = Math.max(20, width - 2);
	const hr = style.fg("border", "─".repeat(innerWidth));

	const total = state.tasks.length;
	const completed = state.tasks.filter((t) => t.status === "completed").length;
	const failed = state.tasks.filter((t) => t.status === "failed").length;
	const currentIndex = state.tasks.findIndex((t) => t.status === "in-progress" || t.status === "approved");

	const title = state.refinedGoal || state.goal;
	const paraphrased = paraphraseGoal(title);

	const out: string[] = [];

	// Header row: GOAL (paraphrased)
	const headerLabel = style.bold(style.fg("accent", "GOAL"));
	const yoloBadge = yoloMode ? style.bold(style.fg("warning", " YOLO ")) : "";
	const statusBadge = state.status === "auditing"
		? style.bold(style.fg("warning", " AUDITING "))
		: state.status === "paused"
			? style.bold(style.fg("muted", " PAUSED "))
			: style.fg("muted", " active ");
	out.push(`${headerLabel}${style.fg("dim", " · ")}${style.italic(paraphrased)}${style.fg("dim", "  ")}${yoloBadge}${statusBadge}`);

	// Divider
	out.push(style.fg("dim", hr));

	if (state.status === "auditing") {
		// Left/right split: left column = task list, right column = auditor token stream.
		// The user sees both at once: what is being checked and what the auditor is saying.
		const leftW = Math.max(1, Math.min(Math.max(20, Math.floor(innerWidth * 0.38)), innerWidth - 4));
		const rightW = Math.max(1, innerWidth - leftW - 3);
		const sep = style.fg("dim", "│");

		// ── Left column: task list (plain strings, styled at merge time) ──
		const leftPlain: string[] = [];
		leftPlain.push("Tasks");
		const MAX_TASK_ROWS = 10;
		for (let i = 0; i < state.tasks.length; i++) {
			if (i >= MAX_TASK_ROWS) {
				const remaining = state.tasks.length - MAX_TASK_ROWS;
				leftPlain.push(` ... and ${remaining} more`);
				break;
			}
			const task = state.tasks[i];
			let icon: string;
			let note: string;
			if (!task.auditResult) {
				icon = "?";
				note = "verifying...";
			} else if (task.status === "completed") {
				icon = "+";
				note = "ok";
			} else {
				icon = "x";
				note = "FAIL";
			}
			const maxDesc = leftW - 12;
			const desc = truncateToWidth(task.description, maxDesc - 4, "...", true);
			leftPlain.push(` ${icon} ${desc} ${note}`);
		}

		// ── Right column: auditor token stream (plain strings, styled at merge) ──
		const rightPlain: string[] = [];
		rightPlain.push("Auditor");
		const log = state.auditLog || [];

		if (log.length > 0) {
			const maxLines = 15;
			const start = Math.max(0, log.length - maxLines);
			for (let i = start; i < log.length; i++) {
				const trimmed = truncateToWidth(sanitizeLogLine(log[i]), Math.max(1, rightW - 4), "...", false);
				rightPlain.push(trimmed);
			}
		} else {
			const pending = !state.auditFeedback || state.auditFeedback === "auditor pending...";
			if (pending) {
				rightPlain.push("auditor pending...");
				rightPlain.push("waiting for host to spawn");
			} else {
				rightPlain.push(state.auditFeedback!);
			}
		}

		// ── Merge columns with visible-width padding ──
		const maxRows = Math.max(leftPlain.length, rightPlain.length);
		// Left header + task rows get fg("text") styling; right header is dim, rest are text.
		for (let i = 0; i < maxRows; i++) {
			const lRaw = i < leftPlain.length ? leftPlain[i] : "";
			const lVis = visibleWidth(lRaw);
			const lPad = lVis < leftW ? " ".repeat(leftW - lVis) : "";
			const lFinal =
				i === 0
					? style.fg("muted", lRaw + lPad)
					: lRaw.trimStart().startsWith("+")
						? style.fg("text", " " + style.fg("success", "+") + lRaw.slice(2) + lPad)
						: lRaw.trimStart().startsWith("x")
							? style.fg("text", " " + style.fg("error", "x") + lRaw.slice(2) + lPad)
							: style.fg("text", lRaw + lPad);

			const rRaw = i < rightPlain.length ? rightPlain[i] : "";
			const rFinal = i === 0 ? style.fg("dim", ` ${rRaw}`) : rRaw ? ` ${style.fg("text", rRaw)}` : "";

			out.push(` ${lFinal} ${sep}${rFinal}`);
		}

		// Verdict footer when audit is done
		if (state.auditFeedback && state.auditFeedback !== "auditor pending..." && log.length > 0) {
			const trimmed = truncateToWidth(state.auditFeedback, innerWidth - 10, "...", false);
			out.push(` ${style.bold(style.fg("warning", "Verdict:"))} ${style.fg("text", trimmed)}`);
		}

		out.push(style.fg("dim", hr));
		return out;
	}

	// Progress: 3/N (X failed)
	if (total > 0) {
		const pct = Math.round((completed / total) * 100);
		const progressBar = makeProgressBar(completed, total, innerWidth - 18, style);
		const progressLabel = style.fg("muted", `${completed}/${total} `);
		const percentLabel = style.fg("accent", `${pct}%`);
		const failedLabel = failed > 0 ? style.fg("error", `  ${failed} failed`) : "";
		out.push(`${progressLabel}${progressBar}  ${percentLabel}${failedLabel}`);
	}

	// Task window: t-1, t, t+1, t+2
	if (total > 0) {
		const window = buildTaskWindow(state.tasks, currentIndex, innerWidth, 4);
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

	return {
		fg,
		bold: (s: string) => theme.bold(s),
		italic: (s: string) => theme.italic(s),
		muted: (s: string) => fg("muted", s),
	};
}

function makeProgressBar(done: number, total: number, width: number, style: ReturnType<typeof makeStyleHelpers>): string {
	if (width < 8) return "";
	const filled = Math.round((done / total) * (width - 2));
	const empty = width - 2 - filled;
	const bar = "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
	const color = done === total ? "success" : "accent";
	return style.fg(color, bar);
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
// Plan widget: full task plan in a scrollable view (approval dialog companion)
// ---------------------------------------------------------------------------

// The stock ctx.ui.confirm renders the message as a non-scrollable title in a
// selector with only Yes/No options, so long plans get clipped and the user
// cannot scroll up to read them. Instead we render the full plan into a
// ScrollView widget above the editor (wheel-scrollable) and keep the confirm
// dialog itself short.

const PLAN_WIDGET_KEY = "pi-goal-plan";

function buildPlanLines(params: { refinedGoal: string; tasks: { id: string; description: string; contract: string; acceptanceCriteria: string[] }[] }): string[] {
	const lines: string[] = [];
	lines.push("Refined Goal:");
	lines.push(`  ${params.refinedGoal}`);
	lines.push("");
	lines.push(`Tasks (${params.tasks.length}):`);
	for (let i = 0; i < params.tasks.length; i++) {
		const t = params.tasks[i];
		lines.push("");
		lines.push(`${i + 1}. ${t.description}  [${t.id}]`);
		lines.push(`   Contract: ${t.contract}`);
		lines.push(`   Verify: ${t.acceptanceCriteria.join("; ")}`);
	}
	return lines;
}

function setPlanWidget(ctx: ExtensionContext, lines: string[]): void {
	const container = new Container();
	for (const line of lines) {
		container.addChild(new Text(line, 1, 0));
	}
	const scroll = new ScrollView(container, {
		axis: "vertical",
		follow: "none",
		overscroll: "chain",
		scrollbar: "auto",
	});
	// The factory form is required to hand the host a component. The host
	// invokes the factory once and keeps the returned component, so we can
	// return the same ScrollView instance (its scroll state is preserved).
	ctx.ui.setWidget(PLAN_WIDGET_KEY, () => scroll);
}

function clearPlanWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
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
	ctx.ui.setWidget("pi-goal", undefined);
	widgetCache = null;
}

function refreshWidget(ctx: ExtensionContext): void {
	const state = loadState();
	if (!state || state.status === "completed" || state.status === "failed" || state.status === "stopped") {
		clearWidget(ctx);
		return;
	}
	ctx.ui.setWidget("pi-goal", (tui, theme) => {
		const width = (tui as { terminal?: { columns?: number } }).terminal?.columns ?? 80;
		const lines = renderWidgetLines(state, width, theme as unknown as ThemeLike | undefined);

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
// Audit runner — spawns the isolated auditor in-process and streams its
// activity (thinking tokens, tool calls, results) into state.auditLog so the
// widget panel updates live while the audit runs.
// ---------------------------------------------------------------------------

const AUDITOR_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

let auditInFlight: Promise<{ approved: boolean; feedback: string } | null> | null = null;
let auditFlushTimer: ReturnType<typeof setTimeout> | null = null;

// The verdict tool injected into the auditor session. It applies the verdict
// by writing shared state, which the main session's widget watcher picks up.
const auditVerdictTool = defineTool({
	name: "goal_audit_result",
	label: "Submit audit result",
	description:
		"AUDITOR-ONLY. Submit the verdict from an isolated auditor. If approved, the goal is completed. If rejected, the failed tasks are reset to pending so the host can re-execute. Only the auditor should call this tool.",
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

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const result = applyAuditVerdict(params);
		return {
			content: [
				{
					type: "text",
					text: result.approved
						? "Verdict recorded. Goal completed."
						: `Verdict recorded. ${result.failedTaskCount} task(s) reset to pending.`,
				},
			],
			details: { approved: result.approved, failedTaskCount: result.failedTaskCount },
		};
	},
});

function sanitizeLogLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ");
}

function appendAuditLog(lines: string[]): void {
	const state = loadState();
	if (!state || state.status !== "auditing") return;
	state.auditLog = [...(state.auditLog || []), ...lines.map(sanitizeLogLine)];
	saveState(state);
}

// Batch high-frequency thinking deltas (they arrive token by token) and
// persist the growing thought line on a short timer, so the widget updates
// live without writing the state file on every token.
let pendingThinkingText: string | null = null;

function scheduleAuditThinkingFlush(text: string): void {
	pendingThinkingText = text;
	if (auditFlushTimer) return;
	auditFlushTimer = setTimeout(() => {
		auditFlushTimer = null;
		const text = pendingThinkingText;
		pendingThinkingText = null;
		if (text === null) return;
		const st = loadState();
		if (!st || st.status !== "auditing") return;
		const tail = st.auditLog[st.auditLog.length - 1];
		const line = "thinking: " + sanitizeLogLine(text.trim());
		if (tail && tail.startsWith("thinking: ")) {
			st.auditLog[st.auditLog.length - 1] = line;
		} else {
			st.auditLog = [...(st.auditLog || []), line];
		}
		saveState(st);
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

// Apply the auditor verdict to persisted state. Shared by the AUDITOR-ONLY
// goal_audit_result tool (external caller) and the in-process audit session.
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
		state.auditLog = [...(state.auditLog || []), `PASSED: ${sanitizeLogLine(params.feedback)}`];
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
	state.auditLog = [...(state.auditLog || []), `REJECTED: ${sanitizeLogLine(params.feedback)}`];
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

function buildAuditorSystemPrompt(state: GoalState): string {
	const tasks = state.tasks
		.map((t, i) => {
			const criteria = t.acceptanceCriteria.map((c) => `      - ${c}`).join("\n");
			return `  ${i + 1}. ${t.id}: ${t.description}\n     contract: ${t.contract}\n     acceptance criteria:\n${criteria}`;
		})
		.join("\n\n");
	return AUDITOR_SYSTEM_PROMPT_TEMPLATE
		.replace("__GOAL__", state.refinedGoal || state.goal)
		.replace("__RESULT__", state.result || "(none provided)")
		.replace("__TASKS__", tasks);
}

function runAudit(ctx: ExtensionContext, api: ExtensionAPI): Promise<{ approved: boolean; feedback: string } | null> {
	if (auditInFlight) return auditInFlight;

	auditInFlight = (async () => {
		const state = loadState();
		if (!state || state.status !== "auditing") return null;

		appendAuditLog(["spawning isolated auditor..."]);

		let modelRuntime;
		try {
			modelRuntime = await ModelRuntime.create();
		} catch (err) {
			auditLogError(`FAILED: could not initialize model runtime: ${(err as Error).message}`);
			throw err;
		}

		// Fully isolated session: no project/user extensions (so the goal
		// extension does not re-register its tools or widgets inside the
		// auditor), no skills, no prompt templates, no context files. The
		// auditor gets only the read/verify tools plus the verdict tool.
		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const { session } = await createAgentSession({
			modelRuntime,
			cwd: ctx.cwd,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel ?? "medium",
			tools: [...AUDITOR_TOOLS, "goal_audit_result"],
			customTools: [auditVerdictTool],
		});

		// A fresh, bounded context: no goal tools other than the verdict
		// submitter we inject here.
		session.agent.state.systemPrompt = buildAuditorSystemPrompt(loadState() || state);

		// Stream the auditor's activity into the audit log.
		let thinkingBuf = "";
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update") {
				const ev = event.assistantMessageEvent;
				if (ev.type === "thinking_delta") {
					thinkingBuf += ev.delta;
					// Persist the growing thought line on a debounce; the panel
					// shows a live, growing thought instead of a new line per token.
					scheduleAuditThinkingFlush(thinkingBuf);
					return;
				}
				if (ev.type === "thinking_end") {
					thinkingBuf = "";
				}
				return;
			}

			if (event.type === "tool_execution_start") {
				const arg = summarizeArgs(event.toolName, event.args);
				appendAuditLog([`tool: ${event.toolName}${arg ? ` ${arg}` : ""}`]);
				return;
			}

			if (event.type === "tool_execution_end") {
				const summary = summarizeResult(event.result);
				const marker = event.isError ? "FAIL" : "ok";
				appendAuditLog([`  ${marker} ${event.toolName}${summary ? ` -> ${summary}` : ""}`]);
				if (event.toolName === "goal_audit_result") {
					// The verdict tool already applied the result via its own
					// execute, so generation is done; abort the auditor session
					// to stop token generation before any follow-up turn. A
					// failed verdict call is left alone so the audit can continue.
					if (!event.isError) {
						void session.abort();
					}
					return;
				}
				return;
			}

			if (event.type === "agent_end") {
				appendAuditLog(["auditor finished"]);
			}
		});

		try {
			await session.prompt(
				"Audit the goal now. Read .pi/goal/state.json first, verify every task against its acceptance criteria, then submit your verdict via goal_audit_result.",
			);

			// The auditor can finish its turn without submitting a verdict
			// (e.g. it ran out of context or just stopped). Follow up in the
			// same conversation and insist it submit the verdict via the tool
			// before giving up.
			let st = loadState();
			let followUps = 0;
			while (st && st.status === "auditing" && followUps < 3) {
				followUps += 1;
				appendAuditLog([`auditor finished without a verdict; following up (${followUps}/3)...`]);
				await session.prompt(
					"You finished without submitting a verdict. You must call goal_audit_result exactly once to submit your verdict: approved (boolean), feedback (string), and on rejection the failedTasks (id and reason). If you cannot verify the goal, reject it and say why. Do not end your turn before calling the tool.",
				);
				st = loadState();
			}

			if (st && st.status === "active") {
				// Rejected: hand the failing tasks back to the main agent.
				// goal_complete.execute() returns the verdict to the agent directly
				// via the tool result — no follow-up message needed.
				return { approved: false, feedback: st.auditFeedback || "No feedback provided" };
			} else if (st && st.status === "completed") {
				return { approved: true, feedback: st.auditFeedback || "All criteria met" };
			}
			return null;
		} finally {
			unsubscribe();
			session.dispose();
		}
	})().finally(() => {
		auditInFlight = null;
	});

	return auditInFlight!;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
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
		activeWidgetCtx = null;
	});

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "goal_ask",
		label: "Ask about goal",
		description:
			"Ask the user a clarifying question. Use open_ended for free-text input, multiple_answers for comma-separated values, or radio_answers for a single choice from options. Options lists automatically include \"Others (custom answer)\" as an escape hatch. The recommended option for radio_answers (the \"recommended\" param, or the first option when omitted) is moved to the front, marked with a \"*\" prefix, and pre-selected as the default in the UI.",
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
				if (yoloMode) {
					answer = recommended;
				} else {
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
				if (yoloMode) {
					const recommended =
						params.recommended && options.includes(params.recommended)
							? params.recommended
							: options.length > 0
								? options[0]
								: "";
					answer = recommended ? [recommended] : [];
				} else {
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
				if (yoloMode) {
					return {
						content: [{ type: "text", text: "Error: open-ended questions are not available in yolo mode. Use radio_answers or multiple_answers instead." }],
						details: { question, type, answer: null, yoloBlocked: true },
					};
				}
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
		description: "Submit a task plan for user approval. The user reviews the refined goal and task list, then approves or rejects.",
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
			}));
			state.status = "active";
			state.auditFeedback = null;
			saveState(state);
			refreshWidget(ctx as ExtensionContext);

			const planLines = buildPlanLines(params);

			// Render the full plan into a scrollable widget above the editor.
			// The stock confirm dialog cannot scroll its message, so the user
			// would only ever see the first screenful of the plan.
			setPlanWidget(ctx as ExtensionContext, planLines);

			let choice: string | undefined;
			try {
				if (yoloMode) {
					// Show plan widget briefly, then auto-confirm after 1.5s
					choice = await ctx.ui.select("Goal Plan (auto-approving...)", ["Yes, proceed"], { timeout: 1500 });
					if (choice === undefined) choice = "Yes, proceed";
				} else {
					choice = await ctx.ui.select("Goal Plan", ["Yes, proceed", "No, revise", "I have a comment"]);
				}
			} finally {
				clearPlanWidget(ctx as ExtensionContext);
			}

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
			"Call this right after you finish a task — do not procrastinate.",
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
			"This spawns an isolated auditor that blocks until the verdict is delivered. Do not attempt to spawn the auditor yourself.",
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
			state.auditLog = [
				"Goal submitted for audit. Verifying each task against its acceptance criteria...",
			];
			saveState(state);
			refreshWidget(ctx as ExtensionContext);

			// Spawn the isolated auditor in-process and stream its activity
			// into the widget panel. The tool blocks until the audit finishes.
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
				return {
					content: [{ type: "text", text: `Audit passed. Goal completed.\n\n${result.feedback}` }],
					details: { submittedForAudit: true, approved: true, feedback: result.feedback },
				};
			}

			// Rejected: hand the failing tasks back to the main agent.
			// The tool return value carries the full verdict to the agent — no
			// separate follow-up needed now that the tool call is already closed.
			const st = loadState();
			const failed = (st?.tasks || []).filter((t) => t.status !== "completed");
			const failedList = failed
				.map((t) => `- ${t.id}: ${t.description} (${t.error || "criteria not met"})`)
				.join("\n");

			const feedback = result.feedback;
			const text = `Audit rejected. Tasks reset to pending.\n\n**Auditor feedback:** ${feedback}\n\n**Tasks that need rework:**\n${failedList}\n\nRe-execute only the failing tasks, then call goal_complete again.`;

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

			const result = applyAuditVerdict(params);

			if (result.approved) {
				clearWidget(ctx);
				ctx.ui.setStatus("pi-goal", "");
				ctx.ui.notify(`Goal audited and completed.\n\n${params.feedback}`, "info");
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

			const state: GoalState = {
				goal: topic,
				refinedGoal: null,
				status: "active",
				tasks: [],
				result: null,
				auditFeedback: null,
				auditLog: [],
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
					return `  ${icons[t.status] || "o"} ${t.description} — ${t.status}`;
				}),
			];

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
		description: "Toggle yolo mode. When on: open-ended questions are blocked, recommended answers are auto-selected, and goal plans are auto-approved.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				yoloMode = true;
				ctx.ui.notify("YOLO mode ON. Open-ended questions blocked, recommended answers auto-selected, plans auto-approved.", "info");
			} else if (arg === "off") {
				yoloMode = false;
				ctx.ui.notify("YOLO mode OFF.", "info");
			} else {
				const status = yoloMode ? "ON" : "OFF";
				ctx.ui.notify(`YOLO mode is currently ${status}. Use /goal-yolo on or /goal-yolo off to change.`, "info");
				return;
			}
			if (activeWidgetCtx) refreshWidget(activeWidgetCtx);
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
			clearState();
			stopWatcher();
			clearWidget(ctx);
			ctx.ui.setStatus("pi-goal", "");
			ctx.ui.notify("Goal state cleared.", "info");
		},
	});
}