---
icon: folder
---

# Bundle: <TITLE>

> Single source of truth for this parallel-agent worktree. Every agent working here reads this first. Keep the **Status (live)** section current — it's how resumed sessions pick up where they left off.

## Worktree
- **Branch:** `wt/<TITLE>`
- **Path:** `.worktrees/<TITLE>/`
- **Created:** <DATE>
- **Connected to:** main (sync via `git fetch && git merge main`)

## Purpose
> One short paragraph: what this bundle exists to accomplish, and what "done" looks like. Anchor the agent — everything else flows from this.

(fill in)

## Scope & Bounds
> Hard constraints on what to touch. Agents coordinate with other bundles only through merged main, so be explicit about boundaries. List concrete paths/areas where possible.

**Touch (work happens here):**
- (fill in)

**Do not touch:**
- (fill in)

## Rules & Context
> Project-specific constraints, conventions, or background knowledge that go beyond the project root `CLAUDE.md`. Things like: "this feature is behind flag X", "the API contract is fixed, don't change it", "see PR #123 for the original design".

(fill in)

## Plan
> Loose sequence of work. The 'Purpose' section describes the overarching goal, this section breaks it down into sub-tasks, getting to the end goal might come in different stages or sections. Tailor the structure of this section to match the task at hand and description given.

### Overarching goal
(fill in)

### Sub-tasks
- [ ] (fill in)

## Agents
> One entry per named agent working in this bundle. Each entry describes the agent's role, current task, and goal. Useful for resuming after reboot and for cross-agent awareness within the bundle. Add or remove entries as the team for this bundle changes.

### Orchestrator
- **Role:** Coordinator for this bundle. Reads this file first, decides task order, delegates or executes.
- **Current task:** (fill in)
- **Goal:** (fill in)

## Status (live)
> Updated by agents as work progresses. Read this section first when resuming — it tells you where things stand without scrolling chat history. Keep entries short.

- **State:** not started
- **Done:** —
- **In progress:** —
- **Next:** —
- **Blockers:** —

## Notes & scratchpad
> Free-form. Decisions made, dead-ends hit, useful links, thinking-out-loud. Survives across sessions; safe place to leave breadcrumbs for future-you.

(empty)
