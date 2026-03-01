import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type FooterPrefs = {
	showPathLine: boolean;
	showGitBranch: boolean;
	showSessionName: boolean;
	showInputTokens: boolean;
	showOutputTokens: boolean;
	showCacheRead: boolean;
	showCacheWrite: boolean;
	showCost: boolean;
	showContextUsage: boolean;
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
	showInputTokens: false,
	showOutputTokens: false,
	showCacheRead: false,
	showCacheWrite: false,
	showCost: true,
	showContextUsage: true,
	showModel: true,
	showThinking: true,
	showProviderWhenMultiple: true,
	showExtensionStatuses: true,
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function installCustomFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubscribe,
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

				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let totalCost = 0;

				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const m = entry.message as AssistantMessage;
						input += m.usage.input;
						output += m.usage.output;
						cacheRead += m.usage.cacheRead;
						cacheWrite += m.usage.cacheWrite;
						totalCost += m.usage.cost.total;
					}
				}

				const leftParts: string[] = [];
				if (prefs.showInputTokens && input) leftParts.push(`↑${formatTokens(input)}`);
				if (prefs.showOutputTokens && output) leftParts.push(`↓${formatTokens(output)}`);
				if (prefs.showCacheRead && cacheRead) leftParts.push(`R${formatTokens(cacheRead)}`);
				if (prefs.showCacheWrite && cacheWrite) leftParts.push(`W${formatTokens(cacheWrite)}`);
				if (prefs.showCost && totalCost) leftParts.push(`$${totalCost.toFixed(3)}`);

				if (prefs.showContextUsage) {
					const usage = ctx.getContextUsage();
					const contextTokens = usage?.tokens;
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = usage?.percent;
					const percentText = percent === null || percent === undefined ? "?%" : `${percent.toFixed(1)}%`;

					const usedText =
						contextTokens === null || contextTokens === undefined ? "?" : formatTokens(contextTokens);
					const windowText = contextWindow > 0 ? formatTokens(contextWindow) : "?";
					const usageText = `${usedText}/${windowText}`;

					if (percent !== null && percent !== undefined && percent > 90) {
						leftParts.push(theme.fg("error", percentText));
					} else if (percent !== null && percent !== undefined && percent > 70) {
						leftParts.push(theme.fg("warning", percentText));
					} else {
						leftParts.push(percentText);
					}

					leftParts.push(usageText);
				}

				let left = leftParts.join(" ");
				if (!left) left = "ready";

				let right = "";
				if (prefs.showModel) {
					const modelName = ctx.model?.id || "no-model";
					right = modelName;

					if (prefs.showThinking && ctx.model?.reasoning) {
						const thinking = pi.getThinkingLevel();
						right = thinking === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinking}`;
					}

					if (prefs.showProviderWhenMultiple && footerData.getAvailableProviderCount() > 1 && ctx.model) {
						right = `(${ctx.model.provider}) ${right}`;
					}
				}

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

				if (prefs.showExtensionStatuses) {
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusText = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
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

	const applyFooter = (ctx: ExtensionContext): void => {
		if (enabled) {
			installCustomFooter(pi, ctx);
		} else {
			ctx.ui.setFooter(undefined);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		applyFooter(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		applyFooter(ctx);
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

			applyFooter(ctx);
			ctx.ui.notify(`footer-style ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
