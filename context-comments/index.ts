import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type KeyId, type TUI } from "@mariozechner/pi-tui";

type PiTheme = ExtensionContext["ui"]["theme"];

const CUSTOM_TYPE = "context-comments";

type ContextLine = {
  id: string;
  entryId: string;
  role: string;
  lineNumber: number;
  text: string;
};

type SavedComment = {
  id: string;
  entryId: string;
  startLine: number;
  endLine: number;
  selectedText: string[];
  selectedLineIds?: string[];
  comment: string;
  createdAt: string;
};

type PersistedEntry =
  | { op: "add"; comment: SavedComment }
  | { op: "clear"; at: string };

type ShortcutAction = "addComment" | "submitComments";
type ShortcutConfig = Record<ShortcutAction, string>;

type ExtensionConfig = {
  shortcuts?: Partial<ShortcutConfig>;
};

const EXTENSION_NAME = "context-comments";
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", EXTENSION_NAME);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_SHORTCUTS: ShortcutConfig = {
  addComment: "ctrl+alt+c",
  submitComments: "ctrl+alt+s",
};

function normalizeShortcutKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s*\+\s*/g, "+");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveShortcuts(config: ExtensionConfig): { shortcuts: ShortcutConfig; warnings: string[] } {
  const warnings: string[] = [];
  const resolved: ShortcutConfig = { ...DEFAULT_SHORTCUTS };

  const shortcuts = config.shortcuts;
  if (shortcuts && isRecord(shortcuts)) {
    for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      const candidate = shortcuts[action];
      if (typeof candidate !== "string") continue;
      const normalized = normalizeShortcutKey(candidate);
      if (!normalized) {
        warnings.push(`Ignoring empty shortcut for ${action}.`);
        continue;
      }
      resolved[action] = normalized;
    }
  }

  const seen = new Set<string>();
  for (const action of Object.keys(resolved) as ShortcutAction[]) {
    const key = resolved[action];
    if (seen.has(key)) {
      warnings.push(`Shortcut conflict for ${action} (${key}); reverted to default ${DEFAULT_SHORTCUTS[action]}.`);
      resolved[action] = DEFAULT_SHORTCUTS[action];
      continue;
    }
    seen.add(key);
  }

  return { shortcuts: resolved, warnings };
}

function readConfig(): { config: ExtensionConfig; warnings: string[] } {
  if (!fs.existsSync(CONFIG_PATH)) return { config: {}, warnings: [] };

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        config: {},
        warnings: [`Ignoring invalid config at ${CONFIG_PATH}: expected top-level object.`],
      };
    }
    return { config: parsed as ExtensionConfig, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: {},
      warnings: [`Ignoring unreadable config at ${CONFIG_PATH}: ${message}`],
    };
  }
}

function writeConfig(config: ExtensionConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function plainTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking]\n${block.thinking}`;
      if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "tool";
        return `[tool call: ${name}]`;
      }
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function linesFromContext(ctx: ExtensionContext): ContextLine[] {
  const lines: ContextLine[] = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") {
      const message = entry.message as unknown as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "message";
      let text = plainTextContent(message.content);

      if (role === "bashExecution") {
        text = `$ ${(message.command as string | undefined) ?? ""}\n${(message.output as string | undefined) ?? ""}`.trimEnd();
      } else if (role === "branchSummary") {
        text = (message.summary as string | undefined) ?? "";
      } else if (role === "compactionSummary") {
        text = (message.summary as string | undefined) ?? "";
      } else if (role === "custom") {
        text = plainTextContent(message.content);
      }

      const split = text.length > 0 ? text.split("\n") : ["(empty)"];
      split.forEach((line, i) => {
        lines.push({
          id: `${entry.id}:${i + 1}`,
          entryId: entry.id,
          role,
          lineNumber: i + 1,
          text: line,
        });
      });
      continue;
    }

    if (entry.type === "compaction") {
      const split = (entry.summary ?? "").split("\n");
      split.forEach((line, i) => {
        lines.push({ id: `${entry.id}:${i + 1}`, entryId: entry.id, role: "compaction", lineNumber: i + 1, text: line });
      });
      continue;
    }

    if (entry.type === "branch_summary") {
      const split = (entry.summary ?? "").split("\n");
      split.forEach((line, i) => {
        lines.push({ id: `${entry.id}:${i + 1}`, entryId: entry.id, role: "branch", lineNumber: i + 1, text: line });
      });
    }
  }

  return lines;
}

function restoreComments(ctx: ExtensionContext): SavedComment[] {
  const comments: SavedComment[] = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data as PersistedEntry | undefined;
    if (!data) continue;

    if (data.op === "clear") {
      comments.length = 0;
    } else if (data.op === "add") {
      comments.push(data.comment);
    }
  }

  return comments;
}

function formatForEditor(comments: SavedComment[]): string {
  return comments
    .map((saved, i) => {
      const quote = saved.selectedText.map((line) => `> ${line}`).join("\n");
      return `Comment ${i + 1}:\n${quote}\n\n${saved.comment}`;
    })
    .join("\n\n");
}

const ANSI_ESCAPE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\)|_[\s\S]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function sanitizeDisplayText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r/g, "")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(/\t/g, "  ");
}

function fitToWidth(text: string, width: number): string {
  const fitted = truncateToWidth(text, Math.max(0, width));
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

type PickerResult = "submit" | null;

class CommentPicker implements Component, Focusable {
  private selected: number;
  private anchor: number | undefined;
  private mode: "select" | "comment" = "select";
  private input = new Input();
  private _focused = false;
  private lastVisibleHeight = 14;

  private readonly commentedLineIds: Set<string>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: PiTheme,
    private readonly lines: ContextLine[],
    initiallyCommentedLineIds: string[],
    private readonly done: (result: PickerResult) => void,
    private readonly onSave: (result: { selectedLines: ContextLine[]; comment: string }) => void,
  ) {
    this.selected = Math.max(0, this.lines.length - 1);
    this.commentedLineIds = new Set(initiallyCommentedLineIds);
    this.configureInput();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.mode === "comment";
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode === "comment") {
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    if (data === "s" && this.commentedLineIds.size > 0) {
      this.done("submit");
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.moveBy(1);
      return;
    }
    if (data === "<" || data === ",") {
      this.moveTo(0);
      return;
    }
    if (data === ">" || data === ".") {
      this.moveTo(this.lines.length - 1);
      return;
    }
    if (data === "b") {
      this.moveBy(-this.visibleHeight());
      return;
    }
    if (data === "f") {
      this.moveBy(this.visibleHeight());
      return;
    }
    if (matchesKey(data, Key.ctrl("u")) || data === "u") {
      this.moveBy(-Math.max(1, Math.floor(this.visibleHeight() / 2)));
      return;
    }
    if (matchesKey(data, Key.ctrl("d")) || data === "d") {
      this.moveBy(Math.max(1, Math.floor(this.visibleHeight() / 2)));
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.anchor = this.anchor === undefined ? this.selected : undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.mode = "comment";
      this.input.focused = this.focused;
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const border = this.theme.fg("accent", "─".repeat(Math.max(0, width)));
    const header = this.theme.fg("accent", this.theme.bold("Add context comment"));
    const canSubmit = this.commentedLineIds.size > 0;
    const help = this.theme.fg(
      "dim",
      `↑↓/jk move • f/b page • d/u half-page • </> or ,/. start/end • space anchor • enter comment${canSubmit ? " • s submit all" : ""} • esc cancel`,
    );
    const totalHeight = this.totalHeight();
    const inputBudget = this.mode === "comment" ? Math.max(3, Math.min(8, Math.floor(totalHeight * 0.3))) : 0;
    const fixedRows = this.mode === "comment" ? 5 + inputBudget : 3;
    const visibleHeight = Math.max(3, totalHeight - fixedRows);
    this.lastVisibleHeight = visibleHeight;

    const start = Math.max(0, Math.min(this.selected - Math.floor(visibleHeight / 2), this.lines.length - visibleHeight));
    const end = Math.min(this.lines.length, start + visibleHeight);
    const selection = this.selectionBounds();

    const rendered: string[] = [border, fitToWidth(` ${header}  ${help}`, width)];

    for (let i = start; i < end; i++) {
      const line = this.lines[i]!;
      const isCursor = i === this.selected;
      const isSelected = selection !== undefined && i >= selection.start && i <= selection.end;
      const wasCommented = this.commentedLineIds.has(line.id);
      const marker = isSelected ? "●" : wasCommented ? "○" : " ";
      const role = this.theme.fg("muted", line.role.padEnd(10).slice(0, 10));
      const loc = this.theme.fg("dim", `${line.entryId}:${line.lineNumber}`.padEnd(14).slice(0, 14));
      let text = fitToWidth(`${isCursor ? "›" : " "}${marker} ${role} ${loc} ${sanitizeDisplayText(line.text)}`, width);
      if (isCursor) text = this.theme.bg("selectedBg", text);
      rendered.push(text);
    }

    if (this.mode === "comment") {
      rendered.push(border);
      rendered.push(this.theme.fg("accent", " Comment (enter to save, esc to return):"));
      const inputLines = this.input.render(Math.max(1, width - 2));
      const visibleInputLines = inputLines.slice(-inputBudget);
      for (const inputLine of visibleInputLines) {
        rendered.push(fitToWidth(` ${sanitizeDisplayText(inputLine)}`, width));
      }
    }

    rendered.push(border);
    return rendered;
  }

  private configureInput(): void {
    this.input.onSubmit = (value) => {
      const comment = value.trim();
      if (!comment) return;
      const selectedLines = this.currentSelection();
      this.onSave({ selectedLines, comment });
      for (const line of selectedLines) {
        this.commentedLineIds.add(line.id);
      }
      this.anchor = undefined;
      this.mode = "select";
      this.input = new Input();
      this.configureInput();
      this.input.focused = false;
      this.tui.requestRender();
    };
    this.input.onEscape = () => {
      this.mode = "select";
      this.input.focused = false;
      this.tui.requestRender();
    };
  }

  private visibleHeight(): number {
    return this.lastVisibleHeight;
  }

  private totalHeight(): number {
    return Math.max(12, (process.stdout.rows ?? 24) - 2);
  }

  private moveTo(index: number): void {
    this.selected = Math.max(0, Math.min(this.lines.length - 1, index));
    this.tui.requestRender();
  }

  private moveBy(delta: number): void {
    this.moveTo(this.selected + delta);
  }

  private selectionBounds(): { start: number; end: number } | undefined {
    if (this.anchor === undefined) return { start: this.selected, end: this.selected };
    return { start: Math.min(this.anchor, this.selected), end: Math.max(this.anchor, this.selected) };
  }

  private currentSelection(): ContextLine[] {
    const bounds = this.selectionBounds();
    if (!bounds) return [this.lines[this.selected]!];
    return this.lines.slice(bounds.start, bounds.end + 1);
  }
}

export default function (pi: ExtensionAPI) {
  let comments: SavedComment[] = [];

  const loadedConfig = readConfig();
  const resolved = resolveShortcuts(loadedConfig.config);
  let shortcuts = resolved.shortcuts;
  const configWarnings = [...loadedConfig.warnings, ...resolved.warnings];

  function formatShortcutSummary(current: ShortcutConfig): string {
    return (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[])
      .map((action) => `${action}: ${current[action]}`)
      .join("\n");
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(CUSTOM_TYPE, comments.length > 0 ? `💬 ${comments.length} context comment${comments.length === 1 ? "" : "s"}` : undefined);
  }

  function clearComments(ctx: ExtensionContext, notify?: string) {
    comments = [];
    pi.appendEntry(CUSTOM_TYPE, { op: "clear", at: new Date().toISOString() } satisfies PersistedEntry);
    updateStatus(ctx);
    if (notify) ctx.ui.notify(notify, "info");
  }

  function promptIncludesSubmittedComments(prompt: string, savedComments: SavedComment[]): boolean {
    return (
      savedComments.length > 0 &&
      savedComments.every((saved) => {
        const quote = saved.selectedText.map((line) => `> ${line}`).join("\n");
        return prompt.includes(quote) && prompt.includes(saved.comment);
      })
    );
  }

  pi.on("session_start", (_event, ctx) => {
    comments = restoreComments(ctx);
    updateStatus(ctx);
    for (const warning of configWarnings) {
      ctx.ui.notify(`context-comments: ${warning}`, "warning");
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    comments = restoreComments(ctx);
    if (!promptIncludesSubmittedComments(event.prompt, comments)) return;
    clearComments(ctx, "Cleared submitted context comments.");
  });

  async function addComment(ctx: ExtensionContext) {
    comments = restoreComments(ctx);
    const contextLines = linesFromContext(ctx);
    if (contextLines.length === 0) {
      ctx.ui.notify("No session context lines to comment on yet.", "warning");
      return;
    }

    const initiallyCommentedLineIds = comments.flatMap((comment) => comment.selectedLineIds ?? []);

    const pickerResult = await ctx.ui.custom<PickerResult>(
      (tui, theme, _keybindings, done) =>
        new CommentPicker(tui, theme, contextLines, initiallyCommentedLineIds, done, (result) => {
          const first = result.selectedLines[0]!;
          const last = result.selectedLines[result.selectedLines.length - 1]!;
          const saved: SavedComment = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            entryId: first.entryId === last.entryId ? first.entryId : `${first.entryId}..${last.entryId}`,
            startLine: first.lineNumber,
            endLine: last.lineNumber,
            selectedText: result.selectedLines.map((line) => line.text),
            selectedLineIds: result.selectedLines.map((line) => line.id),
            comment: result.comment,
            createdAt: new Date().toISOString(),
          };

          comments.push(saved);
          pi.appendEntry(CUSTOM_TYPE, { op: "add", comment: saved } satisfies PersistedEntry);
          updateStatus(ctx);
          ctx.ui.notify(`Saved context comment ${comments.length}.`, "info");
        }),
      { overlay: false },
    );

    if (pickerResult === "submit") {
      await submitComments(ctx);
    }
  }

  const commandUsage = [
    "Usage:",
    "  /context-comments add",
    "  /context-comments list",
    "  /context-comments clear",
    "  /context-comments submit",
    "  /context-comments shortcuts",
    "  /context-comments shortcuts set <addComment|submitComments> <shortcut>",
    "  /context-comments shortcuts reset <addComment|submitComments|all>",
  ].join("\n");

  async function submitComments(ctx: ExtensionContext) {
    comments = restoreComments(ctx);
    updateStatus(ctx);
    if (comments.length === 0) {
      ctx.ui.notify("No saved context comments to submit.", "warning");
      return;
    }

    const formatted = formatForEditor(comments);
    const existing = ctx.ui.getEditorText().trimEnd();
    ctx.ui.setEditorText(existing ? `${existing}\n\n${formatted}` : formatted);
    clearComments(ctx, "Inserted context comments into the query box and cleared saved comments.");
  }

  pi.registerCommand("context-comments", {
    description: "Manage context comments (add, list, clear, submit, shortcuts)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommandRaw, ...rest] = trimmed.split(/\s+/).filter(Boolean);
      const subcommand = (subcommandRaw ?? "add").toLowerCase();
      const subArgs = rest.join(" ").trim();

      if (subcommand === "add") {
        await addComment(ctx);
        return;
      }

      if (subcommand === "list" || subcommand === "ls") {
        comments = restoreComments(ctx);
        updateStatus(ctx);
        if (comments.length === 0) {
          ctx.ui.notify("No saved context comments.", "info");
          return;
        }

        const summary = comments.map((comment, i) => `${i + 1}. ${comment.selectedText[0] ?? ""}\n   ${comment.comment}`).join("\n\n");
        await ctx.ui.editor("Saved context comments", summary);
        return;
      }

      if (subcommand === "clear") {
        comments = restoreComments(ctx);
        if (comments.length === 0) {
          ctx.ui.notify("No saved context comments to clear.", "info");
          return;
        }
        const ok = await ctx.ui.confirm("Clear context comments?", `Delete ${comments.length} saved comment${comments.length === 1 ? "" : "s"}?`);
        if (!ok) return;
        clearComments(ctx, "Cleared context comments.");
        return;
      }

      if (subcommand === "submit") {
        await submitComments(ctx);
        return;
      }

      if (subcommand === "shortcuts" || subcommand === "shortcut") {
        if (!subArgs) {
          ctx.ui.notify(`Current shortcuts:\n${formatShortcutSummary(shortcuts)}\n\nConfig: ${CONFIG_PATH}`, "info");
          return;
        }

        const shortcutParts = subArgs.split(/\s+/);
        const shortcutCommand = shortcutParts[0]?.toLowerCase();

        if (shortcutCommand === "set") {
          const action = shortcutParts[1] as ShortcutAction | undefined;
          const rawShortcut = shortcutParts.slice(2).join(" ");
          if (!action || !(action in DEFAULT_SHORTCUTS) || !rawShortcut.trim()) {
            ctx.ui.notify("Usage: /context-comments shortcuts set <addComment|submitComments> <shortcut>", "warning");
            return;
          }

          const normalized = normalizeShortcutKey(rawShortcut);
          if (!normalized) {
            ctx.ui.notify("Shortcut cannot be empty.", "warning");
            return;
          }

          const nextConfig = readConfig().config;
          nextConfig.shortcuts = { ...(isRecord(nextConfig.shortcuts) ? nextConfig.shortcuts : {}), [action]: normalized };
          writeConfig(nextConfig);

          shortcuts = resolveShortcuts(nextConfig).shortcuts;
          ctx.ui.notify(`Saved ${action} = ${normalized} to ${CONFIG_PATH}. Restart pi to apply shortcut changes.`, "info");
          return;
        }

        if (shortcutCommand === "reset") {
          const actionArg = shortcutParts[1] as ShortcutAction | "all" | undefined;
          const nextConfig = readConfig().config;

          if (actionArg === "all") {
            nextConfig.shortcuts = {};
            writeConfig(nextConfig);
            shortcuts = { ...DEFAULT_SHORTCUTS };
            ctx.ui.notify(`Reset all shortcuts to defaults in ${CONFIG_PATH}. Restart pi to apply shortcut changes.`, "info");
            return;
          }

          if (!actionArg || !(actionArg in DEFAULT_SHORTCUTS)) {
            ctx.ui.notify("Usage: /context-comments shortcuts reset <addComment|submitComments|all>", "warning");
            return;
          }

          if (isRecord(nextConfig.shortcuts)) {
            delete nextConfig.shortcuts[actionArg];
          }
          writeConfig(nextConfig);
          shortcuts = resolveShortcuts(nextConfig).shortcuts;
          ctx.ui.notify(`Reset ${actionArg} to default (${DEFAULT_SHORTCUTS[actionArg]}). Restart pi to apply shortcut changes.`, "info");
          return;
        }

        ctx.ui.notify("Usage: /context-comments shortcuts [set <addComment|submitComments> <shortcut> | reset <addComment|submitComments|all>]", "warning");
        return;
      }

      if (subcommand === "help") {
        ctx.ui.notify(commandUsage, "info");
        return;
      }

      ctx.ui.notify(`Unknown subcommand: ${subcommand}\n\n${commandUsage}`, "warning");
    },
  });

  const shortcutHandlers: Record<ShortcutAction, { description: string; handler: (ctx: ExtensionContext) => Promise<void> }> = {
    addComment: {
      description: "Add a context comment",
      handler: async (ctx) => addComment(ctx),
    },
    submitComments: {
      description: "Submit saved context comments",
      handler: async (ctx) => submitComments(ctx),
    },
  };

  for (const action of Object.keys(shortcutHandlers) as ShortcutAction[]) {
    pi.registerShortcut(shortcuts[action] as KeyId, {
      description: shortcutHandlers[action].description,
      handler: shortcutHandlers[action].handler,
    });
  }
}
