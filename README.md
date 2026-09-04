# opencode-aside

A port of Claude Code's `/btw` for opencode: ask a question about the session you are in,
get the answer in an overlay, and have none of it enter the transcript.

The command is `/btw`, with `/aside` as an alias. The package is named `opencode-aside`
because `opencode-btw` is taken by an unrelated package.

## How this differs from the alternatives

Several plugins cover nearby ground. The distinction that matters is whether your side
question **forks a session** and whether anything **persists**:

| | Forks? | Persists? | Tools? |
|---|---|---|---|
| **opencode-aside** (this) | no | no — the child session is deleted | no |
| `opencode-bytheway` | yes, forks and switches you into it | until you `/btw-end` or `/btw-merge` | yes |
| `opencode-sidechat` | no | yes — a panel with history | yes |

Claude Code's own `/btw` is a side chain: no tools, nothing persisted, gone when you close
it, main transcript untouched. This plugin matches that. Pick `bytheway` if you actually
want to *branch* and merge text back; pick `sidechat` if you want a persistent panel.

## Install

```jsonc
// ~/.config/opencode/tui.json
{ "plugin": ["opencode-aside"] }
```

Restart opencode afterwards.

## What it does

`/btw` opens a dialog, then:

1. snapshots recent text **and tool activity** from the current session
2. opens a hidden child session (`parentID` = current) with tools denied
3. asks once and renders the answer in an overlay
4. deletes the child session

The parent transcript is never written to.

**It deliberately does not fork.** Forking is the heavyweight case — use a real fork when
you want to *branch*, use `/btw` when you just want to ask.

## Options

```json
{ "plugin": [["opencode-aside", { "context_chars": 12000 }]] }
```

| Option | Default | Meaning |
|---|---|---|
| `context_chars` | `6000` | How much recent transcript text to include. Trimmed from the front, so the tail always survives. |
| `tool_chars` | `600` | Per-tool-call cap on command + output text. |
| `system` | see source | Override the side-question system prompt. |
| `model` | session's model | `{providerID, modelID}` to answer with. |

## Notes for anyone extending it

- opencode's slash mechanism dispatches commands with **no arguments**
  (`dispatchCommand(name)`), so `/btw your question` is impossible. Hence the dialog.
- Most of a session lives in **tool parts**, not text parts. A shell-mode (`!cmd`)
  session's only text part is `synthetic: true` boilerplate; the real content is
  `part.state.input` / `part.state.output`. Reading only text parts yields empty context.
- `api.ui.DialogPrompt` / `DialogAlert` can be called as plain functions inside
  `dialog.replace(() => …)`, which avoids needing a JSX build step.
- Tools are disabled with `tools: { "*": false }`, which opencode turns into deny-all
  permission rules for the child session.
- The model is inherited from the session's most recent assistant message, which matters
  on a swap-based backend where naming a different model forces a reload.

## Running against a local single-slot model

Irrelevant on a hosted API. On a local llama.cpp-style server with `--parallel 1`,
requests serialise, so a `/btw` is served as soon as the current in-flight call finishes —
usually in the gap while the agent runs tools — rather than waiting for the whole run.
It delays the agent's next call by its own duration and will not preempt a generation
already in flight.

Measured on one such setup, an interleaved `/btw` did **not** cost the agent its prompt
cache (a long prompt still hit cache afterwards: 1.1s, versus 9.5s cold). That depends on
server version and cache settings, so re-check it on your own hardware if it matters.

## Requirements

OpenCode 1.18.18 or newer (the TUI plugin API with dialogs and session client access).
