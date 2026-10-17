# /scope — Collaborative Scoping Mode

A pi extension that turns the agent into a thinking partner. You and the model
ask each other questions and deepen your understanding of a task until you are
confident it matches your intent or is scoped well enough. The agent maintains a
concise per-session **brief** that re-anchors the discussion if it drifts.

This adapts the read-only machinery from pi's shipped `plan-mode` example, but
repurposes it for conversation/scoping rather than plan-and-execute.

## The artifact

- `cwd/.pi/briefs/<session-id>.md` — created on first `/scope` with seeded
  headings if missing.
- Fixed sections: `## Goal` · `## Decisions` · `## Constraints` ·
  `## Open questions` · `## Out of scope`.
- Kept terse; the agent rewrites/edits it whenever understanding changes.
- It is the **only writable path** while `/scope` is active.

## Activation

- `/scope` toggles the mode on/off (no shortcut, no startup flag).

## While active

- Injects a hidden `[SCOPE MODE ACTIVE]` context before each user turn telling the
  agent to:
  - Converse openly and ask clarifying questions; use `ask_user_question` for
    concrete decisions/preferences.
  - Explore read-only to ground the discussion.
  - Keep `brief.md` current and concise.
  - Never write anywhere except `brief.md`.
  - When it thinks scope is clear, gently ask "anything missing before we call
    this scoped?".
- `tool_call` guard:
  - `bash` — blocked unless it passes the read-only allowlist.
  - `edit` / `write` — blocked unless the resolved path equals this session's
    brief path.
- Footer status: `🔎 scope`.
- A `context` handler strips stale `[SCOPE MODE ACTIVE]` messages when the mode
  is off (no leakage into normal chats).
- State persisted via `pi.appendEntry("scope-mode", …)` and restored on
  `session_start`.

## Commands

- `/scope` — toggle.
- `/brief` — loads the brief into `ctx.ui.editor`; saving writes it back
  (view + edit).

## Exit

- `/scope` again. Guards lift, the brief file stays, and nothing is
  auto-injected.

## Files / wiring

- `index.ts` — self-contained extension; the read-only command allowlist is
  inlined rather than imported from the pi install tree (upgrades move it).
- Consider adding `.pi/briefs/` to your project `.gitignore` so briefs are not
  committed.
