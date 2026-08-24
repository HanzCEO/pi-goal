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
 *   to "auditing" and the system deterministically spawns an isolated
 *   auditor that verifies the work. The auditor calls goal_audit_result
 *   (AUDITOR-ONLY). The auditor either approves (transitioning to
 *   "completed") or rejects (returning tasks to "pending" so the host can
 *   re-execute and call goal_complete again).
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
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";

const CUSTOM_OPTION = "Others (custom answer)";

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
	const prefixLen = 4; // "▶ ○ " = 4 chars
	const maxDescLen = Math.max(10, availWidth - prefixLen);
	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const task = tasks[i];
		const marker = i === currentIndex ? "▶" : " ";
		const icon =
			task.status === "completed"
				? "✓"
				: task.status === "failed"
					? "✗"
					: task.status === "in-progress"
						? "→"
						: task.status === "approved"
							? "◉"
						: "○";
		const desc = task.description.length > maxDescLen ? task.description.slice(0, maxDescLen - 1) + "…" : task.description;
		lines.push(`${marker} ${icon} ${desc}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Colored widget component (above the editor)
// ---------------------------------------------------------------------------

class GoalWidget extends Container {
	private state: GoalState;

	constructor(state: GoalState) {
		super();
		this.state = state;
		this.rebuild();
	}

	update(state: GoalState): void {
		this.state = state;
		this.clear();
		this.rebuild();
		this.invalidate();
	}

	private rebuild(): void {
		// Theme is resolved via the host at construction time. We use a
		// small helper that reads the current theme from the global
		// `ctx.ui.theme`. To keep this class simple, accept the theme at
		// rebuild time. (The host refreshes the widget after each
		// state mutation and re-renders with the current theme.)
	}

	override render(width: number): string[] {
		const lines = renderWidgetLines(this.state, width);
		return lines;
	}
}

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

	// Header row: ◆ GOAL (paraphrased)
	const headerLabel = style.bold(style.fg("accent", "◆ GOAL"));
	const statusBadge = state.status === "auditing"
		? style.bold(style.fg("warning", " AUDITING "))
		: state.status === "paused"
			? style.bold(style.fg("muted", " PAUSED "))
			: style.fg("muted", " active ");
	out.push(`${headerLabel}${style.fg("dim", " · ")}${style.italic(paraphrased)}${style.fg("dim", "  ")}${statusBadge}`);

	// Divider
	out.push(style.fg("dim", hr));

	if (state.status === "auditing") {
		// Auditor UI — replaces the task list entirely. Same height budget
		// as the task list (8 lines) so the widget doesn't grow.
		out.push(style.bold(style.fg("warning", "  ▶ AUDIT LOG")));

		const log = state.auditLog || [];
		const maxLog = 3;
		const start = Math.max(0, log.length - maxLog);
		for (let i = start; i < log.length; i++) {
			const trimmed = log[i].length > innerWidth - 2 ? log[i].slice(0, innerWidth - 3) + "…" : log[i];
			out.push(`  ${style.fg("text", trimmed)}`);
		}

		const pending = !state.auditFeedback || state.auditFeedback === "auditor pending...";
		if (pending && log.length === 0) {
			out.push(`  ${style.fg("muted", "auditor pending...")}`);
		} else if (state.auditFeedback) {
			const trimmed = state.auditFeedback.length > innerWidth - 2
				? state.auditFeedback.slice(0, innerWidth - 3) + "…"
				: state.auditFeedback;
			out.push(`  ${style.bold(style.fg("warning", trimmed))}`);
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
	// Do NOT spread the theme object here. Theme methods may live on a
	// prototype (class instance), so a spread would drop `fg`/`bold`/`italic`.
	// Instead close over the real object and forward every call to it.
	return {
		fg: (c: string, s: string) => theme.fg(c, s),
		bold: (s: string) => theme.bold(s),
		italic: (s: string) => theme.italic(s),
		muted: (s: string) => theme.fg("muted", s),
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
	// Lines look like: "▶ →  do the thing" or "   ✓ done"
	const isCurrent = line.trimStart().startsWith("▶");
	const trimmed = line.trimStart().replace(/^[▶ ]\s*/, "");
	const iconMatch = trimmed.match(/^([✓✗→◉○])\s+(.*)$/);
	if (!iconMatch) return line;
	const icon = iconMatch[1];
	const text = iconMatch[2];
	const iconStyled =
		icon === "✓"
			? style.fg("success", "✓")
			: icon === "✗"
				? style.fg("error", "✗")
				: icon === "→"
					? style.fg("accent", "→")
					: icon === "◉"
						? style.fg("muted", "◉")
						: style.fg("dim", "○");
	const textStyled = isCurrent
		? style.bold(style.fg("text", text))
		: icon === "✓"
			? style.fg("muted", text)
			: icon === "✗"
				? style.fg("error", text)
				: style.fg("text", text);
	// Reattach the leading marker
	const marker = isCurrent ? style.bold(style.fg("accent", "▶")) : " ";
	return `${marker} ${iconStyled} ${textStyled}`;
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

function refreshWidget(ctx: ExtensionContext): void {
	const state = loadState();
	if (!state || state.status === "completed" || state.status === "failed" || state.status === "stopped") {
		ctx.ui.setWidget("pi-goal", undefined);
		widgetCache = null;
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
			if (filename === "state.json") {
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
			"Ask the user a clarifying question. Use open_ended for free-text input, multiple_answers for comma-separated values, or radio_answers for a single choice from options. Options lists automatically include \"Others (custom answer)\" as an escape hatch.",
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
				const selectOptions = [...options, CUSTOM_OPTION];
				const choice = await ctx.ui.select(question, selectOptions);
				if (choice === CUSTOM_OPTION) {
					const custom = await ctx.ui.input(`${question} (custom answer)`, "Type your answer");
					answer = custom ?? null;
				} else {
					answer = choice ?? null;
				}
			} else if (type === "multiple_answers") {
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
			} else {
				// open_ended
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

			const planLines = params.tasks.map(
				(t, i) =>
					`${i + 1}. ${t.description}\n   Contract: ${t.contract}\n   Verify: ${t.acceptanceCriteria.join("; ")}`,
			);
			const display = `Refined Goal: ${params.refinedGoal}\n\nTasks:\n${planLines.join("\n\n")}`;

			const approved = await ctx.ui.confirm("Goal Plan", `${display}\n\nApprove this plan?`);

			if (approved) {
				state.tasks = state.tasks.map((t) => ({ ...t, status: "approved" as const }));
				saveState(state);
				refreshWidget(ctx as ExtensionContext);
				return {
					content: [{ type: "text", text: "Plan approved. Proceed with execution." }],
					details: { approved: true, refinedGoal: params.refinedGoal, tasks: params.tasks },
				};
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
			"The system spawns an isolated auditor deterministically. Do not attempt to spawn the auditor yourself.",
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

			return {
				content: [
					{
						type: "text",
						text: `Goal submitted for audit. The system will spawn an isolated auditor automatically. Wait for the audit result.`,
					},
				],
				details: { submittedForAudit: true, summary: params.summary },
			};
		},
	});

	pi.registerTool({
		name: "goal_audit_result",
		label: "Submit audit result",
		description:
			"AUDITOR-ONLY. Submit the verdict from an isolated auditor. If approved, the goal is completed. If rejected, the failed tasks are reset to pending so the host can re-execute. Only the externally spawned auditor should call this tool.",
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

			state.auditFeedback = params.feedback;

			if (params.approved) {
				state.status = "completed";
				state.tasks = state.tasks.map((t) => ({
					...t,
					status: "completed" as const,
					auditResult: params.feedback,
				}));
				state.auditLog = [...(state.auditLog || []), `✓ Approved: ${params.feedback}`];
				saveState(state);
				ctx.ui.setWidget("pi-goal", undefined);
				ctx.ui.setStatus("pi-goal", "");
				ctx.ui.notify(`Goal audited and completed.\n\n${params.feedback}`, "success");
				return {
					content: [{ type: "text", text: `Auditor approved. Goal completed.\n\n${params.feedback}` }],
					details: { approved: true },
				};
			}

			// Reject: reset failed tasks to pending so the host re-executes.
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
			state.auditLog = [...(state.auditLog || []), `✗ Rejected: ${params.feedback}`];
			for (const ft of params.failedTasks || []) {
				state.auditLog.push(`  - ${ft.id}: ${ft.reason}`);
			}
			saveState(state);
			refreshWidget(ctx as ExtensionContext);

			const failedList = (params.failedTasks || [])
				.map((t) => `- ${t.id}: ${t.reason}`)
				.join("\n");

			pi.sendUserMessage([
					{
						type: "text",
						text: `The auditor rejected the work. Tasks reset to pending.

**Auditor feedback:** ${params.feedback}

**Tasks that need rework:**
${failedList}

Re-execute only the failing tasks. When everything passes, call \`goal_complete\` again to re-trigger the audit.`,
					},
				]);

			return {
				content: [
					{
					type: "text",
					text: `Auditor rejected. ${failedIds.size} task(s) reset to pending. Re-execute and re-submit.`,
					},
				],
				details: { approved: false, failedTaskCount: failedIds.size },
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
			ctx.ui.setWidget("pi-goal", undefined);
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

			pi.sendUserMessage([
				{
					type: "text",
					text: `I want to accomplish this goal: ${topic}

Work through it step by step:

1. **Refine** — Read the current goal state from .pi/goal/state.json. If the goal is vague or has missing constraints, use goal_ask to ask me clarifying questions. Use the right question type:
   - open_ended (default) for free-text input
   - multiple_answers when several independent choices are valid
   - radio_answers when picking a single option from a list (pass options=[])
   Keep asking until you have a clear, actionable goal.

2. **Plan** — Decompose the goal into a small set of tasks. Each task needs a contract (what to do) and acceptance criteria (how to verify it is done). Tasks should be ordered so each builds on the completed state of the prior ones.

3. **Approve** — Use goal_approve_plan to submit the refined goal and task list for my approval. If I reject it, revise and resubmit.

4. **Execute** — Once approved, execute each task. Prefer spawning isolated subagents (fresh-context, worktree-isolated) per task so each one has a clean start. After each task, verify it yourself with a fresh, critical eye, then immediately call goal_update_task to mark it "completed". Do not move on to the next task before marking the current one done.

5. **Mark done** — After each task is complete, immediately call goal_update_task with taskId and status "completed". Do not procrastinate — mark it done right after verification.

6. **Complete** — When all tasks are marked done, call goal_complete with a summary. The system will spawn an isolated auditor deterministically. Do NOT try to spawn the auditor yourself — it is handled externally.

7. **Audit result** — goal_audit_result is AUDITOR-ONLY. You do not call it. The externally spawned auditor calls it directly. On rejection, fix the failing tasks (they will be reset to pending) and call goal_complete again. On approval, the goal is finalized.

The state file at .pi/goal/state.json is updated automatically. You can read it to track progress.`,
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
						pending: "○",
						approved: "◉",
						"in-progress": "→",
						completed: "✓",
						failed: "✗",
					};
					return `  ${icons[t.status] || "○"} ${t.description} — ${t.status}`;
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
			pi.sendUserMessage(
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
			ctx.ui.setWidget("pi-goal", undefined);
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
			ctx.ui.setWidget("pi-goal", undefined);
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
			ctx.ui.setWidget("pi-goal", undefined);
			ctx.ui.setStatus("pi-goal", "");
			ctx.ui.notify("Goal state cleared.", "info");
		},
	});
}