import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = join(EXTENSION_DIR, "sounds");
const RATINGS_FILE = join(EXTENSION_DIR, "ratings.json");

type SoundRatingStats = {
	plays: number;
	ratings: Record<"1" | "2" | "3" | "4" | "5", number>;
	history: Array<{ rating: 1 | 2 | 3 | 4 | 5; ratedAt: string }>;
};

type RatingsStore = {
	version: 1;
	sounds: Record<string, SoundRatingStats>;
};

function emptyRatingStats(): SoundRatingStats {
	return {
		plays: 0,
		ratings: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
		history: [],
	};
}

function loadRatings(): RatingsStore {
	try {
		if (!existsSync(RATINGS_FILE)) return { version: 1, sounds: {} };
		const parsed = JSON.parse(readFileSync(RATINGS_FILE, "utf8")) as RatingsStore;
		return parsed?.version === 1 && parsed.sounds ? parsed : { version: 1, sounds: {} };
	} catch {
		return { version: 1, sounds: {} };
	}
}

function saveRatings(store: RatingsStore): void {
	mkdirSync(dirname(RATINGS_FILE), { recursive: true });
	writeFileSync(RATINGS_FILE, `${JSON.stringify(store, null, 2)}\n`);
}

function statsFor(store: RatingsStore, soundName: string): SoundRatingStats {
	store.sounds[soundName] ??= emptyRatingStats();
	store.sounds[soundName].ratings ??= emptyRatingStats().ratings;
	store.sounds[soundName].history ??= [];
	store.sounds[soundName].plays ??= 0;
	return store.sounds[soundName];
}

function parseRating(raw: string): 1 | 2 | 3 | 4 | 5 | undefined {
	const match = raw.trim().match(/^[1-5]/);
	if (!match) return undefined;
	return Number(match[0]) as 1 | 2 | 3 | 4 | 5;
}

function loadSoundFiles(): string[] {
	try {
		return readdirSync(SOUNDS_DIR)
			.filter((file) => /\.(wav|mp3|aiff|m4a)$/i.test(file))
			.map((file) => join(SOUNDS_DIR, file));
	} catch {
		return [];
	}
}

function pickRandom<T>(items: T[]): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(Math.random() * items.length)];
}

function totalRatings(stats: SoundRatingStats): number {
	return Object.values(stats.ratings).reduce((sum, count) => sum + count, 0);
}

function ratingWeight(stats: SoundRatingStats): number {
	const total = totalRatings(stats);
	const weightedTotal =
		stats.ratings["1"] * 1 +
		stats.ratings["2"] * 2 +
		stats.ratings["3"] * 3 +
		stats.ratings["4"] * 4 +
		stats.ratings["5"] * 5;

	const priorMean = 3;
	const priorWeight = 2;
	const posteriorMean = (weightedTotal + priorMean * priorWeight) / (total + priorWeight);
	const meanFactor = posteriorMean / priorMean;
	const confidenceFactor = Math.min(1.5, 1 + total / 10);
	return Math.max(0.15, meanFactor * confidenceFactor);
}

function pickSoundByRatings(soundPaths: string[], store: RatingsStore): string | undefined {
	if (soundPaths.length === 0) return undefined;

	const entries = soundPaths.map((soundPath) => {
		const soundName = basename(soundPath);
		const stats = store.sounds[soundName] ?? emptyRatingStats();
		return { soundPath, weight: ratingWeight(stats) };
	});

	const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
	if (totalWeight <= 0) return pickRandom(soundPaths);

	let roll = Math.random() * totalWeight;
	for (const entry of entries) {
		roll -= entry.weight;
		if (roll <= 0) return entry.soundPath;
	}

	return entries[entries.length - 1]?.soundPath;
}

function averageRating(stats: SoundRatingStats): number | undefined {
	const total = totalRatings(stats);
	if (total === 0) return undefined;
	const weightedTotal =
		stats.ratings["1"] * 1 +
		stats.ratings["2"] * 2 +
		stats.ratings["3"] * 3 +
		stats.ratings["4"] * 4 +
		stats.ratings["5"] * 5;
	return weightedTotal / total;
}

function formatWeightsDebug(soundPaths: string[], store: RatingsStore): string {
	if (soundPaths.length === 0) return `No sounds found in ${SOUNDS_DIR}`;

	const rows = soundPaths
		.map((soundPath) => {
			const soundName = basename(soundPath);
			const stats = store.sounds[soundName] ?? emptyRatingStats();
			return {
				soundName,
				plays: stats.plays,
				totalRatings: totalRatings(stats),
				avgRating: averageRating(stats),
				weight: ratingWeight(stats),
				ratings: stats.ratings,
			};
		})
		.sort((a, b) => b.weight - a.weight || b.totalRatings - a.totalRatings || a.soundName.localeCompare(b.soundName));

	return rows
		.map((row, index) => {
			const avg = row.avgRating ? row.avgRating.toFixed(2) : "n/a";
			return `${String(index + 1).padStart(2, " ")}. ${row.soundName}\n    weight=${row.weight.toFixed(2)} avg=${avg} ratings=${row.totalRatings} plays=${row.plays} [1:${row.ratings["1"]} 2:${row.ratings["2"]} 3:${row.ratings["3"]} 4:${row.ratings["4"]} 5:${row.ratings["5"]}]`;
		})
		.join("\n");
}

function getAvailablePlayer(): string | undefined {
	const players = ["afplay", "paplay", "aplay", "ffplay"] as const;

	for (const cmd of players) {
		const lookup = spawnSync("which", [cmd], { stdio: "ignore" });
		if (lookup.status === 0) return cmd;
	}

	return undefined;
}

function playSound(player: string, path: string): void {
	const args =
		player === "ffplay"
			? ["-nodisp", "-autoexit", "-loglevel", "quiet", path]
			: [path];

	const child = spawn(player, args, {
		stdio: "ignore",
		detached: true,
	});
	child.unref();
}

function assistantFinishedWithText(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = (messages[i] as { role?: string; content?: unknown }) ?? {};
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

		return message.content.some((part) => {
			const contentPart = part as { type?: string; text?: unknown };
			return contentPart.type === "text" && typeof contentPart.text === "string" && contentPart.text.trim().length > 0;
		});
	}

	return false;
}

export default function announcerInputAlert(pi: ExtensionAPI) {
	const sounds = loadSoundFiles();
	const player = getAvailablePlayer();
	let lastPlayedSound: string | undefined;
	let pendingToolExecutions = 0;
	let pendingSound: NodeJS.Timeout | undefined;

	function cancelPendingSound(): void {
		if (!pendingSound) return;
		clearTimeout(pendingSound);
		pendingSound = undefined;
	}

	const commandUsage = [
		"Usage:",
		"  /announcer rate [1-5]",
		"  /announcer ratings",
		"  /announcer weights",
		"  /announcer help",
	].join("\n");

	pi.registerCommand("announcer", {
		description: "Manage announcer sounds (rate, ratings, weights)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const inlineRating = parseRating(trimmed);
			const [subcommandRaw, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const subcommand = (inlineRating ? "rate" : subcommandRaw ?? "help").toLowerCase();
			const subArgs = inlineRating ? String(inlineRating) : rest.join(" ").trim();

			if (subcommand === "rate") {
				if (!lastPlayedSound) {
					ctx.ui.notify("announcer-input-alert: no sound has played yet in this session", "warning");
					return;
				}

				let rating = parseRating(subArgs);
				if (!rating) {
					const choice = await ctx.ui.select(
						`Rate ${basename(lastPlayedSound)}:`,
						["★★★★★ 5", "★★★★☆ 4", "★★★☆☆ 3", "★★☆☆☆ 2", "★☆☆☆☆ 1"],
					);
					rating = choice ? parseRating(choice.slice(-1)) : undefined;
				}
				if (!rating) return;

				const store = loadRatings();
				const soundName = basename(lastPlayedSound);
				const stats = statsFor(store, soundName);
				stats.ratings[String(rating) as keyof SoundRatingStats["ratings"]]++;
				stats.history.push({ rating, ratedAt: new Date().toISOString() });
				saveRatings(store);
				ctx.ui.notify(`announcer-input-alert: rated ${soundName} ${rating}/5 (${stats.ratings[String(rating) as keyof SoundRatingStats["ratings"]]}x)`, "success");
				return;
			}

			if (subcommand === "ratings") {
				ctx.ui.notify(`announcer-input-alert ratings: ${RATINGS_FILE}`, "info");
				return;
			}

			if (subcommand === "weights") {
				const store = loadRatings();
				await ctx.ui.editor("announcer-input-alert weights", formatWeightsDebug(sounds, store));
				return;
			}

			if (subcommand === "help") {
				ctx.ui.notify(commandUsage, "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${subcommand}\n\n${commandUsage}`, "warning");
		},
	});

	pi.on("session_start", async () => {
		lastPlayedSound = undefined;
		pendingToolExecutions = 0;
		cancelPendingSound();
	});

	pi.on("agent_start", async () => {
		cancelPendingSound();
	});

	pi.on("tool_execution_start", async () => {
		cancelPendingSound();
		pendingToolExecutions++;
	});

	pi.on("tool_execution_end", async () => {
		pendingToolExecutions = Math.max(0, pendingToolExecutions - 1);
	});

	pi.on("session_shutdown", async () => {
		cancelPendingSound();
	});

	pi.on("agent_end", async (event, ctx) => {
		cancelPendingSound();
		if (!assistantFinishedWithText((event as { messages?: unknown }).messages)) return;

		pendingSound = setTimeout(() => {
			pendingSound = undefined;
			if (!ctx.isIdle() || ctx.hasPendingMessages() || pendingToolExecutions > 0) return;

			if (!player) {
				ctx.ui.notify("announcer-input-alert: no supported audio player found (afplay/paplay/aplay/ffplay)", "warning");
				return;
			}

			const store = loadRatings();
			const soundToPlay = pickSoundByRatings(sounds, store);
			if (!soundToPlay) {
				ctx.ui.notify(`announcer-input-alert: no sound files found in ${SOUNDS_DIR}`, "warning");
				return;
			}

			playSound(player, soundToPlay);
			lastPlayedSound = soundToPlay;
			const stats = statsFor(store, basename(soundToPlay));
			stats.plays++;
			saveRatings(store);
			ctx.ui.notify(`announcer-input-alert: played ${basename(soundToPlay)}. Rate it with /announcer rate 1-5`, "info");
		}, 2000);
	});
}
