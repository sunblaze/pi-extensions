import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, basename } from "path";

interface RecordingState {
	proc: ChildProcessWithoutNullStreams;
	filePath: string;
	logPath: string;
	input: string;
	startedAt: number;
}

const HOTKEY = "ctrl+shift+r";
const STATUS_KEY = "voice";

const MODEL_OPTIONS = ["nvidia/parakeet-tdt-0.6b-v3", "openai/whisper-large-v3"] as const;
type VoiceModel = (typeof MODEL_OPTIONS)[number];
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "voice-to-text.json");

export function loadConfig(configPath: string = CONFIG_PATH): { model?: VoiceModel } {
	try {
		if (!existsSync(configPath)) return {};
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { model?: VoiceModel };
		if (parsed?.model && MODEL_OPTIONS.includes(parsed.model)) {
			return { model: parsed.model };
		}
	} catch {}
	return {};
}

export function saveConfig(config: { model?: VoiceModel }, configPath: string = CONFIG_PATH) {
	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	} catch {}
}

export function buildFfmpegArgs(filePath: string, input: string): string[] {
	// Common output settings: 16kHz mono WAV (Whisper friendly)
	const outputArgs = ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", filePath];

	// macOS: avfoundation input
	return ["-y", "-f", "avfoundation", "-i", input, ...outputArgs];
}

export async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(filePath)) {
			try {
				const st = statSync(filePath);
				if (st.size > 0) return true;
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

export async function transcribeFile(params: {
	filePath: string;
	model: VoiceModel;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
	apiKey?: string;
}): Promise<string> {
	const { filePath, model, fetchImpl = fetch, baseUrl = process.env.VENICE_API_BASE ?? "https://api.venice.ai/api/v1", apiKey = process.env.VENICE_API_KEY } = params;
	if (!apiKey || apiKey.trim() === "") {
		throw new Error("VENICE_API_KEY is not set");
	}

	const buf = readFileSync(filePath);

	const form = new FormData();
	form.append("model", model);
	form.append("language", "en");
	form.append(
		"prompt",
		"Technical, programming context. Preserve code identifiers, file paths, CLI flags, and library names when possible.",
	);
	form.append("response_format", "json");
	form.append("timestamps", "false");
	form.append("file", new Blob([buf], { type: "audio/wav" }), basename(filePath));

	const url = `${baseUrl}/audio/transcriptions`;

	const res = await fetchImpl(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: form,
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`${res.status} ${res.statusText}: ${errText}`);
	}

	const ctype = res.headers.get("content-type") || "";
	const body = await res.text();
	if (ctype.includes("application/json")) {
		try {
			const data = JSON.parse(body);
			if (typeof data.text === "string") return data.text;
			// Some APIs return {transcription: "..."}
			if (typeof data.transcription === "string") return data.transcription;
			return JSON.stringify(data);
		} catch {
			return body;
		}
	}

	return body;
}

export default function (pi: ExtensionAPI) {
	let recording: RecordingState | null = null;
	let transcribing = false;
	let ffmpegAvailable: boolean | null = null;
	let preferredInput: string | undefined;
	let preferredModel: VoiceModel = "openai/whisper-large-v3";

	async function ensureFfmpeg(ctx: any): Promise<boolean> {
		if (ffmpegAvailable !== null) return ffmpegAvailable;
		const result = await pi.exec("which", ["ffmpeg"]);
		ffmpegAvailable = result.code === 0;
		if (!ffmpegAvailable) {
			ctx.ui.notify("ffmpeg not found. Install ffmpeg to enable voice capture.", "error");
		}
		return ffmpegAvailable;
	}

	async function startRecording(ctx: any) {
		if (recording || transcribing) return;
		const ok = await ensureFfmpeg(ctx);
		if (!ok) return;

		const inputOverride = process.env.PI_VOICE_INPUT;
		let input = inputOverride ?? preferredInput;

		if (!inputOverride && !input && ctx.hasUI) {
			input = await ctx.ui.input(
				"Select microphone",
				"Enter avfoundation input (e.g. :0 or 0:0). Default is :0",
			);
			if (!input) input = ":0";
		}

		if (!input) {
			// Default input (macOS only)
			input = ":0";
		}

		const dir = mkdtempSync(join(tmpdir(), "pi-voice-"));
		const filePath = join(dir, "recording.wav");
		const logPath = join(dir, "ffmpeg.log");
		const args = buildFfmpegArgs(filePath, input);

		const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
		proc.stderr.on("data", (chunk) => {
			try {
				writeFileSync(logPath, chunk, { flag: "a" });
			} catch {}
		});
		proc.on("error", (err) => {
			ctx.ui.notify(`ffmpeg failed to start: ${err.message}`, "error");
		});

		recording = { proc, filePath, logPath, input, startedAt: Date.now() };
		preferredInput = input;

		ctx.ui.setStatus(STATUS_KEY, `🎙 Recording... (${preferredModel}) (Ctrl+Shift+R to stop)`);
		ctx.ui.notify(`Recording started (input: ${input})`, "info");
		if (!process.env.PI_VOICE_INPUT) {
			ctx.ui.notify("Tip: set PI_VOICE_INPUT to avoid the prompt next time", "info");
		}

		// Detect immediate failure
		setTimeout(() => {
			if (proc.exitCode !== null) {
				let logText = "";
				try {
					logText = readFileSync(logPath, "utf-8");
				} catch {}
				const msg = logText?.trim()
					? `ffmpeg exited early (input: ${input}): ${logText}`
					: `ffmpeg exited early (input: ${input}). Check mic permissions or input device.`;
				ctx.ui.notify(msg, "error");
			}
		}, 300);

		proc.on("exit", () => {
			// If the process exits unexpectedly, clear state
			if (recording?.proc === proc) {
				recording = null;
				ctx.ui.setStatus(STATUS_KEY, "");
			}
		});
	}

	async function stopRecording(ctx: any) {
		if (!recording || transcribing) return;
		const { proc, filePath, logPath, input } = recording;
		recording = null;

		ctx.ui.setStatus(STATUS_KEY, "⏳ Processing audio...");
		// If ffmpeg exited immediately, surface error log
		try {
			const st = proc.exitCode;
			if (typeof st === "number" && st !== 0) {
				const logText = readFileSync(logPath, "utf-8");
				if (logText?.trim()) {
					ctx.ui.notify(`ffmpeg error (input: ${input}): ${logText}`, "error");
				}
			}
		} catch {}

		// Stop ffmpeg gracefully
		try {
			proc.kill("SIGINT");
		} catch {}

		await new Promise<void>((resolve) => {
			proc.on("exit", () => resolve());
			setTimeout(() => resolve(), 2000);
		});

		transcribing = true;
		try {
			// Ensure the file exists and has non-zero size before transcribing
			const ready = await waitForFile(filePath, 5000);
			if (!ready) {
				let logText = "";
				try {
					logText = readFileSync(logPath, "utf-8");
				} catch {}
				const hint = logText
					? ` ffmpeg log saved at ${logPath}`
					: "";
				ctx.ui.notify(
					`Recording file was not created. Check mic permissions or input device.${hint}`,
					"error",
				);
				return;
			}
			const text = await transcribeFile({ filePath, model: preferredModel });
			if (text && text.trim()) {
				ctx.ui.setEditorText(text.trim());
				ctx.ui.notify("Transcription loaded into editor", "info");
			} else {
				ctx.ui.notify("Transcription was empty", "warning");
			}
		} catch (err: any) {
			ctx.ui.notify(`Transcription failed: ${err?.message ?? String(err)}`, "error");
		} finally {
			transcribing = false;
			ctx.ui.setStatus(STATUS_KEY, "");
		}
	}


	pi.registerShortcut(HOTKEY, {
		description: "Toggle voice recording (transcribe to editor)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			if (recording) {
				await stopRecording(ctx);
			} else {
				await startRecording(ctx);
			}
		},
	});

	pi.registerCommand("voice", {
		description: "Toggle voice recording (transcribe to editor)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("voice requires interactive mode", "error");
				return;
			}

			const trimmed = (args || "").trim();
			if (trimmed.toLowerCase() === "model") {
				const selected = await ctx.ui.select(
					"Select voice model",
					MODEL_OPTIONS.map((m) => (m === preferredModel ? `• ${m}` : m)),
				);

				if (selected) {
					const normalized = selected.replace(/^•\s*/, "");
					if (MODEL_OPTIONS.includes(normalized as VoiceModel)) {
						preferredModel = normalized as VoiceModel;
						saveConfig({ model: preferredModel });
						ctx.ui.notify(`Voice model set to ${preferredModel}`, "info");
					} else {
						ctx.ui.notify("Invalid model selection", "error");
					}
				}
				return;
			}

			if (recording) {
				await stopRecording(ctx);
			} else {
				await startRecording(ctx);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig();
		if (config.model) {
			preferredModel = config.model;
			if (ctx.hasUI) {
				ctx.ui.notify(`Voice model: ${preferredModel}`, "info");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			recording?.proc.kill("SIGINT");
		} catch {}
	});
}
