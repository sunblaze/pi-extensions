import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	formatSkillsForPrompt,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "skill-gate";
const STATUS_ID = "skill-gate";
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", EXTENSION_NAME);
const DECISIONS_PATH = path.join(CONFIG_DIR, "decisions.json");
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_SOUND_PATH = path.resolve(EXTENSION_DIR, "..", "announcer-input-alert", "sounds", "prepare.wav");
const SKILLS_SECTION_START = "\n\nThe following skills provide specialized instructions for specific tasks.";
const SKILLS_SECTION_END = "</available_skills>";

type GlobalDecision = "allow" | "deny";
type EffectiveDecision = GlobalDecision | "session-allow";

type DecisionRecord = {
	decision: GlobalDecision;
	name: string;
	filePath: string;
	baseDir: string;
	description?: string;
	source?: string;
	scope?: string;
	updatedAt: string;
};

type SessionAllowRecord = {
	decision: "allow";
	name: string;
	filePath: string;
	baseDir: string;
	description?: string;
	source?: string;
	scope?: string;
	updatedAt: string;
};

type DecisionStore = {
	version: 1;
	decisions: Record<string, DecisionRecord>;
	sessionAllows: Record<string, Record<string, SessionAllowRecord>>;
};

type SkillSummary = {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	sourceInfo?: {
		source?: string;
		scope?: string;
		baseDir?: string;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function emptyStore(): DecisionStore {
	return { version: 1, decisions: {}, sessionAllows: {} };
}

function parseDecisionRecord(value: unknown): DecisionRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (value.decision !== "allow" && value.decision !== "deny") return undefined;
	if (typeof value.name !== "string" || typeof value.filePath !== "string") return undefined;

	return {
		decision: value.decision,
		name: value.name,
		filePath: value.filePath,
		baseDir: typeof value.baseDir === "string" ? value.baseDir : path.dirname(value.filePath),
		description: typeof value.description === "string" ? value.description : undefined,
		source: typeof value.source === "string" ? value.source : undefined,
		scope: typeof value.scope === "string" ? value.scope : undefined,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
	};
}

function parseSessionAllowRecord(value: unknown): SessionAllowRecord | undefined {
	const parsed = parseDecisionRecord(value);
	if (!parsed || parsed.decision !== "allow") return undefined;

	return {
		decision: "allow",
		name: parsed.name,
		filePath: parsed.filePath,
		baseDir: parsed.baseDir,
		description: parsed.description,
		source: parsed.source,
		scope: parsed.scope,
		updatedAt: parsed.updatedAt,
	};
}

function readDecisionStore(): DecisionStore {
	if (!fs.existsSync(DECISIONS_PATH)) return emptyStore();

	try {
		const parsed = JSON.parse(fs.readFileSync(DECISIONS_PATH, "utf8")) as unknown;
		if (!isRecord(parsed)) return emptyStore();

		const store = emptyStore();

		if (isRecord(parsed.decisions)) {
			for (const [key, value] of Object.entries(parsed.decisions)) {
				const record = parseDecisionRecord(value);
				if (record) store.decisions[key] = record;
			}
		}

		if (isRecord(parsed.sessionAllows)) {
			for (const [sessionId, sessionValue] of Object.entries(parsed.sessionAllows)) {
				if (!isRecord(sessionValue)) continue;
				const sessionRecords: Record<string, SessionAllowRecord> = {};
				for (const [key, value] of Object.entries(sessionValue)) {
					const record = parseSessionAllowRecord(value);
					if (record) sessionRecords[key] = record;
				}
				if (Object.keys(sessionRecords).length > 0) store.sessionAllows[sessionId] = sessionRecords;
			}
		}

		return store;
	} catch {
		return emptyStore();
	}
}

function writeDecisionStore(store: DecisionStore, ctx?: ExtensionContext): void {
	try {
		fs.mkdirSync(CONFIG_DIR, { recursive: true });
		const tempPath = `${DECISIONS_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tempPath, DECISIONS_PATH);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx?.ui.notify(`skill-gate: failed to save decisions: ${message}`, "error");
	}
}

function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function normalizePathInput(rawPath: string, cwd: string): string {
	let value = stripWrappingQuotes(rawPath.trim());
	if (value.startsWith("@")) value = value.slice(1).trim();
	if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
	return path.resolve(cwd, value);
}

function canonicalPath(filePath: string): string {
	const absolute = path.resolve(filePath);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function skillKey(skill: SkillSummary): string {
	return canonicalPath(skill.filePath);
}

function commandSkillName(text: string): string | undefined {
	const match = text.match(/^\/skill:([^\s]+)(?:\s|$)/);
	return match?.[1];
}

function normalizeSkillNameArg(value: string): string {
	return stripWrappingQuotes(value.trim()).replace(/^\/?skill:/, "");
}

function toSkillSummary(skill: Skill): SkillSummary {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		disableModelInvocation: skill.disableModelInvocation,
		sourceInfo: skill.sourceInfo,
	};
}

function sourceLabel(skill: SkillSummary): string {
	const parts = [skill.sourceInfo?.scope, skill.sourceInfo?.source].filter(Boolean);
	return parts.length > 0 ? parts.join("/") : "unknown";
}

function decisionToSkillSummary(record: DecisionRecord): SkillSummary {
	return {
		name: record.name,
		description: record.description ?? "",
		filePath: record.filePath,
		baseDir: record.baseDir,
		sourceInfo: {
			source: record.source,
			scope: record.scope,
		},
	};
}

function sessionAllowToSkillSummary(record: SessionAllowRecord): SkillSummary {
	return {
		name: record.name,
		description: record.description ?? "",
		filePath: record.filePath,
		baseDir: record.baseDir,
		sourceInfo: {
			source: record.source,
			scope: record.scope,
		},
	};
}

function replaceSkillsSection(systemPrompt: string, skills: Skill[]): string {
	const start = systemPrompt.indexOf(SKILLS_SECTION_START);
	if (start === -1) return systemPrompt;

	const endTagStart = systemPrompt.indexOf(SKILLS_SECTION_END, start);
	if (endTagStart === -1) return systemPrompt;

	const end = endTagStart + SKILLS_SECTION_END.length;
	return `${systemPrompt.slice(0, start)}${formatSkillsForPrompt(skills)}${systemPrompt.slice(end)}`;
}

function getAvailablePlayer(): string | undefined {
	const players = ["afplay", "paplay", "aplay", "ffplay"] as const;

	for (const command of players) {
		const lookup = spawnSync("which", [command], { stdio: "ignore" });
		if (lookup.status === 0) return command;
	}

	return undefined;
}

function playPromptSound(player: string | undefined): void {
	if (!player || !fs.existsSync(PROMPT_SOUND_PATH)) return;

	const args = player === "ffplay"
		? ["-nodisp", "-autoexit", "-loglevel", "quiet", PROMPT_SOUND_PATH]
		: [PROMPT_SOUND_PATH];

	const child = spawn(player, args, {
		stdio: "ignore",
		detached: true,
	});
	child.unref();
}

export default function (pi: ExtensionAPI) {
	const decisions = readDecisionStore();
	const promptSoundPlayer = getAvailablePlayer();
	let currentSkills: SkillSummary[] = [];
	let skillsByName = new Map<string, SkillSummary>();
	let skillsByFileKey = new Map<string, SkillSummary>();

	function syncSkills(skills: readonly SkillSummary[]): void {
		const deduped = new Map<string, SkillSummary>();

		for (const skill of skills) {
			const normalized: SkillSummary = {
				...skill,
				filePath: path.resolve(skill.filePath),
				baseDir: skill.baseDir ? path.resolve(skill.baseDir) : path.dirname(path.resolve(skill.filePath)),
			};
			deduped.set(skillKey(normalized), normalized);
		}

		currentSkills = Array.from(deduped.values());
		skillsByName = new Map(currentSkills.map((skill) => [skill.name, skill]));
		skillsByFileKey = new Map(currentSkills.map((skill) => [skillKey(skill), skill]));
	}

	function syncSkillsFromCommands(): void {
		try {
			const commandSkills = pi
				.getCommands()
				.filter((command) => command.source === "skill")
				.map((command): SkillSummary => {
					const filePath = command.sourceInfo.path;
					return {
						name: command.name.replace(/^skill:/, ""),
						description: command.description ?? "",
						filePath,
						baseDir: command.sourceInfo.baseDir ?? path.dirname(filePath),
						sourceInfo: command.sourceInfo,
					};
				});

			if (commandSkills.length > 0) syncSkills(commandSkills);
		} catch {
			// Commands are unavailable during very early startup. Later hooks resync.
		}
	}

	function sessionId(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId();
	}

	function sessionAllowsFor(ctx: ExtensionContext): Record<string, SessionAllowRecord> {
		const id = sessionId(ctx);
		decisions.sessionAllows[id] ??= {};
		return decisions.sessionAllows[id];
	}

	function getGlobalDecision(skill: SkillSummary): GlobalDecision | undefined {
		return decisions.decisions[skillKey(skill)]?.decision;
	}

	function hasSessionAllow(ctx: ExtensionContext, skill: SkillSummary): boolean {
		return sessionAllowsFor(ctx)[skillKey(skill)]?.decision === "allow";
	}

	function getEffectiveDecision(ctx: ExtensionContext, skill: SkillSummary): EffectiveDecision | undefined {
		const globalDecision = getGlobalDecision(skill);
		if (globalDecision) return globalDecision;
		if (hasSessionAllow(ctx, skill)) return "session-allow";
		return undefined;
	}

	function setGlobalDecision(skill: SkillSummary, decision: GlobalDecision, ctx?: ExtensionContext): void {
		decisions.decisions[skillKey(skill)] = {
			decision,
			name: skill.name,
			filePath: path.resolve(skill.filePath),
			baseDir: path.resolve(skill.baseDir),
			description: skill.description,
			source: skill.sourceInfo?.source,
			scope: skill.sourceInfo?.scope,
			updatedAt: new Date().toISOString(),
		};

		if (ctx && decision === "deny") {
			delete sessionAllowsFor(ctx)[skillKey(skill)];
		}

		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function setSessionAllow(skill: SkillSummary, ctx: ExtensionContext): void {
		sessionAllowsFor(ctx)[skillKey(skill)] = {
			decision: "allow",
			name: skill.name,
			filePath: path.resolve(skill.filePath),
			baseDir: path.resolve(skill.baseDir),
			description: skill.description,
			source: skill.sourceInfo?.source,
			scope: skill.sourceInfo?.scope,
			updatedAt: new Date().toISOString(),
		};
		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function forgetDecision(skill: SkillSummary, ctx?: ExtensionContext): void {
		delete decisions.decisions[skillKey(skill)];
		if (ctx) delete sessionAllowsFor(ctx)[skillKey(skill)];
		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function resetAllDecisions(ctx: ExtensionContext): void {
		for (const key of Object.keys(decisions.decisions)) delete decisions.decisions[key];
		for (const key of Object.keys(decisions.sessionAllows)) delete decisions.sessionAllows[key];
		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function updateStatus(ctx?: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	function findSkillByArg(rawArg: string, ctx: ExtensionContext): SkillSummary | undefined {
		const arg = rawArg.trim();
		if (!arg) return undefined;

		const normalizedName = normalizeSkillNameArg(arg);
		const byName = skillsByName.get(normalizedName);
		if (byName) return byName;

		const staleGlobalByName = Object.values(decisions.decisions).find((record) => record.name === normalizedName);
		if (staleGlobalByName) return decisionToSkillSummary(staleGlobalByName);

		const staleSessionByName = Object.values(sessionAllowsFor(ctx)).find((record) => record.name === normalizedName);
		if (staleSessionByName) return sessionAllowToSkillSummary(staleSessionByName);

		const key = canonicalPath(normalizePathInput(arg, ctx.cwd));
		return skillsByFileKey.get(key)
			?? (decisions.decisions[key] ? decisionToSkillSummary(decisions.decisions[key]) : undefined)
			?? (sessionAllowsFor(ctx)[key] ? sessionAllowToSkillSummary(sessionAllowsFor(ctx)[key]) : undefined);
	}

	function findSkillByReadPath(rawPath: string, cwd: string): SkillSummary | undefined {
		const key = canonicalPath(normalizePathInput(rawPath, cwd));
		return skillsByFileKey.get(key);
	}

	async function promptForDecision(ctx: ExtensionContext, skill: SkillSummary, trigger: string): Promise<EffectiveDecision | undefined> {
		if (!ctx.hasUI) return undefined;

		const description = skill.description.trim() || "(no description)";
		playPromptSound(promptSoundPlayer);
		const choice = await ctx.ui.select(
			[
				`Skill gate: ${skill.name}`,
				`Trigger: ${trigger}`,
				`Location: ${skill.filePath}`,
				`Source: ${sourceLabel(skill)}`,
				`Session: ${sessionId(ctx)}`,
				"",
				"Description:",
				description,
				"",
				"Choose how long this skill may run.",
			].join("\n"),
			["Allow for this session", "Always allow", "Always deny"],
		);

		if (!choice) return undefined;

		if (choice === "Allow for this session") {
			setSessionAllow(skill, ctx);
			ctx.ui.notify(`skill-gate: ${skill.name} allowed for this session.`, "info");
			return "session-allow";
		}

		const decision: GlobalDecision = choice === "Always allow" ? "allow" : "deny";
		setGlobalDecision(skill, decision, ctx);
		ctx.ui.notify(`skill-gate: ${skill.name} set to ${decision}.`, decision === "allow" ? "info" : "warning");
		return decision;
	}

	async function decisionForUse(ctx: ExtensionContext, skill: SkillSummary, trigger: string): Promise<EffectiveDecision | undefined> {
		const existing = getEffectiveDecision(ctx, skill);
		if (existing) return existing;
		return promptForDecision(ctx, skill, trigger);
	}

	function decisionLabel(ctx: ExtensionContext, skill: SkillSummary): string {
		const decision = getEffectiveDecision(ctx, skill);
		if (decision === "allow") return "allow";
		if (decision === "deny") return "deny";
		if (decision === "session-allow") return "session";
		return "prompt";
	}

	function decisionListText(ctx: ExtensionContext): string {
		const lines: string[] = [
			`Skill gate decisions: ${DECISIONS_PATH}`,
			`Current session: ${sessionId(ctx)}`,
			"",
			"Current skills:",
		];

		if (currentSkills.length === 0) {
			lines.push("  (no skills discovered yet)");
		} else {
			for (const skill of currentSkills.sort((a, b) => a.name.localeCompare(b.name))) {
				lines.push(`  ${decisionLabel(ctx, skill).padEnd(7)} ${skill.name}`);
				lines.push(`          ${skill.filePath}`);
			}
		}

		const currentKeys = new Set(currentSkills.map(skillKey));
		const staleRecords = Object.entries(decisions.decisions).filter(([key]) => !currentKeys.has(key));
		if (staleRecords.length > 0) {
			lines.push("", "Stored always decisions for skills not currently loaded:");
			for (const [, record] of staleRecords.sort((a, b) => a[1].name.localeCompare(b[1].name))) {
				lines.push(`  ${record.decision.padEnd(7)} ${record.name}`);
				lines.push(`          ${record.filePath}`);
			}
		}

		const staleSessionRecords = Object.entries(sessionAllowsFor(ctx)).filter(([key]) => !currentKeys.has(key));
		if (staleSessionRecords.length > 0) {
			lines.push("", "Stored session allows for skills not currently loaded:");
			for (const [, record] of staleSessionRecords.sort((a, b) => a[1].name.localeCompare(b[1].name))) {
				lines.push(`  session ${record.name}`);
				lines.push(`          ${record.filePath}`);
			}
		}

		lines.push(
			"",
			"Commands:",
			"  /skill-gate allow-session <skill>",
			"  /skill-gate allow <skill>",
			"  /skill-gate deny <skill>",
			"  /skill-gate forget <skill>",
			"  /skill-gate reset",
		);

		return lines.join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		syncSkillsFromCommands();
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const skills = event.systemPromptOptions.skills ?? [];
		syncSkills(skills.map(toSkillSummary));
		updateStatus(ctx);

		const filteredSkills = skills.filter((skill) => getGlobalDecision(toSkillSummary(skill)) !== "deny");
		if (filteredSkills.length === skills.length) return;

		return {
			systemPrompt: replaceSkillsSection(event.systemPrompt, filteredSkills),
		};
	});

	pi.on("input", async (event, ctx) => {
		const skillName = commandSkillName(event.text);
		if (!skillName) return { action: "continue" };

		syncSkillsFromCommands();
		const skill = skillsByName.get(skillName);
		if (!skill) return { action: "continue" };

		const decision = await decisionForUse(ctx, skill, "/skill command");
		if (decision === "allow" || decision === "session-allow") return { action: "continue" };

		const reason = decision === "deny" ? `Denied skill ${skill.name}.` : `Skill ${skill.name} requires approval, but no decision was made.`;
		ctx.ui.notify(`skill-gate: ${reason}`, "warning");
		return { action: "handled" };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return undefined;

		syncSkillsFromCommands();
		const skill = findSkillByReadPath(event.input.path, ctx.cwd);
		if (!skill) return undefined;

		const decision = await decisionForUse(ctx, skill, "read tool");
		if (decision === "allow" || decision === "session-allow") return undefined;

		const reason = decision === "deny"
			? `Skill ${skill.name} denied by skill-gate`
			: `Skill ${skill.name} requires approval, but no UI decision was made`;
		return { block: true, reason };
	});

	pi.registerCommand("skill-gate", {
		description: "Manage skill gate allow/deny decisions",
		handler: async (args, ctx) => {
			syncSkills((ctx.getSystemPromptOptions().skills ?? []).map(toSkillSummary));
			updateStatus(ctx);

			const trimmed = args.trim();
			const [subcommandRaw, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const subcommand = (subcommandRaw ?? "list").toLowerCase();
			const targetArg = rest.join(" ").trim();

			if (subcommand === "list" || subcommand === "status" || subcommand === "help") {
				await ctx.ui.editor("Skill gate", decisionListText(ctx));
				return;
			}

			if (subcommand === "reset") {
				const ok = await ctx.ui.confirm("Reset skill gate decisions?", `Delete all always and session-scoped decisions in ${DECISIONS_PATH}?`);
				if (!ok) return;
				resetAllDecisions(ctx);
				ctx.ui.notify("skill-gate: all decisions cleared.", "info");
				return;
			}

			const skill = findSkillByArg(targetArg, ctx);
			if (!skill) {
				ctx.ui.notify(
					"Usage: /skill-gate <allow-session|allow|deny|forget> <skill-name-or-path>\nRun /skill-gate list to see current skills.",
					"warning",
				);
				return;
			}

			if (subcommand === "allow-session" || subcommand === "session" || subcommand === "allow-for-session") {
				setSessionAllow(skill, ctx);
				ctx.ui.notify(`skill-gate: ${skill.name} allowed for this session.`, "info");
				return;
			}

			if (subcommand === "allow" || subcommand === "approve") {
				setGlobalDecision(skill, "allow", ctx);
				ctx.ui.notify(`skill-gate: ${skill.name} set to allow.`, "info");
				return;
			}

			if (subcommand === "deny" || subcommand === "block") {
				setGlobalDecision(skill, "deny", ctx);
				ctx.ui.notify(`skill-gate: ${skill.name} set to deny.`, "warning");
				return;
			}

			if (subcommand === "forget" || subcommand === "clear") {
				forgetDecision(skill, ctx);
				ctx.ui.notify(`skill-gate: forgot decisions for ${skill.name}.`, "info");
				return;
			}

			ctx.ui.notify("Usage: /skill-gate [list|allow-session|allow|deny|forget|reset]", "warning");
		},
	});
}
