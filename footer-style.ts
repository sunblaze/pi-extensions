import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const LAST_TURN_MESSAGE_TYPE = "footer-style-last-turn-summary";

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

function buildLastTurnContent(summary: UsageSummary): string {
	return [
		`+$${summary.cost.toFixed(3)}`,
		`+🪙 ${formatTokens(summary.input)}`,
		`+✨ ${formatTokens(summary.cache)}`,
		`+💎 ${formatTokens(summary.output)}`,
	].join("  •  ");
}

function installCustomFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
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

				const totals = getAccumulatedUsage(ctx);
				const extensionStatuses = footerData.getExtensionStatuses();
				const inlineStatusText = prefs.showExtensionStatuses
					? Array.from(extensionStatuses.entries())
							.filter(([key]) => inlineStatusIds.has(key))
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ")
					: "";

				const leftParts: string[] = [];
				if (prefs.showCost) leftParts.push(`$${totals.cost.toFixed(3)}`);

				if (prefs.showContextUsage) {
					const usage = ctx.getContextUsage();
					const percent = usage?.percent;
					const percentText = `${formatPercent(percent)} ctx`;

					if (percent !== null && percent !== undefined && percent > 90) {
						leftParts.push(theme.fg("error", percentText));
					} else if (percent !== null && percent !== undefined && percent > 70) {
						leftParts.push(theme.fg("warning", percentText));
					} else {
						leftParts.push(percentText);
					}
				}

				leftParts.push(`🪙 ${formatTokens(totals.input)}`);
				leftParts.push(`✨ ${formatTokens(totals.cache)}`);
				leftParts.push(`💎 ${formatTokens(totals.output)}`);

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

	pi.registerMessageRenderer(LAST_TURN_MESSAGE_TYPE, (message, _options, theme) => {
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("dim", String(message.content)), 0, 0));
		return box;
	});

	const applyUi = (ctx: ExtensionContext): void => {
		if (enabled) {
			installCustomFooter(pi, ctx);
		} else {
			ctx.ui.setFooter(undefined);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		applyUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		applyUi(ctx);
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter(
				(message) => !(message.role === "custom" && message.customType === LAST_TURN_MESSAGE_TYPE),
			),
		};
	});

	pi.on("agent_end", async (event) => {
		for (let i = event.messages.length - 1; i >= 0; i -= 1) {
			const message = event.messages[i];
			if (message.role !== "assistant") continue;
			const summary = summarizeAssistantMessage(message as AssistantMessage);
			await pi.sendMessage({
				customType: LAST_TURN_MESSAGE_TYPE,
				content: buildLastTurnContent(summary),
				display: true,
				details: summary,
			});
			break;
		}
	});

	pi.registerCommand("footer-style", {
		description: "Toggle custom footer style (on/off/toggle/status)",
		handler: async (args, ctx) => {
			const cmd = (args || "toggle").trim().toLowerCase();

			if (cmd === "on") enabled = true;
			else if (cmd === "off") enabled = false;
			else if (cmd === "status") {
				ctx.ui.notify(`footer-style is ${enabled ? "on" : "off"}`, "info");
				return;
			} else enabled = !enabled;

			applyUi(ctx);
			ctx.ui.notify(`footer-style ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
