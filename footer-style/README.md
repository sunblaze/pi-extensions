# footer-style

A personal Pi extension that replaces Pi's footer with a compact custom footer and adds a per-turn usage summary after each agent turn.

## Location

```text
~/.pi/agent/extensions/footer-style/index.ts
```

Pi auto-discovers extension directories that contain `index.ts`, so this works with `/reload`.

## What it shows

### Footer

The custom footer can show:

- current path
- git branch
- session name
- cumulative session cost
- current context usage percentage, if enabled
- cumulative fresh input tokens
- cumulative cached tokens
- cumulative output tokens
- selected extension statuses
- UTC clock
- model / provider / thinking level

When working-token mode is enabled, the footer keeps its normal layout while the agent is working. Only the `$`, `🪙`, `✨`, and `💎` counters switch from cumulative session totals to the accumulation since the current prompt started. When Pi is idle again, those counters return to cumulative session totals.

The cumulative token icons are:

```text
🪙 fresh input tokens
✨ cached tokens, cache read + cache write
💎 output tokens
```

Example footer:

```text
$1.468 | 15% | 🪙 153k | ✨ 925k | 💎 8.0k | ⏱ work 4m 3s
```

Example working-token footer while a prompt is active:

```text
$0.027 | 15% | 🪙 648 | ✨ 39.9k | 💎 122 | ⏱ work 4m 3s
```

### Last-turn summary

After each agent turn, the extension adds a compact custom message with the usage for just that turn.

Example:

```text
+$0.027  •  +🪙 648  •  +✨ 39.9k  •  +💎 122  •  [🪙✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨💎]
```

The context bar is relative to the last turn's token usage and uses the same constant order as the numbered counts: `🪙` input, then `✨` cache, then `💎` output. If prompt caching is working well, most of the bar should be `✨`.

## Commands

Toggle the whole custom footer:

```text
/footer-style on
/footer-style off
/footer-style toggle
/footer-style status
```

Toggle the working-token footer mode:

```text
/footer-tokens on
/footer-tokens off
/footer-tokens toggle
/footer-tokens status
/footer-style tokens on
/footer-style tokens off
/footer-style tokens toggle
/footer-style tokens status
```

Toggle the last-turn context bar:

```text
/footer-style bar on
/footer-style bar off
/footer-style bar toggle
/footer-style bar status
```

Reload after editing:

```text
/reload
```

## Configuration

Configuration currently lives at the top of `index.ts` in the `prefs` object.

```ts
const prefs: FooterPrefs = {
  showPathLine: true,
  showGitBranch: true,
  showSessionName: false,
  showCost: true,
  showContextUsage: true,
  showUtcTime: true,
  showModel: true,
  showThinking: true,
  showProviderWhenMultiple: true,
  showExtensionStatuses: true,
  showLastTurnContextBar: true,
};
```

Change values, then run `/reload`.

## Notes

The last-turn summary messages are filtered out of model context by the extension, so they are display-only and should not increase future prompt size.
