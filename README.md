# Agentic TaskTrees

A VSCode sidebar for running **multi-agent coding workflows** across **isolated git worktrees**, with **auto-managed dev servers** and a **clean, configurable UI**. Pairs with [`task-manager`](https://github.com/2-ring/task-manager) (the `task` / `agent` / `recon` CLIs) to give you a full visual control surface for parallel Claude Code sessions.

![sidebar](https://github.com/2-ring/agentic-tasktrees/assets/placeholder/sidebar.png)

---

## What it does

You have a feature to build. You don't want to context-switch between a dozen terminal panes. You want every task to live in its own branch, with its own dev servers running on their own ports, and a small swarm of agents collaborating on it — an **orchestrator** that plans and dispatches work, plus specialist sub-agents that execute it.

Agentic TaskTrees gives you the **sidebar** that makes all of that one click away.

```
Explorer
└─ AGENTIC TASKTREES
   ├─ ▣ Providers      (3)              [+ ✓ ✕ …]
   │   ├─ 🎓 Orchestrator       working
   │   ├─ 🤖 Hero Section       awaiting input
   │   └─ 🤖 Tests              idle
   ├─ ▣ Mobile         (no live agents) [+ ✓ ✕ …]
   └─ ▣ Auth           (2)              [+ ✓ ✕ …]
       ├─ 🎓 Orchestrator       idle
       └─ 🤖 Db Migration       working
```

Each **task** is a `.worktrees/<task>/` directory with its own branch, BUNDLE.md, and dedicated dev servers. Each **agent** under it is a long-running tmux session with a Claude (or other LLM CLI) process inside, holding its own conversation. The sidebar polls in the background and reflects the live state of all of them.

---

## Features

### Multi-agent workflows with an orchestrator

Every new task spawns an **orchestrator agent** automatically. The orchestrator is a Claude Code session that can:

- Spawn sub-agents (`agent new`) — assigns each a role and an initial task message.
- Send messages to sub-agents (`agent <id> message …`) — delivered into their pane as `[MESSAGE]` blocks.
- Wait for sub-agents to finish, integrate their output, and report back to you.

You see the orchestrator with a 🎓 mortar-board icon at the top of each task. Sub-agents get a 🤖 robot icon. Click any of them to open their tmux session inside a VSCode terminal — fully native, with the right title and color.

### Persistent agent state (until you kill them)

Agents are **not ephemeral**. Each one is recorded in `.worktrees/<task>/.agents` as `name|role|conversation-uuid` the moment it's created, and that file is the source of truth for "what should exist."

This means:

- **Reboot your machine** → the tmux sessions are gone, but every agent still appears in the sidebar with a `stopped` state. Click any of them and the extension runs `agent <id> resume`, which respawns the tmux session and reattaches Claude Code to the original conversation via `--resume <uuid>`. The agent picks up exactly where it left off — same memory, same context, same history.
- **Restart VSCode** → no effect. The extension re-reads `.agents` on startup. Running agents stay running.
- **Reload the extension** → no effect. Same.
- **Quit Claude Code in a pane** → the agent shows as `stopped`. Click to resume.

The only thing that ends an agent's life is an explicit **Kill Agent** or **Kill Task** click (or `agent <id> kill` from the CLI). Until then, your orchestrator and sub-agents are durable — you can leave a 50-message conversation running overnight, close your laptop, and find it intact in the morning.

### Live status with animated icons

Each agent's icon reflects what it's doing right now, polled from `recon json`:

| Status   | Icon                       | Description shown next to name | Meaning                                  |
|----------|----------------------------|--------------------------------|------------------------------------------|
| Working  | spinning sync 🔄            | _(none — the spin is the cue)_ | LLM is actively generating tokens        |
| Input    | question mark ❓            | `awaiting input`               | Agent is waiting on a user question or permission prompt |
| Idle     | role icon (🎓 / 🤖)         | _(none)_                       | Waiting for the next message             |
| New      | role icon                  | `starting`                     | Session just spawned, no tokens yet      |
| Dead     | role icon                  | `stopped`                      | Tracked in `.agents` but no live tmux session — clicking auto-resumes the prior conversation via `agent <id> resume` |

The poll runs every few seconds in the background. It diffs against a cached snapshot and only repaints the tree when something actually changed — so the tree-view loading indicator **does not flash on every tick**.

### Auto-spinning dev servers per task

Each task can have its own dev servers, defined declaratively in workspace settings:

```jsonc
"agenticTaskTrees.devServers": [
  { "name": "backend", "cwd": "${worktree}/backend", "command": "python", "args": ["app.py"],
    "portBase": 5000, "portEnv": "PORT" },
  { "name": "web",     "cwd": "${worktree}/web",     "command": "npm",    "args": ["run", "dev", "--", "--port", "${port}"],
    "portBase": 5173, "openInBrowser": true }
]
```

Click **Start Dev Servers** ▶ on a task row and the extension:

- Allocates a **stable per-task port offset** (persisted in `.vscode/agentic-tasktrees.json`), so every server gets `portBase + offset` — different tasks never collide.
- Sets `${port}` and `portEnv` so your servers actually bind to their assigned ports.
- Streams stdout/stderr to a dedicated **Output channel** per task.
- Watches process exit/error and updates the tree icon (▶ ↔ ⏹).
- **Cleans up on shutdown** — SIGTERMs the whole process group when VSCode exits, so vite / flask / etc. don't get orphaned.

Click ⏹ to stop. Click 🌐 **Open Test URL** to launch your default browser pointed at whichever server is marked `openInBrowser: true`.

### Auto setup (npm install, venv, pip install)

When a new task appears, the extension runs configured setup steps **in the background** with a discreet status-bar spinner:

```jsonc
"agenticTaskTrees.setup": [
  { "name": "npm install", "cwd": "${worktree}/web", "trigger": "package.json",
    "skipMarker": "node_modules/.package-lock.json",
    "steps": [{ "command": "npm", "args": ["install"] }] },
  { "name": "python venv", "cwd": "${worktree}/backend", "trigger": "requirements.txt",
    "skipMarker": "venv/bin/python",
    "steps": [
      { "command": "python", "args": ["-m", "venv", "venv"] },
      { "command": "${worktree}/backend/venv/bin/pip", "args": ["install", "-r", "requirements.txt"] }
    ] }
]
```

`trigger` gates the step ("only run if `package.json` exists"). `skipMarker` short-circuits when it's already done ("if `node_modules/.package-lock.json` exists, we're set up"). Setup is **idempotent and concurrent-safe** — if you click Start Dev mid-install, it joins the in-flight install instead of starting another one.

### Worktree management

The extension is a UI over the `task` and `agent` CLIs. From the sidebar you can:

- **New Task** — prompts for name + description, runs `task new`, creates the worktree, spawns the orchestrator, kicks off background setup.
- **New Agent** (per task) — prompts for name, role, and initial message; runs `agent new --task <task>`.
- **Edit BUNDLE.md** — opens the task's spec in a new editor tab.
- **Finish Task** — runs `task <id> finish` (interactive review/merge/cleanup) in a new terminal.
- **Kill Task / Kill Agent** — two-step confirmation, then `task <id> kill` / `agent <id> kill`.
- **Open Agent Terminal** — `tmux attach`s to the agent's session in a VSCode terminal, with the task's stable color and the role's icon. If the session is dead, auto-resumes via `agent <id> resume` first.

### Clean, intuitive, customizable UI

- **Stable colors per task.** Each task gets a deterministic hue derived from its name. Applied to tree icons _and_ terminal tabs — so all of a task's terminals visually group together.
- **Per-task icons.** Drop `icon: rocket` (or `bug`, `gear`, `shield`, `database`, `beaker`, `zap`, `book`, `key`, `tools`, `mail`, `globe`, `folder`) into your `BUNDLE.md` frontmatter and the tree picks it up.
- **No spinner flicker.** Background polling diffs against a snapshot cache; the tree only re-renders when something changed.
- **Configurable poll interval.** `agenticTaskTrees.pollIntervalMs` — set it to 1000 for snappy, 10000 for quiet.
- **All inline actions discoverable.** The most common actions (▶ Start, ⏹ Stop, + New Agent, ✓ Finish, ✕ Kill) live as inline icons on every task row. The "…" overflow holds the long tail (Show Dev Logs, Open Test URL, Refresh, Edit BUNDLE.md).
- **Project-agnostic.** Dev servers, setup steps, and CLI paths all live in workspace settings — different projects can have wildly different layouts without touching the extension.

### URI handler

External tools can deep-link into the sidebar:

```
vscode://local.agentic-tasktrees/openAgent?agent=<agent-id>
```

Opens (or resumes) the agent in a VSCode terminal. Useful for routing notifications from your agents back into the editor.

---

## Requirements

The extension shells out to three CLIs:

| Setting key                            | Default | What it must do                                              |
|----------------------------------------|---------|--------------------------------------------------------------|
| `agenticTaskTrees.commands.recon`      | `recon` | `recon json` → enumerate live tmux/agent sessions            |
| `agenticTaskTrees.commands.task`       | `task`  | `task new`, `task <id> kill`, `task <id> finish`             |
| `agenticTaskTrees.commands.agent`      | `agent` | `agent new --task <t> <n> <r> <d>`, `agent <id> resume`, `agent <id> kill` |

Reference implementations live in [`task-manager`](https://github.com/2-ring/task-manager) (a fork of [`gavraz/recon`](https://github.com/gavraz/recon) with `task` and `agent` Bash scripts layered on top). You can substitute your own implementations as long as they honor the same subcommand surface.

You also need `tmux` and a Claude Code (or compatible) CLI inside each agent's session.

---

## Installation

```bash
git clone https://github.com/2-ring/agentic-tasktrees
cd agentic-tasktrees
npm install
npm run package      # produces agentic-tasktrees-<version>.vsix
code --install-extension agentic-tasktrees-*.vsix
```

Then reload VSCode. Open the Explorer pane — you'll see **AGENTIC TASKTREES** at the bottom.

---

## Configuration cheatsheet

All settings under `agenticTaskTrees.*`. Set them in your **workspace** `.vscode/settings.json`.

| Setting | Default | Purpose |
|---|---|---|
| `devServers` | `[]` | Array of dev-server configs spawned by **Start Dev Servers** |
| `setup` | `[]` | Array of setup steps (npm install, venv, etc.) run lazily / in background |
| `commands.task` | `"task"` | Path to the `task` CLI |
| `commands.agent` | `"agent"` | Path to the `agent` CLI |
| `commands.recon` | `"recon"` | Path to the `recon` CLI |
| `pollIntervalMs` | `3000` | Background poll interval |

### Variable substitution

`cwd`, `command`, and `args` in dev servers and setup steps support:

- `${worktree}` — absolute path to `.worktrees/<task>` for the current task
- `${task}` — the task name (kebab-case)
- `${port}` — the assigned port for this dev server (only valid in `devServers[*].args`)

---

## BUNDLE.md frontmatter

Each task's `.worktrees/<task>/BUNDLE.md` can declare an icon:

```markdown
---
icon: rocket
---

# What this task is for
...
```

Allowed icons: `folder`, `rocket`, `bug`, `gear`, `shield`, `database`, `beaker`, `zap`, `book`, `key`, `tools`, `mail`, `globe`. Anything else falls back to `folder`.

---

## License

MIT.
