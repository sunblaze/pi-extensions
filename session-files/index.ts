import { execFile } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  getLanguageFromPath,
  highlightCode,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const STATE_ENTRY_TYPE = "session-files-prototype-state";
const WIDGET_KEY = "session-files-prototype-widget";
const PREVIEW_MAX_BYTES = 180_000;
const PREVIEW_MIN_VIEWPORT_LINES = 1;
const PREVIEW_VERTICAL_MARGIN = 4;
const PREVIEW_HORIZONTAL_MARGIN = 5;
const SCROLLBAR_TRACK_CHAR = "░";
const SCROLLBAR_THUMB_CHAR = "█";
const RECENT_TOUCHED_MAX = 200;
const BASH_TOUCHED_MAX_PATHS = 12;
const CURRENT_SESSION_TRANSCRIPT_MAX_CHARS = 70_000;
const CURRENT_SESSION_SNIPPET_MAX_CHARS = 800;
const EXTRACTED_FILES_MAX = 30;
const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";
const GIT_COMMAND_MAX_BUFFER_BYTES = 1_500_000;
const GIT_DIFF_PREVIEW_MAX_BYTES = 240_000;
const GIT_DIFF_FULL_CONTEXT_LINES = 1_000_000;
const ANSI_RESET = "\u001b[0m";
const ANSI_DIFF_ADDED = "\u001b[32m";
const ANSI_DIFF_REMOVED = "\u001b[31m";
const ANSI_DIFF_HUNK = "\u001b[36m";
const ANSI_DIFF_META = "\u001b[2m";
const ANSI_DIFF_ADDED_BG = "\u001b[48;2;0;32;0m";
const ANSI_DIFF_REMOVED_BG = "\u001b[48;2;36;0;0m";

const execFileAsync = promisify(execFile);

const CURRENT_SESSION_FILES_SYSTEM_PROMPT = `You extract file paths from a coding assistant session transcript.

Return strict JSON in this exact format:
{
  "files": [
    { "path": "relative/or/absolute/path", "reason": "short reason" }
  ]
}

Rules:
- Include only file paths (not directories, commands, URLs, or package names).
- Prefer concrete file paths that appear in tool calls or explicit file discussion.
- Keep paths exactly as written when possible.
- Return at most 30 files.
- If no files are found, return {"files": []}.
- Output JSON only (no markdown fences).
`;

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const stripAtPrefix = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
};

const dedupe = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

const resolvePinnedPath = (storedPath: string, cwd: string): string => {
  if (path.isAbsolute(storedPath)) return storedPath;
  return path.resolve(cwd, storedPath);
};

const getStoredPathForCwd = async (rawPath: string, cwd: string): Promise<string> => {
  const unquoted = stripWrappingQuotes(rawPath);
  const noAt = stripAtPrefix(unquoted);
  const expandedHome = noAt.startsWith("~/") ? path.join(os.homedir(), noAt.slice(2)) : noAt;
  const absolutePath = path.resolve(cwd, expandedHome);

  await fs.access(absolutePath, fsConstants.R_OK);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }

  const rel = path.relative(cwd, absolutePath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return absolutePath;
};

const getCandidateStoredPathForCwd = (rawPath: string, cwd: string): string | undefined => {
  const unquoted = stripWrappingQuotes(rawPath);
  const noAt = stripAtPrefix(unquoted);
  if (!noAt) return undefined;

  const expandedHome = noAt.startsWith("~/") ? path.join(os.homedir(), noAt.slice(2)) : noAt;
  const absolutePath = path.resolve(cwd, expandedHome);
  const rel = path.relative(cwd, absolutePath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return absolutePath;
};

const looksLikePathToken = (token: string): boolean => {
  if (!token) return false;
  if (token.startsWith("-")) return false;
  if (["&&", "||", "|", ">", ">>", "<", "2>", "1>", "(", ")"].includes(token)) return false;
  if (token === "." || token === "..") return false;
  return token.startsWith("~/") || token.startsWith("./") || token.startsWith("../") || token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token);
};

const tokenizeBash = (command: string): string[] => {
  const tokens: string[] = [];
  const matcher = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(command)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const cleaned = value.trim().replace(/^[([{]+/, "").replace(/[)\]}.,;:]+$/, "");
    if (cleaned) tokens.push(cleaned);
  }

  return tokens;
};

const getTouchedPathsFromToolInput = async (
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string[]> => {
  if (["read", "edit", "write"].includes(toolName)) {
    const rawPath = typeof input.path === "string" ? input.path : undefined;
    const normalized = rawPath ? getCandidateStoredPathForCwd(rawPath, cwd) : undefined;
    return normalized ? [normalized] : [];
  }

  if (toolName !== "bash") return [];

  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return [];

  const tokens = tokenizeBash(command);
  const out: string[] = [];

  for (const token of tokens) {
    if (!looksLikePathToken(token)) continue;
    const candidate = getCandidateStoredPathForCwd(token, cwd);
    if (!candidate) continue;

    try {
      const absolutePath = resolvePinnedPath(candidate, cwd);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) continue;
      out.push(candidate);
      if (out.length >= BASH_TOUCHED_MAX_PATHS) break;
    } catch {
      // Ignore non-existent paths from shell commands.
    }
  }

  return dedupe(out);
};

type PreviewMode = "file" | "diff";

type PreviewLineKind = "plain" | "diff-meta" | "diff-hunk" | "diff-added" | "diff-removed" | "diff-context";

interface PreviewLine {
  text: string;
  kind: PreviewLineKind;
  lineNumber?: number;
}

interface FilePreviewData {
  label: string;
  lines: PreviewLine[];
  notice?: string;
  language?: string;
  mode: PreviewMode;
}

const normalizeLineEndings = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const toPlainPreviewLines = (lines: string[]): PreviewLine[] => lines.map((line) => ({ text: line, kind: "plain" }));

const colorizeAnsi = (value: string, colorCode: string): string => `${colorCode}${value}${ANSI_RESET}`;

const runGitCommand = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    });
    const stdout = result.stdout;
    return typeof stdout === "string" ? stdout : stdout.toString("utf8");
  } catch {
    return null;
  }
};

const getGitRepoContextForPath = async (
  absolutePath: string,
  cwd: string,
): Promise<{ repoRoot: string; repoRelativePath: string } | null> => {
  const rootOutput = await runGitCommand(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootOutput) return null;

  const repoRoot = rootOutput.trim();
  if (!repoRoot) return null;

  const repoRelativePath = path.relative(repoRoot, absolutePath);
  if (!repoRelativePath || repoRelativePath.startsWith("..") || path.isAbsolute(repoRelativePath)) {
    return null;
  }

  return { repoRoot, repoRelativePath };
};

const getGitDiffText = async (repoRoot: string, repoRelativePath: string): Promise<string | null> => {
  const fullContextFlag = `--unified=${GIT_DIFF_FULL_CONTEXT_LINES}`;

  const diffAgainstHead = await runGitCommand(repoRoot, [
    "-c",
    "color.ui=never",
    "diff",
    "--no-ext-diff",
    fullContextFlag,
    "HEAD",
    "--",
    repoRelativePath,
  ]);
  if (diffAgainstHead !== null) return diffAgainstHead;

  // Fallback for repositories without a HEAD (e.g. very first commit).
  const stagedDiff = await runGitCommand(repoRoot, [
    "-c",
    "color.ui=never",
    "diff",
    "--no-ext-diff",
    fullContextFlag,
    "--cached",
    "--",
    repoRelativePath,
  ]);
  const unstagedDiff = await runGitCommand(repoRoot, [
    "-c",
    "color.ui=never",
    "diff",
    "--no-ext-diff",
    fullContextFlag,
    "--",
    repoRelativePath,
  ]);

  if (stagedDiff === null && unstagedDiff === null) return null;
  return `${stagedDiff ?? ""}${stagedDiff && unstagedDiff ? "\n" : ""}${unstagedDiff ?? ""}`;
};

const parseUnifiedDiffBody = (diffText: string): PreviewLine[] => {
  const lines = normalizeLineEndings(diffText).split("\n");
  const out: PreviewLine[] = [];

  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
    if (hunkHeader) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;

    if (line.startsWith("+")) {
      out.push({ text: line.slice(1), kind: "diff-added", lineNumber: newLine });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      out.push({ text: line.slice(1), kind: "diff-removed", lineNumber: oldLine });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      out.push({ text: line.slice(1), kind: "diff-context", lineNumber: newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith("diff --git ") || line.startsWith("index ")) {
      inHunk = false;
    }
  }

  return out;
};

const getDiffPreviewData = async (storedPath: string, cwd: string): Promise<FilePreviewData | null> => {
  const absolutePath = resolvePinnedPath(storedPath, cwd);
  const repoContext = await getGitRepoContextForPath(absolutePath, cwd);
  if (!repoContext) return null;

  const diffText = await getGitDiffText(repoContext.repoRoot, repoContext.repoRelativePath);
  if (diffText === null || !diffText.trim()) return null;

  const totalBytes = Buffer.byteLength(diffText, "utf8");
  let previewText = diffText;
  let notice = "Showing clean full-context diff (no git headers)";

  if (totalBytes > GIT_DIFF_PREVIEW_MAX_BYTES) {
    previewText = Buffer.from(diffText, "utf8").subarray(0, GIT_DIFF_PREVIEW_MAX_BYTES).toString("utf8");
    notice = `Diff preview truncated to ${GIT_DIFF_PREVIEW_MAX_BYTES.toLocaleString()} bytes (diff is ${totalBytes.toLocaleString()} bytes)`;
  }

  const parsedLines = parseUnifiedDiffBody(previewText);
  if (parsedLines.length === 0) return null;

  const language = getLanguageFromPath(absolutePath);
  if (language) {
    const highlighted = highlightCode(parsedLines.map((line) => line.text).join("\n"), language);
    if (highlighted.length === parsedLines.length) {
      for (let i = 0; i < parsedLines.length; i++) {
        parsedLines[i] = { ...parsedLines[i], text: highlighted[i] ?? parsedLines[i].text };
      }
    }
  }

  return {
    label: storedPath,
    lines: parsedLines,
    notice,
    language,
    mode: "diff",
  };
};

const getPreviewData = async (storedPath: string, cwd: string, preferDiffPreview = true): Promise<FilePreviewData> => {
  if (preferDiffPreview) {
    const diffPreview = await getDiffPreviewData(storedPath, cwd);
    if (diffPreview) return diffPreview;
  }

  const absolutePath = resolvePinnedPath(storedPath, cwd);
  const buffer = await fs.readFile(absolutePath);

  if (buffer.includes(0)) {
    throw new Error("File appears to be binary and cannot be previewed as text");
  }

  let content = "";
  let notice: string | undefined;

  if (buffer.length > PREVIEW_MAX_BYTES) {
    content = buffer.subarray(0, PREVIEW_MAX_BYTES).toString("utf8");
    notice = `Preview truncated to ${PREVIEW_MAX_BYTES.toLocaleString()} bytes (file is ${buffer.length.toLocaleString()} bytes)`;
  } else {
    content = buffer.toString("utf8");
  }

  const normalized = normalizeLineEndings(content);
  const language = getLanguageFromPath(absolutePath);
  const lines = language ? highlightCode(normalized, language) : normalized.split("\n");

  return {
    label: storedPath,
    lines: toPlainPreviewLines(lines),
    notice,
    language,
    mode: "file",
  };
};

interface SessionFileExtractionItem {
  path?: string;
  reason?: string;
}

interface SessionFileExtractionResult {
  files?: Array<string | SessionFileExtractionItem>;
}

const normalizeSnippet = (value: string, maxChars = CURRENT_SESSION_SNIPPET_MAX_CHARS): string => {
  const squashed = value.replace(/\s+/g, " ").trim();
  if (squashed.length <= maxChars) return squashed;
  return `${squashed.slice(0, Math.max(0, maxChars - 1))}…`;
};

const stringifyCompact = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
};

const extractTextParts = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }

  return textParts;
};

const extractAssistantSnippets = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];

  const snippets: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      const text = normalizeSnippet(block.text);
      if (text) snippets.push(`Assistant: ${text}`);
      continue;
    }

    if (block.type === "toolCall") {
      const toolName = typeof block.name === "string" ? block.name : "unknown";
      const args = block.arguments ?? block.input ?? block.args;
      const argsText = normalizeSnippet(stringifyCompact(args));
      snippets.push(`Tool call (${toolName}): ${argsText}`);
    }
  }

  return snippets;
};

const extractJsonPayload = (text: string): string => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() ?? text.trim();
};

const extractPathCandidatesFromText = (text: string): string[] => {
  const candidates: string[] = [];
  const pattern = /(?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,10}/g;

  for (const match of text.matchAll(pattern)) {
    const value = match[0]?.trim();
    if (value) candidates.push(value);
  }

  return dedupe(candidates);
};

const parseSessionFileExtractionResult = (text: string): string[] | null => {
  const fallback = extractPathCandidatesFromText(text);

  try {
    const parsed = JSON.parse(extractJsonPayload(text));
    const filesCandidate =
      Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? (parsed as SessionFileExtractionResult).files
          : undefined;

    if (!Array.isArray(filesCandidate)) {
      return fallback.length > 0 ? fallback : null;
    }

    const files: string[] = [];
    for (const item of filesCandidate) {
      if (typeof item === "string") {
        files.push(item);
        continue;
      }

      if (item && typeof item === "object" && typeof item.path === "string") {
        files.push(item.path);
      }
    }

    const normalized = dedupe(files.map((item) => item.trim()).filter(Boolean));
    if (normalized.length > 0) return normalized;
    return fallback.length > 0 ? fallback : null;
  } catch {
    return fallback.length > 0 ? fallback : null;
  }
};

const selectExtractionModel = async (
  currentModel: Model<Api>,
  modelRegistry: {
    find: (provider: string, modelId: string) => Model<Api> | undefined;
    getApiKey: (model: Model<Api>) => Promise<string | undefined>;
  },
): Promise<Model<Api>> => {
  const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
  if (codexModel) {
    const apiKey = await modelRegistry.getApiKey(codexModel);
    if (apiKey) return codexModel;
  }

  const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
  if (haikuModel) {
    const apiKey = await modelRegistry.getApiKey(haikuModel);
    if (apiKey) return haikuModel;
  }

  return currentModel;
};

const getCurrentSessionFile = (ctx: ExtensionContext): string | undefined => {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  return path.resolve(sessionFile);
};

const buildSessionTranscriptFromFile = async (sessionFile: string): Promise<string> => {
  const raw = await fs.readFile(sessionFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const snippets: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as Record<string, unknown>;

    if (entry.type === "message") {
      const messageCandidate = entry.message;
      if (!messageCandidate || typeof messageCandidate !== "object") continue;
      const message = messageCandidate as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : undefined;
      if (!role) continue;

      if (role === "user") {
        for (const text of extractTextParts(message.content)) {
          const normalized = normalizeSnippet(text);
          if (normalized) snippets.push(`User: ${normalized}`);
        }
        continue;
      }

      if (role === "assistant") {
        snippets.push(...extractAssistantSnippets(message.content));
        continue;
      }

      if (role === "toolResult" && message.isError === true) {
        const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
        const text = normalizeSnippet(extractTextParts(message.content).join(" "), 240);
        if (text) snippets.push(`Tool error (${toolName}): ${text}`);
      }

      continue;
    }

    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      const data = entry.data;
      if (!data || typeof data !== "object") continue;
      const customData = data as { files?: unknown };
      if (!Array.isArray(customData.files)) continue;

      const pinnedFiles = customData.files.filter((item): item is string => typeof item === "string");
      if (pinnedFiles.length > 0) {
        snippets.push(`Pinned files snapshot: ${pinnedFiles.join(", ")}`);
      }
    }
  }

  if (snippets.length === 0) return "";

  const transcript = snippets.join("\n");
  if (transcript.length <= CURRENT_SESSION_TRANSCRIPT_MAX_CHARS) {
    return transcript;
  }

  return transcript.slice(transcript.length - CURRENT_SESSION_TRANSCRIPT_MAX_CHARS);
};

const normalizeAndValidateExtractedPaths = async (candidatePaths: string[], cwd: string): Promise<string[]> => {
  const normalizedPaths: string[] = [];

  for (const rawPath of candidatePaths) {
    const cleaned = stripAtPrefix(
      stripWrappingQuotes(rawPath)
        .replace(/^[-*•\s]+/, "")
        .replace(/^([`"'“”‘’])+/, "")
        .replace(/([`"'“”‘’])+$/, "")
        .replace(/[),.;:]+$/, "")
        .trim(),
    );

    if (!cleaned) continue;

    const candidate = getCandidateStoredPathForCwd(cleaned, cwd);
    if (!candidate) continue;

    try {
      const absolutePath = resolvePinnedPath(candidate, cwd);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) continue;

      normalizedPaths.push(candidate);
      if (normalizedPaths.length >= EXTRACTED_FILES_MAX) break;
    } catch {
      // Ignore candidates that are not files in this workspace.
    }
  }

  return dedupe(normalizedPaths);
};

const extractFilesFromCurrentSession = async (ctx: ExtensionContext): Promise<string[] | null> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("/pin-touched extraction requires interactive mode", "error");
    return null;
  }

  if (!ctx.model) {
    ctx.ui.notify("No model selected", "error");
    return null;
  }

  const currentSessionFile = getCurrentSessionFile(ctx);
  if (!currentSessionFile) {
    ctx.ui.notify("Current session is not persisted yet", "info");
    return [];
  }

  let transcript = "";
  try {
    transcript = await buildSessionTranscriptFromFile(currentSessionFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not parse current session: ${message}`, "error");
    return [];
  }

  if (!transcript) {
    ctx.ui.notify("No extractable conversation in current session", "info");
    return [];
  }

  const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);
  const extractionResult = await ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `Extracting files from current session using ${extractionModel.id}...`);
    loader.onAbort = () => done(null);

    const runExtraction = async () => {
      const apiKey = await ctx.modelRegistry.getApiKey(extractionModel);
      const messageText = [
        `Current session file: ${path.basename(currentSessionFile)}`,
        "",
        transcript,
      ].join("\n");
      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: messageText }],
        timestamp: Date.now(),
      };

      const response = await complete(
        extractionModel,
        { systemPrompt: CURRENT_SESSION_FILES_SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey, signal: loader.signal },
      );

      if (response.stopReason === "aborted") {
        return null;
      }

      const responseText = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      const parsedPaths = parseSessionFileExtractionResult(responseText);
      if (!parsedPaths) return [];
      return normalizeAndValidateExtractedPaths(parsedPaths, ctx.cwd);
    };

    runExtraction()
      .then(done)
      .catch(() => done([]));

    return loader;
  });

  if (extractionResult === null) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  if (extractionResult.length === 0) {
    ctx.ui.notify("No files extracted from current session", "info");
  }

  return extractionResult;
};

class SessionFilesWidget {
  constructor(private readonly files: string[]) {}

  render(width: number): string[] {
    if (this.files.length === 0) {
      return [];
    }

    const preview = this.files.slice(0, 5);
    const separator = " ✨ ";
    let line = preview.join(separator);

    if (this.files.length > preview.length) {
      line += `${separator}… +${this.files.length - preview.length}`;
    }

    return [truncateToWidth(line, width)];
  }

  invalidate(): void {}
}

type OverlayResult =
  | { action: "open"; index: number }
  | { action: "remove"; index: number }
  | undefined;

class SessionFilesOverlay {
  private selected = 0;

  constructor(
    private readonly files: string[],
    private readonly done: (result: OverlayResult) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }

    if (this.files.length === 0) {
      if (matchesKey(data, "return")) this.done(undefined);
      return;
    }

    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }

    if (matchesKey(data, "down")) {
      this.selected = Math.min(this.files.length - 1, this.selected + 1);
      return;
    }

    if (matchesKey(data, "return")) {
      this.done({ action: "open", index: this.selected });
      return;
    }

    if (data === "x" || matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) {
      this.done({ action: "remove", index: this.selected });
    }
  }

  private row(content: string, innerWidth: number): string {
    const clipped = truncateToWidth(content, innerWidth);
    const padding = Math.max(0, innerWidth - visibleWidth(clipped));
    return `│${clipped}${" ".repeat(padding)}│`;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const lines: string[] = [];

    lines.push(`┌${"─".repeat(innerWidth)}┐`);
    lines.push(this.row(" Session files", innerWidth));
    lines.push(this.row("", innerWidth));

    if (this.files.length === 0) {
      lines.push(this.row(" (none pinned)", innerWidth));
      lines.push(this.row(" Use /pin <path>", innerWidth));
    } else {
      for (let i = 0; i < this.files.length; i++) {
        const marker = i === this.selected ? "▶" : " ";
        lines.push(this.row(` ${marker} ${i + 1}. ${this.files[i]}`, innerWidth));
      }
    }

    lines.push(this.row("", innerWidth));
    lines.push(this.row(" Enter=preview  x=remove  Esc=close", innerWidth));
    lines.push(`└${"─".repeat(innerWidth)}┘`);
    return lines;
  }

  invalidate(): void {}
}

type RecentTouchedOverlayResult =
  | { action: "pin"; indices: number[] }
  | { action: "extract-current-session" }
  | undefined;

class RecentTouchedOverlay {
  private selected = 0;
  private readonly selectedForPin = new Set<number>();

  constructor(
    private readonly files: string[],
    private readonly done: (result: RecentTouchedOverlayResult) => void,
  ) {}

  private totalItems(): number {
    return this.files.length + 1;
  }

  private getCurrentFileIndex(): number | undefined {
    if (this.selected === 0) return undefined;
    const index = this.selected - 1;
    if (index < 0 || index >= this.files.length) return undefined;
    return index;
  }

  private toggleCurrentSelection(): void {
    const index = this.getCurrentFileIndex();
    if (index === undefined) return;

    if (this.selectedForPin.has(index)) {
      this.selectedForPin.delete(index);
      return;
    }

    this.selectedForPin.add(index);
  }

  private removeCurrentSelection(): void {
    const index = this.getCurrentFileIndex();
    if (index === undefined) {
      this.selectedForPin.clear();
      return;
    }

    this.selectedForPin.delete(index);
  }

  private getSelectedIndices(): number[] {
    return [...this.selectedForPin]
      .filter((index) => index >= 0 && index < this.files.length)
      .sort((a, b) => a - b);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }

    if (matchesKey(data, "down")) {
      this.selected = Math.min(this.totalItems() - 1, this.selected + 1);
      return;
    }

    if (matchesKey(data, "space")) {
      this.toggleCurrentSelection();
      return;
    }

    if (data.toLowerCase() === "r") {
      this.removeCurrentSelection();
      return;
    }

    if (matchesKey(data, "return")) {
      const selectedIndices = this.getSelectedIndices();
      if (selectedIndices.length > 0) {
        this.done({ action: "pin", indices: selectedIndices });
        return;
      }

      if (this.selected === 0) {
        this.done({ action: "extract-current-session" });
        return;
      }

      const index = this.getCurrentFileIndex();
      if (index !== undefined) {
        this.done({ action: "pin", indices: [index] });
      }
    }
  }

  private row(content: string, innerWidth: number): string {
    const clipped = truncateToWidth(content, innerWidth);
    const padding = Math.max(0, innerWidth - visibleWidth(clipped));
    return `│${clipped}${" ".repeat(padding)}│`;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const lines: string[] = [];

    lines.push(`┌${"─".repeat(innerWidth)}┐`);
    lines.push(this.row(" Recently touched files (latest first)", innerWidth));
    lines.push(this.row("", innerWidth));

    const extractMarker = this.selected === 0 ? "▶" : " ";
    lines.push(this.row(` ${extractMarker} ✨ Extract from current session (LLM)`, innerWidth));

    if (this.files.length === 0) {
      lines.push(this.row("", innerWidth));
      lines.push(this.row(" (none detected yet in this session)", innerWidth));
    } else {
      lines.push(this.row("", innerWidth));
      for (let i = 0; i < this.files.length; i++) {
        const marker = this.selected === i + 1 ? "▶" : " ";
        const checked = this.selectedForPin.has(i) ? "x" : " ";
        lines.push(this.row(` ${marker} [${checked}] ${i + 1}. ${this.files[i]}`, innerWidth));
      }
    }

    const selectedCount = this.getSelectedIndices().length;
    if (selectedCount > 0) {
      lines.push(this.row("", innerWidth));
      lines.push(this.row(` Selected for pin: ${selectedCount}`, innerWidth));
    }

    lines.push(this.row("", innerWidth));
    lines.push(this.row(" Space=toggle checkbox  r=uncheck", innerWidth));
    lines.push(this.row(" Enter=pin/extract  Esc=close", innerWidth));
    lines.push(`└${"─".repeat(innerWidth)}┘`);
    return lines;
  }

  invalidate(): void {}
}

class FilePreviewOverlay {
  private scroll = 0;
  private activePreview: FilePreviewData;
  private alternatePreview: FilePreviewData | undefined;

  constructor(
    initialPreview: FilePreviewData,
    alternatePreview: FilePreviewData | undefined,
    private readonly theme: Theme,
    private readonly getTerminalRows: () => number,
    private readonly done: () => void,
  ) {
    this.activePreview = initialPreview;
    this.alternatePreview = alternatePreview;
  }

  private getViewportLines(): number {
    const terminalRows = Math.max(1, this.getTerminalRows());
    const chromeRows = this.activePreview.notice ? 8 : 7;
    const safetyRows = 1;
    const usableRows = terminalRows - PREVIEW_VERTICAL_MARGIN * 2;
    return Math.max(PREVIEW_MIN_VIEWPORT_LINES, usableRows - chromeRows - safetyRows);
  }

  private maxScroll(): number {
    return Math.max(0, this.activePreview.lines.length - this.getViewportLines());
  }

  private clampScroll(): void {
    this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll));
  }

  private togglePreviewMode(): void {
    if (!this.alternatePreview) return;
    const previous = this.activePreview;
    this.activePreview = this.alternatePreview;
    this.alternatePreview = previous;
    this.clampScroll();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data.toLowerCase() === "q") {
      this.done();
      return;
    }

    if (data.toLowerCase() === "v") {
      this.togglePreviewMode();
      return;
    }

    if (matchesKey(data, "up") || data.toLowerCase() === "k") {
      this.scroll -= 1;
      this.clampScroll();
      return;
    }

    if (matchesKey(data, "down") || data.toLowerCase() === "j") {
      this.scroll += 1;
      this.clampScroll();
      return;
    }

    if (matchesKey(data, "pageup") || data.toLowerCase() === "b" || matchesKey(data, "ctrl+b")) {
      this.scroll -= this.getViewportLines();
      this.clampScroll();
      return;
    }

    if (matchesKey(data, "pagedown") || data === " " || data.toLowerCase() === "f" || matchesKey(data, "ctrl+f")) {
      this.scroll += this.getViewportLines();
      this.clampScroll();
      return;
    }

    if (data.toLowerCase() === "u" || matchesKey(data, "ctrl+u")) {
      this.scroll -= Math.max(1, Math.floor(this.getViewportLines() / 2));
      this.clampScroll();
      return;
    }

    if (data.toLowerCase() === "d" || matchesKey(data, "ctrl+d")) {
      this.scroll += Math.max(1, Math.floor(this.getViewportLines() / 2));
      this.clampScroll();
      return;
    }

    if (matchesKey(data, "home")) {
      this.scroll = 0;
      return;
    }

    if (matchesKey(data, "end")) {
      this.scroll = this.maxScroll();
    }
  }

  private normalizeContentForRender(content: string): string {
    // Tabs can be measured differently than rendered width by terminals.
    // Expand them before truncation to keep rendered lines within bounds.
    return content.replace(/\t/g, "    ");
  }

  private row(content: string, innerWidth: number): string {
    const normalized = this.normalizeContentForRender(content);
    const clipped = truncateToWidth(normalized, innerWidth);
    const padding = Math.max(0, innerWidth - visibleWidth(clipped));
    return `│${clipped}${" ".repeat(padding)}│`;
  }

  private rowWithScrollbar(content: string, innerWidth: number, isThumb: boolean, lineKind?: PreviewLineKind): string {
    const contentWidth = Math.max(1, innerWidth - 2);
    const normalized = this.normalizeContentForRender(content);
    const clipped = truncateToWidth(normalized, contentWidth);
    const padding = Math.max(0, contentWidth - visibleWidth(clipped));
    let body = `${clipped}${" ".repeat(padding)}`;

    if (lineKind === "diff-added") {
      body = `${ANSI_DIFF_ADDED_BG}${ANSI_DIFF_ADDED}${body}${ANSI_RESET}`;
    } else if (lineKind === "diff-removed") {
      body = `${ANSI_DIFF_REMOVED_BG}${ANSI_DIFF_REMOVED}${body}${ANSI_RESET}`;
    }

    const scrollbarChar = isThumb
      ? this.theme.fg("accent", SCROLLBAR_THUMB_CHAR)
      : this.theme.fg("dim", SCROLLBAR_TRACK_CHAR);
    return `│${body} ${scrollbarChar}│`;
  }

  private renderDiffLine(line: PreviewLine, lineIndex: number): string {
    const displayLine = line.lineNumber ?? lineIndex + 1;
    const numbered = `${String(displayLine).padStart(4, " ")}  ${line.text}`;

    if (line.kind === "diff-added" || line.kind === "diff-removed") {
      return numbered;
    }

    if (line.kind === "diff-hunk") return colorizeAnsi(numbered, ANSI_DIFF_HUNK);
    if (line.kind === "diff-meta") return colorizeAnsi(numbered, ANSI_DIFF_META);
    return numbered;
  }

  private renderPreviewLine(line: PreviewLine, lineIndex: number): string {
    if (this.activePreview.mode === "diff") return this.renderDiffLine(line, lineIndex);
    return `${String(lineIndex + 1).padStart(4, " ")}  ${line.text}`;
  }

  private getScrollbarInfo(viewportLines: number): { thumbStart: number; thumbSize: number } {
    if (viewportLines <= 0) return { thumbStart: 0, thumbSize: 0 };

    const totalLines = this.activePreview.lines.length;
    if (totalLines <= viewportLines) {
      return { thumbStart: 0, thumbSize: viewportLines };
    }

    const thumbSize = Math.max(1, Math.floor((viewportLines * viewportLines) / totalLines));
    const maxThumbStart = Math.max(0, viewportLines - thumbSize);
    const maxScroll = Math.max(1, totalLines - viewportLines);
    const thumbStart = Math.floor((this.scroll / maxScroll) * maxThumbStart);

    return { thumbStart, thumbSize };
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const out: string[] = [];

    const viewportLines = this.getViewportLines();
    this.clampScroll();
    const visibleStart = this.scroll;
    const { thumbStart, thumbSize } = this.getScrollbarInfo(viewportLines);

    out.push(`┌${"─".repeat(innerWidth)}┐`);
    const languageSuffix =
      this.activePreview.mode === "file" && this.activePreview.language ? ` (${this.activePreview.language})` : "";
    const title = this.activePreview.mode === "diff" ? " Diff preview" : " File preview";
    out.push(this.row(`${title}: ${this.activePreview.label}${languageSuffix}`, innerWidth));
    if (this.activePreview.notice) {
      out.push(this.row(` ${this.activePreview.notice}`, innerWidth));
    }
    out.push(this.row("", innerWidth));

    for (let rowIndex = 0; rowIndex < viewportLines; rowIndex++) {
      const lineIndex = visibleStart + rowIndex;
      const hasLine = lineIndex < this.activePreview.lines.length;
      const line = hasLine ? this.activePreview.lines[lineIndex] : undefined;
      const renderedLine = hasLine && line ? this.renderPreviewLine(line, lineIndex) : "";
      const isThumb = rowIndex >= thumbStart && rowIndex < thumbStart + thumbSize;
      out.push(this.rowWithScrollbar(renderedLine, innerWidth, isThumb, line?.kind));
    }

    out.push(this.row("", innerWidth));
    out.push(this.row(" ↑↓/j/k line  Space/f next-page  b prev-page  u/d half-page", innerWidth));
    const viewToggleHint = this.alternatePreview ? "  v toggle view" : "";
    out.push(this.row(` Ctrl+f/Ctrl+b page  Home/End top/bottom${viewToggleHint}  Esc/q close`, innerWidth));
    out.push(`└${"─".repeat(innerWidth)}┘`);

    return out;
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  let files: string[] = [];
  let recentTouchedFiles: string[] = [];
  let diffPreviewEnabled = true;

  const renderWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (files.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, () => new SessionFilesWidget([...files]));
  };

  const persistAndRender = (ctx: ExtensionContext) => {
    files = dedupe(files);
    pi.appendEntry(STATE_ENTRY_TYPE, { files: [...files] });
    renderWidget(ctx);
  };

  const pushRecentTouched = (target: string) => {
    const normalized = target.trim();
    if (!normalized) return;
    recentTouchedFiles = recentTouchedFiles.filter((item) => item !== normalized);
    recentTouchedFiles.unshift(normalized);
    if (recentTouchedFiles.length > RECENT_TOUCHED_MAX) {
      recentTouchedFiles = recentTouchedFiles.slice(0, RECENT_TOUCHED_MAX);
    }
  };

  const reconstructState = async (ctx: ExtensionContext) => {
    let latest: string[] = [];
    const reconstructedTouched: string[] = [];

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom") {
        const customEntry = entry as unknown as { customType?: string; data?: { files?: unknown } };
        if (customEntry.customType === STATE_ENTRY_TYPE) {
          const candidate = customEntry.data?.files;
          if (Array.isArray(candidate)) {
            latest = candidate.filter((item): item is string => typeof item === "string");
          }
        }
        continue;
      }

      if (entry.type !== "message") continue;
      const messageEntry = entry as unknown as {
        message?: { toolName?: unknown; name?: unknown; input?: unknown; args?: unknown };
      };
      const toolNameRaw = messageEntry.message?.toolName ?? messageEntry.message?.name;
      const toolName = typeof toolNameRaw === "string" ? toolNameRaw : undefined;
      const inputCandidate = messageEntry.message?.input ?? messageEntry.message?.args;
      const input =
        inputCandidate && typeof inputCandidate === "object"
          ? (inputCandidate as Record<string, unknown>)
          : undefined;

      if (!toolName || !input) continue;
      const touched = await getTouchedPathsFromToolInput(toolName, input, ctx.cwd);
      for (const touchedPath of touched) {
        const normalized = touchedPath.trim();
        if (!normalized) continue;
        const existingIndex = reconstructedTouched.indexOf(normalized);
        if (existingIndex >= 0) reconstructedTouched.splice(existingIndex, 1);
        reconstructedTouched.unshift(normalized);
        if (reconstructedTouched.length > RECENT_TOUCHED_MAX) reconstructedTouched.pop();
      }
    }

    files = dedupe(latest);
    recentTouchedFiles = reconstructedTouched.slice(0, RECENT_TOUCHED_MAX);
    renderWidget(ctx);
  };

  const tryParseIndex = (value: string, maxLength: number): number | undefined => {
    const numeric = Number(value.trim());
    if (!Number.isInteger(numeric)) return undefined;
    const index = numeric - 1;
    if (index < 0 || index >= maxLength) return undefined;
    return index;
  };

  const previewPinnedFile = async (ctx: ExtensionContext, index: number) => {
    const target = files[index];
    if (!target) {
      ctx.ui.notify("Invalid pin index", "warning");
      return;
    }

    try {
      const preview = await getPreviewData(target, ctx.cwd, diffPreviewEnabled);
      const alternateCandidate = await getPreviewData(target, ctx.cwd, !diffPreviewEnabled);
      const alternatePreview = alternateCandidate.mode !== preview.mode ? alternateCandidate : undefined;

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new FilePreviewOverlay(preview, alternatePreview, theme, () => tui.terminal.rows, () => done(undefined)),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "100%",
            minWidth: 60,
            maxHeight: "100%",
            margin: {
              top: PREVIEW_VERTICAL_MARGIN,
              bottom: PREVIEW_VERTICAL_MARGIN,
              left: PREVIEW_HORIZONTAL_MARGIN,
              right: PREVIEW_HORIZONTAL_MARGIN,
            },
          },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not preview ${target}: ${message}`, "error");
    }
  };

  const insertPinnedIntoEditor = (ctx: ExtensionContext, index: number) => {
    const target = files[index];
    if (!target) {
      ctx.ui.notify("Invalid pin index", "warning");
      return;
    }

    ctx.ui.pasteToEditor(`@${target} `);
    ctx.ui.notify(`Inserted @${target} into editor`, "info");
  };

  const removePin = (ctx: ExtensionContext, index: number) => {
    const target = files[index];
    if (!target) {
      ctx.ui.notify("Invalid pin index", "warning");
      return;
    }

    files.splice(index, 1);
    persistAndRender(ctx);
    ctx.ui.notify(`Unpinned ${target}`, "info");
  };

  const pinRecentTouchedIndices = async (ctx: ExtensionContext, indices: number[]) => {
    const uniqueIndices = [...new Set(indices.filter((index) => Number.isInteger(index)))].sort((a, b) => a - b);
    if (uniqueIndices.length === 0) {
      ctx.ui.notify("No touched files selected", "warning");
      return;
    }

    const pinned: string[] = [];
    const alreadyPinned: string[] = [];
    const failures: Array<{ target: string; message: string }> = [];

    for (const index of uniqueIndices) {
      const target = recentTouchedFiles[index];
      if (!target) {
        failures.push({ target: `#${index + 1}`, message: "Invalid touched-file index" });
        continue;
      }

      try {
        const storedPath = await getStoredPathForCwd(target, ctx.cwd);
        if (files.includes(storedPath)) {
          alreadyPinned.push(storedPath);
          continue;
        }

        files.push(storedPath);
        pinned.push(storedPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ target, message });
      }
    }

    if (pinned.length > 0) {
      persistAndRender(ctx);
      if (pinned.length === 1) {
        ctx.ui.notify(`Pinned ${pinned[0]}`, "info");
      } else {
        ctx.ui.notify(`Pinned ${pinned.length} touched files`, "info");
      }
    }

    if (alreadyPinned.length > 0) {
      if (alreadyPinned.length === 1) {
        ctx.ui.notify(`Already pinned: ${alreadyPinned[0]}`, "info");
      } else {
        ctx.ui.notify(`${alreadyPinned.length} selected files were already pinned`, "info");
      }
    }

    if (failures.length > 0) {
      if (failures.length === 1) {
        const failure = failures[0];
        ctx.ui.notify(`Could not pin touched file ${failure.target}: ${failure.message}`, "error");
      } else {
        ctx.ui.notify(`Could not pin ${failures.length} selected touched files`, "error");
      }
    }
  };

  const pinRecentTouched = async (ctx: ExtensionContext, index: number) => {
    await pinRecentTouchedIndices(ctx, [index]);
  };

  pi.on("tool_call", async (event, ctx) => {
    let touched: string[] = [];

    if (isToolCallEventType("read", event) || isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      touched = await getTouchedPathsFromToolInput(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
    } else if (isToolCallEventType("bash", event)) {
      touched = await getTouchedPathsFromToolInput("bash", event.input as Record<string, unknown>, ctx.cwd);
    }

    for (const touchedPath of touched) {
      pushRecentTouched(touchedPath);
    }
  });

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.registerCommand("pin", {
    description: "Pin an important file for this session",
    handler: async (args, ctx) => {
      const rawPath = args.trim();
      if (!rawPath) {
        ctx.ui.notify("Usage: /pin <path>", "warning");
        return;
      }

      try {
        const storedPath = await getStoredPathForCwd(rawPath, ctx.cwd);
        if (files.includes(storedPath)) {
          ctx.ui.notify(`Already pinned: ${storedPath}`, "info");
          return;
        }

        files.push(storedPath);
        persistAndRender(ctx);
        ctx.ui.notify(`Pinned ${storedPath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not pin file: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("unpin", {
    description: "Unpin a file by index or path",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        ctx.ui.notify("Usage: /unpin <index|path>", "warning");
        return;
      }

      const index = tryParseIndex(raw, files.length);
      if (index !== undefined) {
        removePin(ctx, index);
        return;
      }

      const direct = stripAtPrefix(stripWrappingQuotes(raw));
      let pathMatch = files.findIndex((file) => file === direct);

      if (pathMatch === -1) {
        try {
          const normalized = await getStoredPathForCwd(raw, ctx.cwd);
          pathMatch = files.findIndex((file) => file === normalized);
        } catch {
          // Ignore normalization errors and fall through to not-found message.
        }
      }

      if (pathMatch === -1) {
        ctx.ui.notify(`Not pinned: ${raw}`, "warning");
        return;
      }

      removePin(ctx, pathMatch);
    },
  });

  pi.registerCommand("pin-open", {
    description: "Preview a pinned file by index",
    handler: async (args, ctx) => {
      const index = tryParseIndex(args.trim(), files.length);
      if (index === undefined) {
        ctx.ui.notify("Usage: /pin-open <index>", "warning");
        return;
      }

      await previewPinnedFile(ctx, index);
    },
  });

  pi.registerCommand("pin-insert", {
    description: "Insert @file for a pinned file by index",
    handler: async (args, ctx) => {
      const index = tryParseIndex(args.trim(), files.length);
      if (index === undefined) {
        ctx.ui.notify("Usage: /pin-insert <index>", "warning");
        return;
      }

      insertPinnedIntoEditor(ctx, index);
    },
  });

  pi.registerCommand("pin-touched", {
    description: "Pin a recently touched file (read/edit/write/bash)",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw) {
        const index = tryParseIndex(raw, recentTouchedFiles.length);
        if (index === undefined) {
          ctx.ui.notify("Usage: /pin-touched <index> (or no args for picker)", "warning");
          return;
        }

        await pinRecentTouched(ctx, index);
        return;
      }

      while (true) {
        const result = await ctx.ui.custom<RecentTouchedOverlayResult>(
          (_tui, _theme, _keybindings, done) => new RecentTouchedOverlay([...recentTouchedFiles], done),
          {
            overlay: true,
            overlayOptions: {
              anchor: "left-center",
              width: "42%",
              minWidth: 42,
              maxHeight: "70%",
              margin: { left: 1, top: 1, bottom: 1, right: 1 },
            },
          },
        );

        if (!result) return;

        if (result.action === "pin") {
          await pinRecentTouchedIndices(ctx, result.indices);
          return;
        }

        if (result.action === "extract-current-session") {
          const extracted = await extractFilesFromCurrentSession(ctx);
          if (!extracted || extracted.length === 0) {
            continue;
          }

          for (const extractedPath of [...extracted].reverse()) {
            pushRecentTouched(extractedPath);
          }

          const plural = extracted.length === 1 ? "file" : "files";
          ctx.ui.notify(`Added ${extracted.length} ${plural} from current session`, "info");
        }
      }
    },
  });

  pi.registerCommand("pins", {
    description: "Open the session-files overlay panel",
    handler: async (_args, ctx) => {
      const result = await ctx.ui.custom<OverlayResult>(
        (_tui, _theme, _keybindings, done) => new SessionFilesOverlay([...files], done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "left-center",
            width: "34%",
            minWidth: 34,
            maxHeight: "70%",
            margin: { left: 1, top: 1, bottom: 1, right: 1 },
          },
        },
      );

      if (!result) return;
      if (result.action === "open") {
        await previewPinnedFile(ctx, result.index);
        return;
      }
      if (result.action === "remove") {
        removePin(ctx, result.index);
      }
    },
  });

  pi.registerCommand("pin-diff", {
    description: "Toggle diff previews for changed pinned files",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();

      if (!value || value === "toggle") {
        diffPreviewEnabled = !diffPreviewEnabled;
      } else if (["on", "true", "1", "yes"].includes(value)) {
        diffPreviewEnabled = true;
      } else if (["off", "false", "0", "no"].includes(value)) {
        diffPreviewEnabled = false;
      } else if (value === "status") {
        // No-op, just report below.
      } else {
        ctx.ui.notify("Usage: /pin-diff [on|off|toggle|status]", "warning");
        return;
      }

      const status = diffPreviewEnabled ? "ON" : "OFF";
      ctx.ui.notify(`Diff preview is ${status}`, "info");
    },
  });

  pi.registerCommand("pins-clear", {
    description: "Clear all pinned session files",
    handler: async (_args, ctx) => {
      files = [];
      persistAndRender(ctx);
      ctx.ui.notify("Cleared pinned session files", "info");
    },
  });
}
