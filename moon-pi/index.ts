import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

const COMMAND_NAME = "moon-pi";
const NEXT_SUBCOMMAND = "next";
const BOOTSTRAP_MESSAGE_TYPE = "moon-pi-bootstrap";

const EPOCH_DIR_NAME = ".moon-pi";
const EPOCH_PLAN_FILE_NAME = "epoch-plan.md";
const EPOCH_STATE_FILE_NAME = "epoch.json";
const NEXT_CHUNK_DETAILS_MAX_CHARS = 1200;

interface EpochPaths {
	epochDirPath: string;
	epochPlanPath: string;
	epochStatePath: string;
}

interface EpochChunk {
	title: string;
	details?: string;
}

interface EpochState {
	doneChunks?: string[];
	completedChunks?: string[];
	chunkStatus?: Record<string, string | boolean>;
}

function getEpochPaths(cwd: string): EpochPaths {
	const epochDirPath = path.join(cwd, EPOCH_DIR_NAME);
	return {
		epochDirPath,
		epochPlanPath: path.join(epochDirPath, EPOCH_PLAN_FILE_NAME),
		epochStatePath: path.join(epochDirPath, EPOCH_STATE_FILE_NAME),
	};
}

function buildBootstrapSteps(paths: EpochPaths): string {
	return [
		"Moon Pi: EPOCH bootstrap",
		"",
		"No active EPOCH was detected and no EPOCH plan file exists yet.",
		"",
		"Steps to build an EPOCH:",
		"1. Define the objective in one short paragraph.",
		"2. Break the objective into 2-5 production-ready PR chunks.",
		"3. For each PR chunk, write scope, risks, and validation notes.",
		"4. Order PR chunks by dependency (what must land first).",
		"5. Add explicit human checkpoints before each PR starts.",
		`6. Save the EPOCH plan file at: ${paths.epochPlanPath}`,
		`7. Mark EPOCH active with a state file at: ${paths.epochStatePath}`,
		"",
		"After creating the plan file, run /moon-pi again.",
	].join("\n");
}

function toPromptPath(cwd: string, absolutePath: string): string {
	const relativePath = path.relative(cwd, absolutePath);
	if (!relativePath || relativePath.startsWith("..")) {
		return absolutePath;
	}
	return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function normalizeChunkKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikeChunk(label: string): boolean {
	return /\bchunk\b/i.test(label) || /^\s*pr\b/i.test(label) || /\bpull request\b/i.test(label);
}

function hasDoneMarker(label: string): boolean {
	if (/\bnot\s+done\b/i.test(label)) {
		return false;
	}
	return (
		/\[(?:x|X)\]/.test(label) ||
		/✅/.test(label) ||
		/\((?:done|complete|completed)\)/i.test(label) ||
		/(?:[-–—:]|^)\s*(?:done|complete|completed)\s*$/i.test(label)
	);
}

function cleanChunkTitle(label: string): string {
	return label
		.replace(/^\s*[-*]\s*\[(?: |x|X)\]\s*/, "")
		.replace(/^\s*\[(?: |x|X)\]\s*/, "")
		.replace(/✅/g, "")
		.replace(/\((?:done|complete|completed)\)/gi, "")
		.trim();
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trimEnd()}\n... (truncated)`;
}

function readEpochState(epochStatePath: string): EpochState | undefined {
	if (!fs.existsSync(epochStatePath)) {
		return undefined;
	}

	try {
		const raw = fs.readFileSync(epochStatePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as EpochState;
		}
	} catch {
		// Ignore malformed state and fall back to plan parsing.
	}

	return undefined;
}

function doneChunkKeysFromState(epochState: EpochState | undefined): Set<string> {
	const keys = new Set<string>();
	if (!epochState) {
		return keys;
	}

	for (const chunkName of epochState.doneChunks ?? []) {
		if (typeof chunkName === "string") {
			keys.add(normalizeChunkKey(chunkName));
		}
	}

	for (const chunkName of epochState.completedChunks ?? []) {
		if (typeof chunkName === "string") {
			keys.add(normalizeChunkKey(chunkName));
		}
	}

	for (const [chunkName, status] of Object.entries(epochState.chunkStatus ?? {})) {
		const isDone =
			status === true || (typeof status === "string" && /^(?:done|complete|completed)$/i.test(status.trim()));
		if (isDone) {
			keys.add(normalizeChunkKey(chunkName));
		}
	}

	return keys;
}

function findNextChunkFromHeadings(planContent: string, doneChunkKeys: Set<string>): EpochChunk | undefined {
	const lines = planContent.split(/\r?\n/);
	const headings: Array<{ lineNumber: number; level: number; label: string }> = [];

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
		if (!match) {
			continue;
		}

		headings.push({
			lineNumber: i,
			level: match[1].length,
			label: match[2].trim(),
		});
	}

	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i];
		if (!looksLikeChunk(heading.label)) {
			continue;
		}

		const title = cleanChunkTitle(heading.label);
		const normalizedTitle = normalizeChunkKey(title);
		const isDone = hasDoneMarker(heading.label) || doneChunkKeys.has(normalizedTitle);
		if (isDone) {
			continue;
		}

		let detailsEndLine = lines.length;
		for (let j = i + 1; j < headings.length; j++) {
			if (headings[j].level <= heading.level) {
				detailsEndLine = headings[j].lineNumber;
				break;
			}
		}

		const details = truncate(lines.slice(heading.lineNumber + 1, detailsEndLine).join("\n").trim(), NEXT_CHUNK_DETAILS_MAX_CHARS);
		return {
			title,
			details: details.length > 0 ? details : undefined,
		};
	}

	return undefined;
}

function findNextChunkFromTaskList(planContent: string, doneChunkKeys: Set<string>): EpochChunk | undefined {
	const lines = planContent.split(/\r?\n/);

	for (const line of lines) {
		const match = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/);
		if (!match) {
			continue;
		}

		const mark = match[1];
		const label = cleanChunkTitle(match[2]);
		if (!label || !looksLikeChunk(label)) {
			continue;
		}

		const normalizedLabel = normalizeChunkKey(label);
		const isDone = mark.toLowerCase() === "x" || hasDoneMarker(label) || doneChunkKeys.has(normalizedLabel);
		if (!isDone) {
			return { title: label };
		}
	}

	return undefined;
}

function findNextChunk(planContent: string, epochState: EpochState | undefined): EpochChunk | undefined {
	const doneChunkKeys = doneChunkKeysFromState(epochState);
	return findNextChunkFromHeadings(planContent, doneChunkKeys) ?? findNextChunkFromTaskList(planContent, doneChunkKeys);
}

function buildNextChunkKickoffPrompt(cwd: string, paths: EpochPaths, nextChunk: EpochChunk | undefined): string {
	const planPath = toPromptPath(cwd, paths.epochPlanPath);
	const lines = [
		`@${planPath}`,
		"",
		nextChunk
			? `Start working on this chunk only: ${nextChunk.title}`
			: "Start working on the next chunk in the EPOCH plan that is not marked done yet.",
	];

	if (nextChunk?.details) {
		lines.push("", "Chunk notes from the plan:", nextChunk.details);
	}

	lines.push(
		"",
		"Execution rules:",
		"- Work only on this single chunk.",
		"- Do not create a PR.",
		"- Do not stage, commit, or push git changes.",
		"- Implement the code changes needed for this chunk and run relevant validation.",
		"- When the chunk goals are complete, stop and wait.",
		"- Ask me to review the code changes in the current working directory before any commit or PR step.",
		"- In your handoff, include changed files, validation run, and any remaining risks.",
	);

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(BOOTSTRAP_MESSAGE_TYPE, (message, _options, theme) => {
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(String(message.content), 0, 0));
		return box;
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Bootstrap Moon Pi EPOCH workflow and start next chunk sessions",
		handler: async (args, ctx) => {
			const paths = getEpochPaths(ctx.cwd);
			const hasPlanFile = fs.existsSync(paths.epochPlanPath);
			const isOnEpoch = fs.existsSync(paths.epochStatePath);

			const trimmedArgs = args.trim();
			const [subcommand] = trimmedArgs.length > 0 ? trimmedArgs.split(/\s+/, 1) : [""];

			if (subcommand && subcommand.toLowerCase() !== NEXT_SUBCOMMAND) {
				const message = `Moon Pi: unknown subcommand \"${subcommand}\". Use /moon-pi or /moon-pi next.`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
					return;
				}

				await pi.sendMessage({
					customType: BOOTSTRAP_MESSAGE_TYPE,
					content: message,
					display: true,
				});
				return;
			}

			if (subcommand.toLowerCase() === NEXT_SUBCOMMAND) {
				if (!hasPlanFile) {
					const steps = buildBootstrapSteps(paths);
					await pi.sendMessage({
						customType: BOOTSTRAP_MESSAGE_TYPE,
						content: steps,
						display: true,
						details: paths,
					});
					if (ctx.hasUI) {
						ctx.ui.notify("Moon Pi: no EPOCH plan found. Posted bootstrap steps.", "info");
					}
					return;
				}

				const planContent = fs.readFileSync(paths.epochPlanPath, "utf8");
				const epochState = readEpochState(paths.epochStatePath);
				const nextChunk = findNextChunk(planContent, epochState);
				const kickoffPrompt = buildNextChunkKickoffPrompt(ctx.cwd, paths, nextChunk);

				if (!ctx.hasUI) {
					await pi.sendMessage({
						customType: BOOTSTRAP_MESSAGE_TYPE,
						content: kickoffPrompt,
						display: true,
						details: {
							paths,
							nextChunk,
						},
					});
					return;
				}

				const confirmText = [
					nextChunk
						? `Detected next unfinished chunk:\n${nextChunk.title}`
						: "Moon Pi could not confidently detect a single unfinished chunk in the plan.",
					isOnEpoch
						? ""
						: `Warning: active EPOCH state file was not found at ${paths.epochStatePath}. Continuing anyway.`,
					"",
					"Moon Pi will open a fresh session and prefill the kickoff prompt.",
				].join("\n");

				const confirmed = await ctx.ui.confirm("Moon Pi: start next chunk?", confirmText);
				if (!confirmed) {
					ctx.ui.notify("Moon Pi: cancelled.", "info");
					return;
				}

				const parentSession = ctx.sessionManager.getSessionFile();
				const newSessionResult = await ctx.newSession({
					...(parentSession ? { parentSession } : {}),
					withSession: async (replacementCtx) => {
						replacementCtx.ui.setEditorText(kickoffPrompt);
						replacementCtx.ui.notify(
							nextChunk
								? `Moon Pi: ready to work on \"${nextChunk.title}\". Review the prompt and press Enter when ready.`
								: "Moon Pi: ready to work on the next unfinished chunk. Review the prompt and press Enter when ready.",
							"info",
						);
					},
				});

				if (newSessionResult.cancelled) {
					ctx.ui.notify("Moon Pi: new session cancelled.", "info");
				}
				return;
			}

			if (!isOnEpoch && !hasPlanFile) {
				const steps = buildBootstrapSteps(paths);
				await pi.sendMessage({
					customType: BOOTSTRAP_MESSAGE_TYPE,
					content: steps,
					display: true,
					details: paths,
				});
				if (ctx.hasUI) {
					ctx.ui.notify("Moon Pi: no EPOCH detected. Posted bootstrap steps.", "info");
				}
				return;
			}

			const statusMessage = isOnEpoch
				? `Moon Pi: EPOCH is active (${paths.epochStatePath}). Run /moon-pi next to start the next unfinished chunk in a fresh session.`
				: `Moon Pi: EPOCH plan exists (${paths.epochPlanPath}), but EPOCH is not active yet. Create ${paths.epochStatePath}, then run /moon-pi next.`;

			if (ctx.hasUI) {
				ctx.ui.notify(statusMessage, "info");
				return;
			}

			await pi.sendMessage({
				customType: BOOTSTRAP_MESSAGE_TYPE,
				content: statusMessage,
				display: true,
			});
		},
	});
}
