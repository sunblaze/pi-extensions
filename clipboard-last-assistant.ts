import { execFile } from "node:child_process";

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type LastAssistantOutput = {
  text: string;
  stopReason: string | undefined;
};

function extractTextBlocks(message: AssistantMessage): string {
  const parts = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);

  return parts.join("\n\n").trim();
}

function getLastAssistantOutput(ctx: ExtensionContext): LastAssistantOutput | undefined {
  const branch = ctx.sessionManager.getBranch();

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;

    const message = entry.message as AssistantMessage;
    return {
      text: extractTextBlocks(message),
      stopReason: message.stopReason,
    };
  }

  return undefined;
}

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("pbcopy", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });

    child.stdin?.on("error", reject);
    child.stdin?.end(text);
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cp", {
    description: "Copy the last assistant output to the macOS clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (process.platform !== "darwin") {
        ctx.ui.notify("/cp currently supports macOS only (uses pbcopy).", "error");
        return;
      }

      const last = getLastAssistantOutput(ctx);
      if (!last) {
        ctx.ui.notify("No assistant output found in this session yet.", "warning");
        return;
      }

      if (!last.text) {
        ctx.ui.notify("Last assistant message has no text content to copy.", "warning");
        return;
      }

      try {
        await copyToClipboard(last.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to copy to clipboard: ${message}`, "error");
        return;
      }

      if (last.stopReason && last.stopReason !== "stop") {
        ctx.ui.notify(
          `Copied last assistant output (message stop reason: ${last.stopReason}).`,
          "info",
        );
        return;
      }

      ctx.ui.notify("Copied last assistant output to clipboard.", "info");
    },
  });
}
