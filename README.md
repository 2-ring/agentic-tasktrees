# Agentic TaskTrees

VSCode sidebar for managing parallel coding agents (Claude Code, etc.) across git worktrees.

Each **task** is a git worktree under `.worktrees/<task>/`. Each task has one or more **agents** — tmux sessions running an LLM CLI. The sidebar shows tasks → agents, with a spinning icon when an agent is actively generating and a static one when idle. Per-task dev servers, port assignment, and dependency setup are all configurable per workspace, so the extension is generic over project layout.

## Requirements

Three external CLIs (paths configurable per workspace; see Settings):

| Command  | Default name | Purpose                                                  |
|----------|--------------|----------------------------------------------------------|
| `recon`  | `recon`      | `recon json` — enumerate live tmux/agent sessions        |
| `task`   | `task`       | `task new`, `task <name> kill`, `task <name> finish`     |
| `agent`  | `agent`      | `agent new --task <task> <name> <role> <desc>`, `agent <id> kill`, `agent <id> resume` |

These come from the [`task-manager`](https://github.com/2-ring/task-manager) repo (a fork of [`gavraz/recon`](https://github.com/gavraz/recon) with `task`/`agent` orchestration scripts on top).

## Installation

```bash
git clone https://github.com/2-ring/agentic-tasktrees
cd agentic-tasktrees
npm install
npm run package      # produces agentic-tasktrees.vsix
code --install-extension agentic-tasktrees.vsix
```

## Settings

All settings live under `agenticTaskTrees.*`. Set them in your **workspace** `.vscode/settings.json` so each project can describe its own dev-server layout.

### Dev servers (`agenticTaskTrees.devServers`)

Array of server configs. Each task gets distinct ports per server, derived as `portBase + per-task offset` (offset is persisted in `.vscode/agentic-tasktrees.json`).

Substitution: `${worktree}` → absolute path to `.worktrees/<task>`, `${task}` → task name, `${port}` → the assigned port for this server.

```jsonc
"agenticTaskTrees.devServers": [
  {
    "name": "backend",
    "cwd": "${worktree}/backend",
    "command": "python",
    "args": ["app.py"],
    "portBase": 5000,
    "portEnv": "PORT"
  },
  {
    "name": "web",
    "cwd": "${worktree}/web",
    "command": "npm",
    "args": ["run", "dev", "--", "--port", "${port}"],
    "portBase": 5173,
    "openInBrowser": true
  }
]
```

`openInBrowser: true` marks which server **Open Test URL** opens.

### Setup steps (`agenticTaskTrees.setup`)

Run lazily before the first **Start Dev Servers**, and in the background when new tasks appear. Each block:

- Skipped if `trigger` doesn't exist relative to `cwd`.
- Skipped if `skipMarker` already exists relative to `cwd`.
- Otherwise runs `steps` in order.

```jsonc
"agenticTaskTrees.setup": [
  {
    "name": "npm install (web)",
    "cwd": "${worktree}/web",
    "trigger": "package.json",
    "skipMarker": "node_modules/.package-lock.json",
    "steps": [{ "command": "npm", "args": ["install"] }]
  },
  {
    "name": "python venv + pip (backend)",
    "cwd": "${worktree}/backend",
    "trigger": "requirements.txt",
    "skipMarker": "venv/bin/python",
    "steps": [
      { "command": "python", "args": ["-m", "venv", "venv"] },
      { "command": "${worktree}/backend/venv/bin/pip", "args": ["install", "-r", "requirements.txt"] }
    ]
  }
]
```

### CLI paths

```jsonc
"agenticTaskTrees.commands.task":  "task",
"agenticTaskTrees.commands.agent": "agent",
"agenticTaskTrees.commands.recon": "recon"
```

Set to absolute paths if those binaries are not on the extension host's `PATH` (a common case for `~/.cargo/bin/recon`).

### Poll interval

```jsonc
"agenticTaskTrees.pollIntervalMs": 3000
```

Background refresh interval. The poll diffs against the cached snapshot and only repaints the tree when something changed, so the tree-view loading bar doesn't flash on every tick.

## BUNDLE.md frontmatter

Each task's `BUNDLE.md` can specify an icon via YAML frontmatter:

```markdown
---
icon: rocket
---

(task description)
```

Allowed icons: `folder`, `rocket`, `bug`, `gear`, `shield`, `database`, `beaker`, `zap`, `book`, `key`, `tools`, `mail`, `globe`. Anything else falls back to `folder`.

## Agent status

Each agent in the tree shows its current state, derived from `recon json`:

| Status   | Visual                         | Meaning                                      |
|----------|--------------------------------|----------------------------------------------|
| Working  | spinning sync icon             | LLM is actively generating                   |
| Input    | role icon + "awaiting input"   | Agent prompted the user                      |
| Idle     | role icon                      | Waiting for the next message                 |
| New      | role icon + "starting"         | Session just spawned, no tokens yet          |
| Dead     | role icon + "stopped"          | Tracked in `.agents` but no live tmux session — clicking auto-resumes via `agent <id> resume` |

## License

MIT.
