import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import voiceExtension, { buildFfmpegArgs, loadConfig, saveConfig, waitForFile, transcribeFile } from "../index";

function makeTempDir() {
	return mkdtempSync(join(tmpdir(), "pi-voice-test-"));
}

describe("voice-to-text utils", () => {
	it("buildFfmpegArgs uses avfoundation input and outputs wav settings", () => {
		const args = buildFfmpegArgs("/tmp/out.wav", ":0");
		expect(args).toEqual([
			"-y",
			"-f",
			"avfoundation",
			"-i",
			":0",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			"/tmp/out.wav",
		]);
	});

	it("loadConfig returns model when valid", () => {
		const dir = makeTempDir();
		const cfg = join(dir, "voice.json");
		writeFileSync(cfg, JSON.stringify({ model: "openai/whisper-large-v3" }));
		const res = loadConfig(cfg);
		expect(res.model).toBe("openai/whisper-large-v3");
	});

	it("loadConfig ignores invalid model", () => {
		const dir = makeTempDir();
		const cfg = join(dir, "voice.json");
		writeFileSync(cfg, JSON.stringify({ model: "bogus" }));
		const res = loadConfig(cfg);
		expect(res.model).toBeUndefined();
	});

	it("saveConfig writes json", () => {
		const dir = makeTempDir();
		const cfg = join(dir, "voice.json");
		saveConfig({ model: "nvidia/parakeet-tdt-0.6b-v3" }, cfg);
		const raw = readFileSync(cfg, "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.model).toBe("nvidia/parakeet-tdt-0.6b-v3");
	});

	it("waitForFile returns false when missing", async () => {
		const dir = makeTempDir();
		const fp = join(dir, "missing.wav");
		const ok = await waitForFile(fp, 200);
		expect(ok).toBe(false);
	});

	it("waitForFile returns true for non-empty file", async () => {
		const dir = makeTempDir();
		const fp = join(dir, "audio.wav");
		setTimeout(() => writeFileSync(fp, "x"), 50);
		const ok = await waitForFile(fp, 500);
		expect(ok).toBe(true);
	});
});

describe("extension registration", () => {
	it("registers shortcut and handler returns when no UI", async () => {
		let shortcutHandler: any;
		const pi = {
			registerShortcut: vi.fn((_hotkey: string, def: any) => {
				shortcutHandler = def.handler;
			}),
			registerCommand: vi.fn(),
			on: vi.fn(),
			exec: vi.fn(),
		} as any;

		voiceExtension(pi);
		expect(pi.registerShortcut).toHaveBeenCalled();
		expect(typeof shortcutHandler).toBe("function");

		const ctx = { hasUI: false } as any;
		await shortcutHandler(ctx);
	});

	it("registers command and notifies when no UI", async () => {
		let commandHandler: any;
		const pi = {
			registerShortcut: vi.fn(),
			registerCommand: vi.fn((_name: string, def: any) => {
				commandHandler = def.handler;
			}),
			on: vi.fn(),
			exec: vi.fn(),
		} as any;

		voiceExtension(pi);
		expect(pi.registerCommand).toHaveBeenCalled();
		expect(typeof commandHandler).toBe("function");

		const notify = vi.fn();
		const ctx = { hasUI: false, ui: { notify } } as any;
		await commandHandler("", ctx);
		expect(notify).toHaveBeenCalledWith("voice requires interactive mode", "error");
	});
});

describe("transcribeFile", () => {
	const originalEnv = { ...process.env };
	beforeEach(() => {
		process.env = { ...originalEnv };
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("throws when API key missing", async () => {
		const dir = makeTempDir();
		const fp = join(dir, "audio.wav");
		writeFileSync(fp, "x");
		await expect(
			transcribeFile({
				filePath: fp,
				model: "openai/whisper-large-v3",
				apiKey: "",
				fetchImpl: vi.fn(async () => {
					throw new Error("fetch should not be called");
				}) as any,
			}),
		).rejects.toThrow("VENICE_API_KEY is not set");
	});

	it("returns text from json response", async () => {
		const dir = makeTempDir();
		const fp = join(dir, "audio.wav");
		writeFileSync(fp, "x");

		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
			text: async () => JSON.stringify({ text: "hello" }),
		})) as any;

		const res = await transcribeFile({
			filePath: fp,
			model: "openai/whisper-large-v3",
			fetchImpl,
			apiKey: "key",
			baseUrl: "http://example",
		});
		expect(res).toBe("hello");
	});

	it("returns transcription fallback", async () => {
		const dir = makeTempDir();
		const fp = join(dir, "audio.wav");
		writeFileSync(fp, "x");

		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
			text: async () => JSON.stringify({ transcription: "hola" }),
		})) as any;

		const res = await transcribeFile({
			filePath: fp,
			model: "openai/whisper-large-v3",
			fetchImpl,
			apiKey: "key",
			baseUrl: "http://example",
		});
		expect(res).toBe("hola");
	});

	it("throws on non-ok response", async () => {
		const dir = makeTempDir();
		const fp = join(dir, "audio.wav");
		writeFileSync(fp, "x");

		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/plain" : null) },
			text: async () => "bad key",
		})) as any;

		await expect(
			transcribeFile({
				filePath: fp,
				model: "openai/whisper-large-v3",
				fetchImpl,
				apiKey: "key",
				baseUrl: "http://example",
			}),
		).rejects.toThrow("401 Unauthorized: bad key");
	});
});
