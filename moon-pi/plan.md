# Moon Pi extension plan

## Goal
Build a Moon Pi extension that helps run EPOCHs (a grouped set of PRs) with explicit human checkpoints.

## Phase 1 — EPOCH bootstrap (initial)
- [x] Create `moon-pi/index.ts` extension scaffold.
- [x] Register `/moon-pi` command.
- [x] Detect EPOCH state with:
  - `/.moon-pi/epoch-plan.md` (plan file)
  - `/.moon-pi/epoch.json` (active EPOCH marker)
- [x] If no active EPOCH and no plan file exists, output bootstrap steps for creating an EPOCH.

## Phase 2 — Plan-file creation flow
- [ ] Add `/moon-pi init` to collect objective and constraints.
- [ ] Generate `/.moon-pi/epoch-plan.md` with a structured template.
- [ ] Ask for human confirmation before writing the plan file.

## Phase 3 — Guided PR chunk loop (human-in-the-loop)
- [ ] Add `/moon-pi next` to propose the next PR chunk.
- [ ] Require a human checkpoint acknowledgement before execution guidance.
- [ ] Track chunk status (`todo`, `in-progress`, `done`, `blocked`) in EPOCH state.

## Phase 4 — Review and quality guardrails
- [ ] Add per-chunk checklists (tests, rollout notes, risk notes).
- [ ] Add summary output for "what changed", "why", and "how to validate".
- [ ] Add pause/resume support for EPOCH sessions.
