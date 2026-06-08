pi-extensions

My extensions for my agent harness.

Extensions

announcer-input-alert
- Use: Plays a random announcer sound when the assistant finishes a text response.
- Commands: /announcer-rate, /announcer-ratings
- Files: sounds in `announcer-input-alert/sounds`; local rating stats in `announcer-input-alert/ratings.json` (gitignored).

clipboard-last-assistant
- Use: Copies the last assistant text output on the current branch to the macOS clipboard.
- Commands: /cp
- ENV: none.

context-comments
- Use: Save line-level comments on session context and insert them into your next prompt.
- Commands: /context-comments, /context-comments add, /context-comments list, /context-comments clear, /context-comments submit, /context-comments shortcuts.
- Config: ~/.pi/agent/extensions/context-comments/config.json (optional shortcut overrides).

venice-provider
- Use: Adds a Venice AI provider and model configuration to Pi.
- ENV: VENICE_API_KEY (required) — API key used to authenticate against https://api.venice.ai/v1.

ppq-provider
- Use: Adds a ppq.ai provider and loads models from ~/.pi/agent/extensions/ppq-provider.json.
- ENV: PPQ_API_KEY (required) — API key used to authenticate against https://api.ppq.ai/v1.
- Config: ~/.pi/agent/extensions/ppq-provider.json (created on first run).

voice-to-text
- Use: Records microphone audio and transcribes it into the editor via Venice audio transcription.
- ENV:
  - VENICE_API_KEY (required) — API key for transcription requests.
  - VENICE_API_BASE (optional) — base URL for the Venice API. Default: https://api.venice.ai/api/v1
  - PI_VOICE_INPUT (optional) — avfoundation input device override (e.g. :0 or 0:0) to skip the prompt.

footer-style
- Use: Replaces Pi's footer with session path, model, context, token, and cost details. Optional working-token mode keeps the normal footer layout but makes the `$`, 🪙, ✨, and 💎 counters show accumulation since the current prompt started while the agent is working.
- Commands: /footer-style [on|off|toggle|status|tokens|bar], /footer-tokens [on|off|toggle|status].
- ENV: none.

moon-pi
- Use: Bootstraps an EPOCH workflow and prints EPOCH setup steps when no EPOCH is active and no EPOCH plan file exists.
- Commands: /moon-pi
- Files checked in current repo: .moon-pi/epoch-plan.md, .moon-pi/epoch.json

exit-alias
- Use: Adds /exit as an alias for /quit.
- ENV: none.
