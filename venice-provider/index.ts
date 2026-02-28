import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider('venice', {
    baseUrl: 'https://api.venice.ai/v1',
    apiKey: 'VENICE_API_KEY',  // Pulls from your env var
    api: 'openai-completions',  // Venice uses OpenAI-compatible API
    authHeader: true,  // Adds Authorization: Bearer <key>
    models: [
      {
        id: 'openai-gpt-52-codex',
        name: 'OpenAI GPT-5.2-Codex',
        reasoning: true,  // Supports low/medium/high/xhigh effort
        input: ['text', 'image'],  // Text + vision input
        cost: { input: 2.19, output: 17.5, cacheRead: 0.22, cacheWrite: 0 },
        contextWindow: 256000,  // 256k tokens
        maxTokens: 128000  // Max output
      }
    ],
    compat: {
      supportsDeveloperRole: true,
      maxTokensField: 'max_tokens',
      reasoningEffort: ['low', 'medium', 'high', 'xhigh']  // Optional Pi extension for effort
    }
  });
}
