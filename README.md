pi-extensions

My extensions for my agent harness.

Extensions

venice-provider
- Use: Adds a Venice AI provider and model configuration to Pi.
- ENV: VENICE_API_KEY (required) — API key used to authenticate against https://api.venice.ai/v1.

voice-to-text
- Use: Records microphone audio and transcribes it into the editor via Venice audio transcription.
- ENV:
  - VENICE_API_KEY (required) — API key for transcription requests.
  - VENICE_API_BASE (optional) — base URL for the Venice API. Default: https://api.venice.ai/api/v1
  - PI_VOICE_INPUT (optional) — avfoundation input device override (e.g. :0 or 0:0) to skip the prompt.

exit-alias
- Use: Adds /exit as an alias for /quit.
- ENV: none.
