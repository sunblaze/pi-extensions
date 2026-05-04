/**
 * pi-stopwatch
 *
 * Displays an elapsed time counter in the "Working..." message while the agent
 * is processing. Helpful for spotting network hangs or slow model responses.
 *
 * Also tracks total agent working time for the current session and displays it
 * in the footer via an extension status. Idle time while waiting for user input
 * is not counted.
 *
 * Examples:
 * - Current run: "Working... (12s)"
 * - Footer total: "⏱ work 4m 32s"
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_ID = "pi-stopwatch";
const STATE_ENTRY_TYPE = "pi-stopwatch-state";

interface StopwatchStateEntry {
	totalWorkingMs?: unknown;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let runStartTime: number | null = null;
	let totalWorkingMs = 0;

	function currentTotalWorkingMs(now = Date.now()): number {
		if (runStartTime === null) return totalWorkingMs;
		return totalWorkingMs + now - runStartTime;
	}

	function clearTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function updateFooterStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_ID, `⏱ work ${formatElapsed(currentTotalWorkingMs())}`);
	}

	function updateWorkingMessage(ctx: ExtensionContext) {
		if (!ctx.hasUI || runStartTime === null) return;
		const elapsed = formatElapsed(Date.now() - runStartTime);
		ctx.ui.setWorkingMessage(`Working... (${elapsed})`);
	}

	function updateDisplays(ctx: ExtensionContext) {
		updateWorkingMessage(ctx);
		updateFooterStatus(ctx);
	}

	function persistState() {
		pi.appendEntry(STATE_ENTRY_TYPE, { totalWorkingMs });
	}

	function restoreState(ctx: ExtensionContext) {
		clearTimer();
		runStartTime = null;
		totalWorkingMs = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;

			const data = entry.data as StopwatchStateEntry | undefined;
			if (typeof data?.totalWorkingMs === "number") {
				totalWorkingMs = data.totalWorkingMs;
			}
		}

		updateFooterStatus(ctx);
	}

	function finalizeActiveRun() {
		if (runStartTime === null) return;
		totalWorkingMs += Date.now() - runStartTime;
		runStartTime = null;
	}

	function stopTimer(ctx: ExtensionContext, options: { clearStatus?: boolean; persist?: boolean } = {}) {
		finalizeActiveRun();
		clearTimer();

		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage(); // Restore default "Working..."
			if (options.clearStatus) {
				ctx.ui.setStatus(STATUS_ID, undefined);
			} else {
				updateFooterStatus(ctx);
			}
		}

		if (options.persist) {
			persistState();
		}
	}

	function startTimer(ctx: ExtensionContext) {
		stopTimer(ctx);
		runStartTime = Date.now();

		// Update immediately so "0s" shows right away, then every second.
		updateDisplays(ctx);

		timer = setInterval(() => {
			updateDisplays(ctx);
		}, 1000);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer(ctx, { persist: true });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer(ctx, { clearStatus: true });
	});
}
