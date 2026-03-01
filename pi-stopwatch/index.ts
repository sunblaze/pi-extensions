/**
 * pi-stopwatch
 *
 * Displays an elapsed time counter in the "Working..." message while the agent
 * is processing. Helpful for spotting network hangs or slow model responses.
 *
 * Example: "Working... (12s)"
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let startTime: number = 0;

	function stopTimer(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		ctx.ui.setWorkingMessage(); // Restore default "Working..."
	}

	function startTimer(ctx: ExtensionContext) {
		stopTimer(ctx);
		startTime = Date.now();

		// Update immediately so "0s" shows right away, then every second
		ctx.ui.setWorkingMessage(`Working... (0s)`);

		timer = setInterval(() => {
			const elapsed = formatElapsed(Date.now() - startTime);
			ctx.ui.setWorkingMessage(`Working... (${elapsed})`);
		}, 1000);
	}

	pi.on("agent_start", async (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer(ctx);
	});
}
