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
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DECISION_LABEL_WIDTH = 14;

type GlobalDecision = "allow" | "deny";
type SessionDecision = "allow" | "deny";
type EffectiveDecision = GlobalDecision | "session-allow" | "session-deny";

type DecisionRecord = {
	decision: GlobalDecision;
	name: string;
	filePath: string;
	baseDir: string;
	description?: string;
	source?: string;
	scope?: string;
	updatedAt: string;
	expiresAt?: string;
};

type SessionDecisionRecord = {
	decision: SessionDecision;
	name: string;
	filePath: string;
	baseDir: string;
	description?: string;
	source?: string;
	scope?: string;
	updatedAt: string;
};

type DecisionStore = {
	version: 2;
	decisions: Record<string, DecisionRecord>;
	sessionAllows: Record<string, Record<string, SessionDecisionRecord>>;
	sessionDenies: Record<string, Record<string, SessionDecisionRecord>>;
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
	return { version: 2, decisions: {}, sessionAllows: {}, sessionDenies: {} };
}

function parseExpiresAt(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
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
		expiresAt: parseExpiresAt(value.expiresAt),
	};
}

function parseSessionDecisionRecord(value: unknown, expectedDecision: SessionDecision): SessionDecisionRecord | undefined {
	const parsed = parseDecisionRecord(value);
	if (!parsed || parsed.decision !== expectedDecision) return undefined;

	return {
		decision: expectedDecision,
		name: parsed.name,
		filePath: parsed.filePath,
		baseDir: parsed.baseDir,
		description: parsed.description,
		source: parsed.source,
		scope: parsed.scope,
		updatedAt: parsed.updatedAt,
	};
}

function isExpired(record: DecisionRecord): boolean {
	if (!record.expiresAt) return false;
	const timestamp = Date.parse(record.expiresAt);
	return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function oneWeekFromNow(): string {
	return new Date(Date.now() + ONE_WEEK_MS).toISOString();
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
				const sessionRecords: Record<string, SessionDecisionRecord> = {};
				for (const [key, value] of Object.entries(sessionValue)) {
					const record = parseSessionDecisionRecord(value, "allow");
					if (record) sessionRecords[key] = record;
				}
				if (Object.keys(sessionRecords).length > 0) store.sessionAllows[sessionId] = sessionRecords;
			}
		}

		if (isRecord(parsed.sessionDenies)) {
			for (const [sessionId, sessionValue] of Object.entries(parsed.sessionDenies)) {
				if (!isRecord(sessionValue)) continue;
				const sessionRecords: Record<string, SessionDecisionRecord> = {};
				for (const [key, value] of Object.entries(sessionValue)) {
					const record = parseSessionDecisionRecord(value, "deny");
					if (record) sessionRecords[key] = record;
				}
				if (Object.keys(sessionRecords).length > 0) store.sessionDenies[sessionId] = sessionRecords;
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

function sessionDecisionToSkillSummary(record: SessionDecisionRecord): SkillSummary {
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

	function sessionAllowsFor(ctx: ExtensionContext): Record<string, SessionDecisionRecord> {
		const id = sessionId(ctx);
		decisions.sessionAllows[id] ??= {};
		return decisions.sessionAllows[id];
	}

	function sessionDeniesFor(ctx: ExtensionContext): Record<string, SessionDecisionRecord> {
		const id = sessionId(ctx);
		decisions.sessionDenies[id] ??= {};
		return decisions.sessionDenies[id];
	}

	function existingSessionAllowsFor(ctx: ExtensionContext): Record<string, SessionDecisionRecord> | undefined {
		return decisions.sessionAllows[sessionId(ctx)];
	}

	function existingSessionDeniesFor(ctx: ExtensionContext): Record<string, SessionDecisionRecord> | undefined {
		return decisions.sessionDenies[sessionId(ctx)];
	}

	function deleteSessionDecision(ctx: ExtensionContext, key: string): void {
		const id = sessionId(ctx);
		const allows = decisions.sessionAllows[id];
		if (allows) {
			delete allows[key];
			if (Object.keys(allows).length === 0) delete decisions.sessionAllows[id];
		}

		const denies = decisions.sessionDenies[id];
		if (denies) {
			delete denies[key];
			if (Object.keys(denies).length === 0) delete decisions.sessionDenies[id];
		}
	}

	function pruneExpiredDecisions(ctx?: ExtensionContext): void {
		let changed = false;
		for (const [key, record] of Object.entries(decisions.decisions)) {
			if (!isExpired(record)) continue;
			delete decisions.decisions[key];
			changed = true;
		}

		if (!changed) return;
		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function getGlobalDecisionRecord(skill: SkillSummary, ctx?: ExtensionContext): DecisionRecord | undefined {
		const key = skillKey(skill);
		const record = decisions.decisions[key];
		if (!record) return undefined;

		if (isExpired(record)) {
			delete decisions.decisions[key];
			writeDecisionStore(decisions, ctx);
			updateStatus(ctx);
			return undefined;
		}

		return record;
	}

	function getGlobalDecision(skill: SkillSummary, ctx?: ExtensionContext): GlobalDecision | undefined {
		return getGlobalDecisionRecord(skill, ctx)?.decision;
	}

	function hasSessionAllow(ctx: ExtensionContext, skill: SkillSummary): boolean {
		return existingSessionAllowsFor(ctx)?.[skillKey(skill)]?.decision === "allow";
	}

	function hasSessionDeny(ctx: ExtensionContext, skill: SkillSummary): boolean {
		return existingSessionDeniesFor(ctx)?.[skillKey(skill)]?.decision === "deny";
	}

	function getEffectiveDecision(ctx: ExtensionContext, skill: SkillSummary): EffectiveDecision | undefined {
		if (hasSessionDeny(ctx, skill)) return "session-deny";

		const globalDecision = getGlobalDecision(skill, ctx);
		if (globalDecision) return globalDecision;
		if (hasSessionAllow(ctx, skill)) return "session-allow";
		return undefined;
	}

	function setGlobalDecision(
		skill: SkillSummary,
		decision: GlobalDecision,
		ctx?: ExtensionContext,
		options: { expiresAt?: string } = {},
	): void {
		const key = skillKey(skill);
		decisions.decisions[key] = {
			decision,
			name: skill.name,
			filePath: path.resolve(skill.filePath),
			baseDir: path.resolve(skill.baseDir),
			description: skill.description,
			source: skill.sourceInfo?.source,
			scope: skill.sourceInfo?.scope,
			updatedAt: new Date().toISOString(),
			expiresAt: options.expiresAt,
		};

		if (ctx) deleteSessionDecision(ctx, key);

		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function setSessionDecision(skill: SkillSummary, decision: SessionDecision, ctx: ExtensionContext): void {
		const key = skillKey(skill);
		deleteSessionDecision(ctx, key);

		const target = decision === "allow" ? sessionAllowsFor(ctx) : sessionDeniesFor(ctx);
		target[key] = {
			decision,
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
		const key = skillKey(skill);
		delete decisions.decisions[key];
		if (ctx) deleteSessionDecision(ctx, key);
		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function resetAllDecisions(ctx: ExtensionContext): void {
		for (const key of Object.keys(decisions.decisions)) delete decisions.decisions[key];
		for (const key of Object.keys(decisions.sessionAllows)) delete decisions.sessionAllows[key];
		for (const key of Object.keys(decisions.sessionDenies)) delete decisions.sessionDenies[key];
		writeDecisionStore(decisions, ctx);
		updateStatus(ctx);
	}

	function updateStatus(ctx?: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	function findSkillByArg(rawArg: string, ctx: ExtensionContext): SkillSummary | undefined {
		pruneExpiredDecisions(ctx);

		const arg = rawArg.trim();
		if (!arg) return undefined;

		const normalizedName = normalizeSkillNameArg(arg);
		const byName = skillsByName.get(normalizedName);
		if (byName) return byName;

		const staleGlobalByName = Object.values(decisions.decisions).find((record) => record.name === normalizedName);
		if (staleGlobalByName) return decisionToSkillSummary(staleGlobalByName);

		const staleSessionByName = [
			...Object.values(existingSessionAllowsFor(ctx) ?? {}),
			...Object.values(existingSessionDeniesFor(ctx) ?? {}),
		].find((record) => record.name === normalizedName);
		if (staleSessionByName) return sessionDecisionToSkillSummary(staleSessionByName);

		const key = canonicalPath(normalizePathInput(arg, ctx.cwd));
		const sessionAllow = existingSessionAllowsFor(ctx)?.[key];
		const sessionDeny = existingSessionDeniesFor(ctx)?.[key];
		return skillsByFileKey.get(key)
			?? (decisions.decisions[key] ? decisionToSkillSummary(decisions.decisions[key]) : undefined)
			?? (sessionAllow ? sessionDecisionToSkillSummary(sessionAllow) : undefined)
			?? (sessionDeny ? sessionDecisionToSkillSummary(sessionDeny) : undefined);
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
				"Choose what to do with this skill.",
			].join("\n"),
			[
				"Allow for this session",
				"Deny for this session",
				"Allow for one week",
				"Deny for one week",
				"Always allow",
				"Always deny",
			],
		);

		if (!choice) return undefined;

		if (choice === "Allow for this session") {
			setSessionDecision(skill, "allow", ctx);
			ctx.ui.notify(`skill-gate: ${skill.name} allowed for this session.`, "info");
			return "session-allow";
		}

		if (choice === "Deny for this session") {
			setSessionDecision(skill, "deny", ctx);
			ctx.ui.notify(`skill-gate: ${skill.name} denied for this session.`, "warning");
			return "session-deny";
		}

		if (choice === "Allow for one week" || choice === "Deny for one week") {
			const decision: GlobalDecision = choice === "Allow for one week" ? "allow" : "deny";
			const expiresAt = oneWeekFromNow();
			setGlobalDecision(skill, decision, ctx, { expiresAt });
			ctx.ui.notify(
				`skill-gate: ${skill.name} set to ${decision} until ${expiresAt}.`,
				decision === "allow" ? "info" : "warning",
			);
			return decision;
		}

		const decision: GlobalDecision = choice === "Always allow" ? "allow" : "deny";
		setGlobalDecision(skill, decision, ctx);
		ctx.ui.notify(`skill-gate: ${skill.name} set to ${decision}.`, decision === "allow" ? "info" : "warning");
		return decision;
	}

	async function decisionForUse(ctx: ExtensionContext, skill: SkillSummary, trigger: string): Promise<EffectiveDecision | undefined> {
		pruneExpiredDecisions(ctx);

		const existing = getEffectiveDecision(ctx, skill);
		if (existing) return existing;
		return promptForDecision(ctx, skill, trigger);
	}

	function storedDecisionLabel(record: DecisionRecord): string {
		return record.expiresAt ? `${record.decision}-week` : record.decision;
	}

	function storedDecisionSuffix(record: DecisionRecord): string {
		return record.expiresAt ? ` (expires ${record.expiresAt})` : "";
	}

	function sessionDecisionLabel(record: SessionDecisionRecord): string {
		return `session-${record.decision}`;
	}

	function decisionLabel(ctx: ExtensionContext, skill: SkillSummary): string {
		if (hasSessionDeny(ctx, skill)) return "session-deny";

		const globalRecord = getGlobalDecisionRecord(skill, ctx);
		if (globalRecord) return storedDecisionLabel(globalRecord);
		if (hasSessionAllow(ctx, skill)) return "session-allow";
		return "prompt";
	}

	function decisionListText(ctx: ExtensionContext): string {
		pruneExpiredDecisions(ctx);

		const pathIndent = " ".repeat(DECISION_LABEL_WIDTH + 3);
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
				const label = decisionLabel(ctx, skill);
				const globalRecord = getGlobalDecisionRecord(skill, ctx);
				const suffix = globalRecord && label === storedDecisionLabel(globalRecord) ? storedDecisionSuffix(globalRecord) : "";
				lines.push(`  ${label.padEnd(DECISION_LABEL_WIDTH)} ${skill.name}${suffix}`);
				lines.push(`${pathIndent}${skill.filePath}`);
			}
		}

		const currentKeys = new Set(currentSkills.map(skillKey));
		const staleRecords = Object.entries(decisions.decisions).filter(([key]) => !currentKeys.has(key));
		if (staleRecords.length > 0) {
			lines.push("", "Stored persistent decisions for skills not currently loaded:");
			for (const [, record] of staleRecords.sort((a, b) => a[1].name.localeCompare(b[1].name))) {
				lines.push(`  ${storedDecisionLabel(record).padEnd(DECISION_LABEL_WIDTH)} ${record.name}${storedDecisionSuffix(record)}`);
				lines.push(`${pathIndent}${record.filePath}`);
			}
		}

		const staleSessionRecords: Array<[string, string, SessionDecisionRecord]> = [];
		for (const [key, record] of Object.entries(existingSessionAllowsFor(ctx) ?? {})) {
			if (!currentKeys.has(key)) staleSessionRecords.push([key, sessionDecisionLabel(record), record]);
		}
		for (const [key, record] of Object.entries(existingSessionDeniesFor(ctx) ?? {})) {
			if (!currentKeys.has(key)) staleSessionRecords.push([key, sessionDecisionLabel(record), record]);
		}

		if (staleSessionRecords.length > 0) {
			lines.push("", "Stored session decisions for skills not currently loaded:");
			for (const [, label, record] of staleSessionRecords.sort((a, b) => a[2].name.localeCompare(b[2].name))) {
				lines.push(`  ${label.padEnd(DECISION_LABEL_WIDTH)} ${record.name}`);
				lines.push(`${pathIndent}${record.filePath}`);
			}
		}

		lines.push(
			"",
			"Commands:",
			"  /skill-gate allow-session <skill>",
			"  /skill-gate deny-session <skill>",
			"  /skill-gate allow-week <skill>",
			"  /skill-gate deny-week <skill>",
			"  /skill-gate allow <skill>",
			"  /skill-gate deny <skill>",
			"  /skill-gate forget <skill>",
			"  /skill-gate reset",
		);

		return lines.join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		pruneExpiredDecisions(ctx);
		syncSkillsFromCommands();
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const skills = event.systemPromptOptions.skills ?? [];
		syncSkills(skills.map(toSkillSummary));
		updateStatus(ctx);

		const filteredSkills = skills.filter((skill) => {
			const decision = getEffectiveDecision(ctx, toSkillSummary(skill));
			return decision !== "deny" && decision !== "session-deny";
		});
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

		const reason = decision === "deny" || decision === "session-deny"
			? `Denied skill ${skill.name}.`
			: `Skill ${skill.name} requires approval, but no decision was made.`;
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

		const reason = decision === "deny" || decision === "session-deny"
			? `Skill ${skill.name} denied by skill-gate`
			: `Skill ${skill.name} requires approval, but no UI decision was made`;
		return { block: true, reason };
	});

	pi.registerCommand("skill-gate", {
		description: "Manage skill gate allow/deny decisions",
		handler: async (args, ctx) => {
			syncSkills((ctx.getSystemPromptOptions().skills ?? []).map(toSkillSummary));
			pruneExpiredDecisions(ctx);
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
				const ok = await ctx.ui.confirm("Reset skill gate decisions?", `Delete all persistent and session-scoped decisions in ${DECISIONS_PATH}?`);
				if (!ok) return;
				resetAllDecisions(ctx);
				ctx.ui.notify("skill-gate: all decisions cleared.", "info");
				return;
			}

			const skill = findSkillByArg(targetArg, ctx);
			if (!skill) {
				ctx.ui.notify(
					"Usage: /skill-gate <allow-session|deny-session|allow-week|deny-week|allow|deny|forget> <skill-name-or-path>\nRun /skill-gate list to see current skills.",
					"warning",
				);
				return;
			}

			if (subcommand === "allow-session" || subcommand === "session" || subcommand === "allow-for-session" || subcommand === "accept-session") {
				setSessionDecision(skill, "allow", ctx);
				ctx.ui.notify(`skill-gate: ${skill.name} allowed for this session.`, "info");
				return;
			}

			if (subcommand === "deny-session" || subcommand === "session-deny" || subcommand === "deny-for-session" || subcommand === "block-session") {
				setSessionDecision(skill, "deny", ctx);
				ctx.ui.notify(`skill-gate: ${skill.name} denied for this session.`, "warning");
				return;
			}

			if (subcommand === "allow-week" || subcommand === "allow-for-week" || subcommand === "accept-week" || subcommand === "accept-for-week") {
				const expiresAt = oneWeekFromNow();
				setGlobalDecision(skill, "allow", ctx, { expiresAt });
				ctx.ui.notify(`skill-gate: ${skill.name} set to allow until ${expiresAt}.`, "info");
				return;
			}

			if (subcommand === "deny-week" || subcommand === "deny-for-week" || subcommand === "block-week" || subcommand === "block-for-week") {
				const expiresAt = oneWeekFromNow();
				setGlobalDecision(skill, "deny", ctx, { expiresAt });
				ctx.ui.notify(`skill-gate: ${skill.name} set to deny until ${expiresAt}.`, "warning");
				return;
			}

			if (subcommand === "allow" || subcommand === "approve" || subcommand === "accept") {
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

			ctx.ui.notify("Usage: /skill-gate [list|allow-session|deny-session|allow-week|deny-week|allow|deny|forget|reset]", "warning");
		},
	});
}
