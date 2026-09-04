// /btw -- a faithful port of Claude Code's `/btw`.
//
// Claude Code's side chain: ask a question about the conversation you're in,
// get the answer in an overlay, and have none of it enter the transcript. No
// tools, nothing persisted, gone when you close it.
//
// opencode has no such concept, so this builds one from the plugin API:
//   1. snapshot recent text and tool activity from the current session
//   2. open a hidden child session (parentID = current), tools denied
//   3. ask once, render the answer in an overlay
//   4. delete the child session
// The parent transcript is never written to.
//
// This deliberately does NOT fork. Forking is the heavyweight case -- use a
// real fork when you want to *branch*, use /btw when you just want to ask.
//
// Options (tui.json -> ["./tui-plugin/btw.js", { ... }]):
//   context_chars  how much recent transcript text to include  (default 6000)
//   tool_chars     per-tool-call cap on command + output text  (default 600)
//   system         override the side-question system prompt
//   model          {providerID, modelID} to answer with. Default is whatever
//                  the session last used. On a swap-based backend such as
//                  llama-swap, leave this alone: naming a different model
//                  evicts the resident one and forces a multi-GB reload.

const DEFAULTS = {
  context_chars: 6000,
  tool_chars: 600,
  system:
    "You are answering a quick side question about an ongoing coding session. " +
    "The transcript so far is provided as context. You have no tools and cannot " +
    "read files or run commands -- answer from the context and your own knowledge. " +
    "Be concise and direct.",
}

// Denying "*" turns every tool into a denied permission for the child session,
// which is how opencode expresses "answer, don't act".
const NO_TOOLS = { "*": false }

function clamp(text, budget) {
  const value = typeof text === "string" ? text : String(text ?? "")
  if (value.length <= budget) return value
  return value.slice(0, budget) + "… (+" + (value.length - budget) + " chars)"
}

function textOf(parts) {
  return (parts ?? [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.trim() && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
}

// Most of a coding session lives in tool parts, not text parts -- a shell-mode
// session has no real text at all, only a synthetic "the following tool was
// executed" stub. Summarise each completed call so the aside can see what ran.
function toolsOf(parts, budget) {
  const out = []
  for (const part of parts ?? []) {
    if (!part || part.type !== "tool") continue
    const state = part.state
    if (!state || state.status !== "completed") continue
    const input = state.input ? JSON.stringify(state.input) : ""
    const output = typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? "")
    const head = "[" + part.tool + "] " + clamp(input, budget)
    out.push(output ? head + "\n  -> " + clamp(output, budget) : head)
  }
  return out.join("\n")
}

export default {
  id: "btw",
  tui: async (api, options) => {
    const config = { ...DEFAULTS, ...(options ?? {}) }

    function sessionID() {
      const route = api.route.current
      return route.name === "session" ? route.params?.sessionID : undefined
    }

    // Plain text plus tool activity, most recent last, trimmed from the front
    // so the tail (what you're actually asking about) always survives.
    function context(id) {
      const chunks = []
      for (const message of api.state.session.messages(id) ?? []) {
        const parts = api.state.part(message.id)
        const body = [textOf(parts), toolsOf(parts, config.tool_chars)].filter(Boolean).join("\n")
        if (!body) continue
        chunks.push((message.role === "user" ? "User" : "Assistant") + ": " + body)
      }
      const joined = chunks.join("\n\n")
      if (joined.length <= config.context_chars) return joined
      return "[earlier context truncated]\n\n" + joined.slice(-config.context_chars)
    }

    // Match the session's own model. On a swap-based backend a different model
    // id evicts the resident one, so inheriting is both faster and safer.
    function model(id) {
      if (config.model) return config.model
      const messages = api.state.session.messages(id) ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]
        if (info.role !== "assistant") continue
        if (info.providerID && info.modelID) return { providerID: info.providerID, modelID: info.modelID }
      }
      return undefined
    }

    function busy(id) {
      const status = api.state.session.status(id)
      return Boolean(status && status.type !== "idle")
    }

    function show(title, message) {
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({ title: title, message: message, onConfirm: () => api.ui.dialog.clear() }),
      )
    }

    async function ask(id, question) {
      api.ui.dialog.setSize("large")
      show("BTW", "Thinking…")

      let child
      try {
        const created = await api.client.session.create({ parentID: id, title: "btw" })
        if (created.error || !created.data) throw new Error("could not open a side session")
        child = created.data.id

        const answer = await api.client.session.prompt({
          sessionID: child,
          model: model(id),
          tools: NO_TOOLS,
          system: config.system,
          parts: [
            {
              type: "text",
              text:
                "Context from the current session:\n\n" +
                context(id) +
                "\n\n---\n\nSide question: " +
                question,
            },
          ],
        })
        if (answer.error) throw new Error("the model returned an error")

        const body = textOf(answer.data?.parts).trim()
        show("BTW", body || "(no answer returned)")
      } catch (error) {
        show("BTW failed", error && error.message ? String(error.message) : String(error))
      } finally {
        // The side session is scratch space; it never outlives the answer.
        if (child) await api.client.session.delete({ sessionID: child }).catch(() => {})
      }
    }

    function prompt(id) {
      const waiting = busy(id)
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() =>
        api.ui.DialogPrompt({
          title: waiting ? "BTW (session busy -- will queue)" : "BTW",
          placeholder: "Ask a question about this session…",
          onConfirm: (value) => {
            const question = (value ?? "").trim()
            if (!question) {
              api.ui.dialog.clear()
              return
            }
            void ask(id, question)
          },
          onCancel: () => api.ui.dialog.clear(),
        }),
      )
    }

    api.keymap.registerLayer({
      commands: [
        {
          name: "btw.ask",
          title: "By the way",
          desc: "Ask a one-shot side question -- no tools, nothing added to the transcript",
          category: "Session",
          namespace: "palette",
          slashName: "btw",
          slashAliases: ["aside"],
          run() {
            const id = sessionID()
            if (!id) {
              api.ui.toast({ variant: "warning", message: "Open a session first." })
              return
            }
            prompt(id)
          },
        },
      ],
      bindings: [],
    })
  },
}
