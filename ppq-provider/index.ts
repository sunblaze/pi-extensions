import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "ppq-provider.json");
const DEFAULT_MODELS = [
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2-Codex",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.84, output: 14.7, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
];

type ModelConfig = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresMistralToolIds?: boolean;
    thinkingFormat?: "openai" | "zai" | "qwen";
  };
  headers?: Record<string, string>;
};

type ExtensionConfig = {
  models?: ModelConfig[];
};

function loadConfig(path = CONFIG_PATH): ExtensionConfig {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ExtensionConfig;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function ensureConfigFile(path = CONFIG_PATH) {
  try {
    if (existsSync(path)) return;
    const initial: ExtensionConfig = { models: DEFAULT_MODELS };
    writeFileSync(path, JSON.stringify(initial, null, 2));
  } catch {}
}

function normalizeModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cacheRead ?? 0,
      cacheWrite: m.cost?.cacheWrite ?? 0,
    },
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 16384,
    compat: m.compat,
    headers: m.headers,
  }));
}

export default function (pi: ExtensionAPI) {
  ensureConfigFile();
  const config = loadConfig();
  const models = normalizeModels(
    Array.isArray(config.models) && config.models.length > 0
      ? config.models
      : DEFAULT_MODELS
  );

  pi.registerProvider("ppq", {
    baseUrl: "https://api.ppq.ai/v1",
    apiKey: "PPQ_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models,
    compat: {
      supportsDeveloperRole: true,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: true,
    },
  });
}
