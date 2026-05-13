import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const LAST_TURN_MESSAGE_TYPE = "footer-style-last-turn-summary";
const LAST_TURN_SUMMARY_DEBOUNCE_MS = 500;

type FooterPrefs = {
	showPathLine: boolean;
	showGitBranch: boolean;
	showSessionName: boolean;
	showCost: boolean;
	showContextUsage: boolean;
	showUtcTime: boolean;
	showModel: boolean;
	showThinking: boolean;
	showProviderWhenMultiple: boolean;
	showExtensionStatuses: boolean;
	showLastTurnContextBar: boolean;
};

// Tweak these defaults to match your style, then run /reload.
const prefs: FooterPrefs = {
	showPathLine: true,
	showGitBranch: true,
	showSessionName: false,
	showCost: true,
	showContextUsage: true,
	showUtcTime: true,
	showModel: true,
	showThinking: true,
	showProviderWhenMultiple: true,
	showExtensionStatuses: true,
	showLastTurnContextBar: true,
};

const inlineStatusIds = new Set<string>(["pi-stopwatch"]);

type UsageSummary = {
	input: number;
	cache: number;
	output: number;
	cost: number;
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatPercent(percent: number | null | undefined): string {
	if (percent === null || percent === undefined) return "?%";
	const fixed = percent.toFixed(1);
	return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}%` : `${fixed}%`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatUtcNow(): string {
	const now = new Date();
	const hh = String(now.getUTCHours()).padStart(2, "0");
	const mm = String(now.getUTCMinutes()).padStart(2, "0");
	const ss = String(now.getUTCSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss} UTC`;
}

function summarizeAssistantMessage(message: AssistantMessage): UsageSummary {
	return {
		input: message.usage.input,
		cache: message.usage.cacheRead + message.usage.cacheWrite,
		output: message.usage.output,
		cost: message.usage.cost.total,
	};
}

function getAccumulatedUsage(ctx: ExtensionContext): UsageSummary {
	const totals: UsageSummary = { input: 0, cache: 0, output: 0, cost: 0 };

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const summary = summarizeAssistantMessage(entry.message as AssistantMessage);
		totals.input += summary.input;
		totals.cache += summary.cache;
		totals.output += summary.output;
		totals.cost += summary.cost;
	}

	return totals;
}

function buildContextBar(summary: UsageSummary, width = 24): string {
	const total = summary.input + summary.cache + summary.output;
	if (total <= 0) return "";

	const segments = [
		{ icon: "🪙", value: summary.input },
		{ icon: "✨", value: summary.cache },
		{ icon: "💎", value: summary.output },
	].filter((segment) => segment.value > 0);

	let remainingWidth = width;
	let remainingTotal = total;
	let bar = "";

	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		let count: number;
		if (i === segments.length - 1) {
			count = remainingWidth;
		} else {
			count = Math.round((segment.value / remainingTotal) * remainingWidth);
			count = Math.max(1, Math.min(count, remainingWidth - (segments.length - i - 1)));
		}
		bar += segment.icon.repeat(count);
		remainingWidth -= count;
		remainingTotal -= segment.value;
	}

	return `[${bar}]`;
}

function buildLastTurnContent(summary: UsageSummary): string {
	const parts = [
		`+$${summary.cost.toFixed(3)}`,
		`+🪙 ${formatTokens(summary.input)}`,
		`+✨ ${formatTokens(summary.cache)}`,
		`+💎 ${formatTokens(summary.output)}`,
	];

	if (prefs.showLastTurnContextBar) {
		const bar = buildContextBar(summary);
		if (bar) parts.push(bar);
	}

	return parts.join("  •  ");
}

function zeroUsage(): UsageSummary {
	return { input: 0, cache: 0, output: 0, cost: 0 };
}

function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
	return {
		input: a.input + b.input,
		cache: a.cache + b.cache,
		output: a.output + b.output,
		cost: a.cost + b.cost,
	};
}

function hasUsage(summary: UsageSummary): boolean {
	return summary.input > 0 || summary.cache > 0 || summary.output > 0 || summary.cost > 0;
}

function subtractUsage(summary: UsageSummary, baseline: UsageSummary | undefined): UsageSummary {
	if (!baseline) return summary;
	return {
		input: Math.max(0, summary.input - baseline.input),
		cache: Math.max(0, summary.cache - baseline.cache),
		output: Math.max(0, summary.output - baseline.output),
		cost: Math.max(0, summary.cost - baseline.cost),
	};
}

function installCustomFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	isWorkingTokensModeEnabled: () => boolean,
	getWorkingUsage: () => UsageSummary | undefined,
	getWorkingUsageBaseline: () => UsageSummary | undefined,
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const clockInterval = setInterval(() => tui.requestRender(), 1000);

		return {
			dispose: () => {
				clearInterval(clockInterval);
				unsubscribe();
			},
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				const totals = getAccumulatedUsage(ctx);
				const shouldShowWorkingUsage = isWorkingTokensModeEnabled() && !ctx.isIdle();
				const workingUsage = shouldShowWorkingUsage ? getWorkingUsage() : undefined;
				const displayedTotals = shouldShowWorkingUsage
					? workingUsage && hasUsage(workingUsage)
						? workingUsage
						: subtractUsage(totals, getWorkingUsageBaseline())
					: totals;

				if (prefs.showPathLine) {
					let path = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && path.startsWith(home)) {
						path = `~${path.slice(home.length)}`;
					}

					if (prefs.showGitBranch) {
						const branch = footerData.getGitBranch();
						if (branch) path = `${path} (${branch})`;
					}

					if (prefs.showSessionName) {
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) path = `${path} • ${sessionName}`;
					}

					lines.push(theme.fg("dim", truncateToWidth(path, width, "...")));
				}

				const extensionStatuses = footerData.getExtensionStatuses();
				const inlineStatusText = prefs.showExtensionStatuses
					? Array.from(extensionStatuses.entries())
							.filter(([key]) => inlineStatusIds.has(key))
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ")
					: "";

				const leftParts: string[] = [];
				if (prefs.showCost) leftParts.push(`$${displayedTotals.cost.toFixed(3)}`);

				if (prefs.showContextUsage) {
					const usage = ctx.getContextUsage();
					const percent = usage?.percent;
					const percentText = formatPercent(percent);

					if (percent !== null && percent !== undefined && percent > 90) {
						leftParts.push(theme.fg("error", percentText));
					} else if (percent !== null && percent !== undefined && percent > 70) {
						leftParts.push(theme.fg("warning", percentText));
					} else {
						leftParts.push(percentText);
					}
				}

				leftParts.push(`🪙 ${formatTokens(displayedTotals.input)}`);
				leftParts.push(`✨ ${formatTokens(displayedTotals.cache)}`);
				leftParts.push(`💎 ${formatTokens(displayedTotals.output)}`);

				if (inlineStatusText) {
					leftParts.push(inlineStatusText);
				}

				let left = leftParts.join(" | ");
				if (!left) left = "ready";

				const rightParts: string[] = [];

				if (prefs.showUtcTime) {
					rightParts.push(formatUtcNow());
				}

				if (prefs.showModel) {
					const modelName = ctx.model?.id || "no-model";
					let modelText = modelName;

					if (prefs.showThinking && ctx.model?.reasoning) {
						const thinking = pi.getThinkingLevel();
						modelText = thinking === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinking}`;
					}

					if (prefs.showProviderWhenMultiple && footerData.getAvailableProviderCount() > 1 && ctx.model) {
						modelText = `(${ctx.model.provider}) ${modelText}`;
					}

					rightParts.push(modelText);
				}

				const right = rightParts.join(" • ");

				let statsLine: string;
				if (!right) {
					statsLine = truncateToWidth(left, width, "...");
				} else {
					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);
					if (leftWidth + 2 + rightWidth <= width) {
						const pad = " ".repeat(width - leftWidth - rightWidth);
						statsLine = `${left}${pad}${right}`;
					} else {
						const maxLeft = Math.max(0, width - 2 - rightWidth);
						if (maxLeft > 4) {
							const shortLeft = truncateToWidth(left, maxLeft, "...");
							const pad = " ".repeat(Math.max(2, width - visibleWidth(shortLeft) - rightWidth));
							statsLine = `${shortLeft}${pad}${right}`;
						} else {
							statsLine = truncateToWidth(left, width, "...");
						}
					}
				}

				lines.push(theme.fg("dim", statsLine));

				if (prefs.showExtensionStatuses && extensionStatuses.size > 0) {
					const statusText = Array.from(extensionStatuses.entries())
						.filter(([key]) => key !== "world" && !inlineStatusIds.has(key))
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ");
					if (statusText) {
						lines.push(truncateToWidth(theme.fg("dim", statusText), width, theme.fg("dim", "...")));
					}
				}

				return lines;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let workingTokensModeEnabled = true;
	let workingUsageBaseline: UsageSummary | undefined;
	let workingCompletedUsage = zeroUsage();
	let workingCurrentAssistantUsage: UsageSummary | undefined;
	let pendingToolExecutions = 0;
	let pendingSummaryTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingSummaries: UsageSummary[] = [];

	const cancelPendingSummaryTimer = (): void => {
		if (!pendingSummaryTimer) return;
		clearTimeout(pendingSummaryTimer);
		pendingSummaryTimer = undefined;
	};

	const flushPendingSummaries = async (ctx: ExtensionContext): Promise<void> => {
		pendingSummaryTimer = undefined;
		if (pendingSummaries.length === 0) return;

		if (!ctx.isIdle() || ctx.hasPendingMessages() || pendingToolExecutions > 0) {
			pendingSummaryTimer = setTimeout(() => {
				void flushPendingSummaries(ctx);
			}, LAST_TURN_SUMMARY_DEBOUNCE_MS);
			return;
		}

		while (pendingSummaries.length > 0) {
			const summary = pendingSummaries.shift();
			if (!summary) continue;

			await pi.sendMessage(
				{
					customType: LAST_TURN_MESSAGE_TYPE,
					content: buildLastTurnContent(summary),
					display: true,
					details: summary,
				},
				{ deliverAs: "followUp" },
			);
		}
	};

	const scheduleSummaryFlush = (ctx: ExtensionContext): void => {
		cancelPendingSummaryTimer();
		pendingSummaryTimer = setTimeout(() => {
			void flushPendingSummaries(ctx);
		}, LAST_TURN_SUMMARY_DEBOUNCE_MS);
	};

	pi.registerMessageRenderer(LAST_TURN_MESSAGE_TYPE, (message, _options, theme) => {
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("dim", String(message.content)), 0, 0));
		return box;
	});

	const getWorkingUsage = (): UsageSummary | undefined => {
		const usage = addUsage(workingCompletedUsage, workingCurrentAssistantUsage ?? zeroUsage());
		return hasUsage(usage) ? usage : undefined;
	};

	const resetWorkingUsage = (): void => {
		workingUsageBaseline = undefined;
		workingCompletedUsage = zeroUsage();
		workingCurrentAssistantUsage = undefined;
	};

	const applyUi = (ctx: ExtensionContext): void => {
		if (enabled) {
			installCustomFooter(pi, ctx, () => workingTokensModeEnabled, getWorkingUsage, () => workingUsageBaseline);
		} else {
			ctx.ui.setFooter(undefined);
		}
	};

	const applyWorkingTokensCommand = (cmd: string, ctx: ExtensionContext): void => {
		if (cmd === "on") {
			workingTokensModeEnabled = true;
			enabled = true;
		} else if (cmd === "off") {
			workingTokensModeEnabled = false;
		} else if (cmd === "status") {
			ctx.ui.notify(
				`footer working tokens ${workingTokensModeEnabled ? "on" : "off"}; footer-style ${enabled ? "on" : "off"}`,
				"info",
			);
			return;
		} else {
			workingTokensModeEnabled = !workingTokensModeEnabled;
			if (workingTokensModeEnabled) enabled = true;
		}

		applyUi(ctx);
		ctx.ui.notify(
			workingTokensModeEnabled
				? "footer working tokens enabled: cost/token counters show per-prompt accumulation while working"
				: "footer working tokens disabled",
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		resetWorkingUsage();
		pendingToolExecutions = 0;
		pendingSummaries.length = 0;
		cancelPendingSummaryTimer();
		applyUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetWorkingUsage();
		applyUi(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		workingUsageBaseline = getAccumulatedUsage(ctx);
		workingCompletedUsage = zeroUsage();
		workingCurrentAssistantUsage = undefined;
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		workingCurrentAssistantUsage = summarizeAssistantMessage(event.message as AssistantMessage);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		workingCompletedUsage = addUsage(workingCompletedUsage, summarizeAssistantMessage(event.message as AssistantMessage));
		workingCurrentAssistantUsage = undefined;
	});

	pi.on("tool_execution_start", async () => {
		pendingToolExecutions += 1;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		pendingToolExecutions = Math.max(0, pendingToolExecutions - 1);
		if (pendingSummaries.length > 0) scheduleSummaryFlush(ctx);
	});

	pi.on("session_shutdown", async () => {
		cancelPendingSummaryTimer();
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter(
				(message) => !(message.role === "custom" && message.customType === LAST_TURN_MESSAGE_TYPE),
			),
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const summary: UsageSummary = { input: 0, cache: 0, output: 0, cost: 0 };

		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			const messageSummary = summarizeAssistantMessage(message as AssistantMessage);
			summary.input += messageSummary.input;
			summary.cache += messageSummary.cache;
			summary.output += messageSummary.output;
			summary.cost += messageSummary.cost;
		}

		if (summary.input === 0 && summary.cache === 0 && summary.output === 0 && summary.cost === 0) return;

		pendingSummaries.push(summary);
		scheduleSummaryFlush(ctx);
	});

	pi.registerCommand("footer-style", {
		description: "Toggle custom footer style (on/off/toggle/status/bar on|off|toggle|status/tokens on|off|toggle|status)",
		handler: async (args, ctx) => {
			const cmd = (args || "toggle").trim().toLowerCase();

			if (cmd.startsWith("tokens") || cmd.startsWith("working-tokens")) {
				const tokenCmd = cmd.replace(/^(?:tokens|working-tokens)\s*/, "") || "toggle";
				applyWorkingTokensCommand(tokenCmd, ctx);
				return;
			}

			if (cmd.startsWith("bar")) {
				const barCmd = cmd.replace(/^bar\s*/, "") || "toggle";
				if (barCmd === "on") prefs.showLastTurnContextBar = true;
				else if (barCmd === "off") prefs.showLastTurnContextBar = false;
				else if (barCmd === "status") {
					ctx.ui.notify(`footer-style last-turn context bar is ${prefs.showLastTurnContextBar ? "on" : "off"}`, "info");
					return;
				} else prefs.showLastTurnContextBar = !prefs.showLastTurnContextBar;

				ctx.ui.notify(`footer-style last-turn context bar ${prefs.showLastTurnContextBar ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (cmd === "on") enabled = true;
			else if (cmd === "off") enabled = false;
			else if (cmd === "status") {
				ctx.ui.notify(
					`footer-style is ${enabled ? "on" : "off"}; working tokens ${workingTokensModeEnabled ? "on" : "off"}; last-turn context bar is ${prefs.showLastTurnContextBar ? "on" : "off"}`,
					"info",
				);
				return;
			} else enabled = !enabled;

			applyUi(ctx);
			ctx.ui.notify(`footer-style ${enabled ? "enabled" : "disabled"}; working tokens ${workingTokensModeEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("footer-tokens", {
		description: "Toggle per-prompt cost/token counters while the agent is working (on/off/toggle/status)",
		handler: async (args, ctx) => {
			const cmd = (args || "toggle").trim().toLowerCase();
			applyWorkingTokensCommand(cmd, ctx);
		},
	});
}
