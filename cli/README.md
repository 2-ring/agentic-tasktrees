# TaskTrees CLI

The command-line layer the [Agentic TaskTrees](../README.md) VSCode extension drives. The extension is a thin UI — these scripts do the real work of creating worktrees, spawning agents, and merging finished tasks. You can use them standalone from a terminal, with or without the extension.

```
cli/
├── bin/
│   ├── task          # worktree/task controller  (task new | list | <id> kill|resume|finish)
│   └── agent         # agent controller          (agent new | list | <id> kill|resume|message)
├── scripts/
│   ├── task-launch-orchestrator   # launches the per-task Orchestrator agent
│   ├── agent-launch               # launches a sub-agent
│   └── task-finish                # review → merge → archive → clean up
└── templates/
    └── bundle.md     # BUNDLE.md skeleton, filled in per task
```

## How the pieces fit

- **`task` / `agent`** are the global entrypoints. Put them on your `PATH`. They resolve the repo root, manage `.worktrees/<task>/`, and call `recon` to spawn/track tmux sessions.
- **`scripts/*`** are the launchers, invoked *inside* a task's worktree (`recon launch --command ./scripts/...`). Because each worktree carries its own branch copy, every task gets its own launchers — edits in one task never leak into another. They live in the **managed project**, not on your PATH.
- **`templates/bundle.md`** is the BUNDLE.md skeleton. `task new` copies it in and (optionally) has a headless Claude flesh it out from your one-line description.

## Install

These scripts shell out to [`recon`](https://github.com/gavraz/recon) (a tmux-native session dashboard) and `tmux`, and launch the [Claude Code](https://claude.ai/code) CLI inside each agent. Install those first — `recon` comes from git (not `cargo install recon`, which is an unrelated crate):

```bash
cargo install --git https://github.com/gavraz/recon
```

Then:

```bash
# 1. Put the global entrypoints on your PATH
cp cli/bin/task cli/bin/agent ~/bin/        # or anywhere on $PATH
chmod +x ~/bin/task ~/bin/agent

# 2. Drop the launchers + template into the project you want to manage
cd /path/to/your/project
mkdir -p scripts .claude/templates
cp /path/to/agentic-tasktrees/cli/scripts/* scripts/
cp /path/to/agentic-tasktrees/cli/templates/bundle.md .claude/templates/
chmod +x scripts/task-launch-orchestrator scripts/agent-launch scripts/task-finish
```

`task` and `agent` add `~/bin` to the `PATH` of the bash inside each agent, so an orchestrator can run `agent new …` itself. If you install the entrypoints somewhere other than `~/bin`, adjust the `export PATH=...` line near the top of `scripts/task-launch-orchestrator` and `scripts/agent-launch`.

## Usage

```bash
task new google-auth "wire up Google OAuth end to end"   # creates worktree + orchestrator
task list                                                # git worktree list
agent new hero-section section-builder 'build the hero'  # add a sub-agent (run from inside the task)
agent <id> message '[QUESTION] align mobile to web?'     # talk to any live agent
task google-auth finish                                  # review → merge to main → clean up
task <id> kill | resume                                  # stop / restart a task's agents
```

Run `task help` or `agent help` for the full subcommand list.

## Project-specific knobs

- **Env files** — worktrees don't inherit gitignored files like `.env`. Set `TASK_ENV_FILES` to a space-separated list of paths to copy into each new worktree, e.g. `export TASK_ENV_FILES="backend/.env web/.env"`.
- **Main branch** — `task finish` merges into `main`. Change the branch name in `scripts/task-finish` if your default differs.
- **Models** — the optional headless calls (BUNDLE.md fill-in, pre-merge review, commit messages) use Claude via the `claude` CLI. They degrade gracefully: if the call fails, the skeleton/fallback is used instead.
