import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { colorForTask } from './colors';
import { isDevRunning } from './dev';
import { getCliCommands, getShowStatusLabels } from './config';

const pexec = promisify(exec);

/** Codicons we allow in BUNDLE.md frontmatter. Anything else falls back to `folder`. */
const ALLOWED_ICONS = new Set([
    'folder', 'rocket', 'bug', 'gear', 'shield', 'database',
    'beaker', 'zap', 'book', 'key', 'tools', 'mail', 'globe',
]);

export class TaskItem extends vscode.TreeItem {
    constructor(public readonly task: string, public readonly agentCount: number, iconName: string) {
        const label = displayNameForTask(task);
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        // contextValue drives which inline icons are shown.
        //   task            — dev servers not running → show "play"
        //   task-dev-running — dev servers running    → show "stop"
        this.contextValue = isDevRunning(task) ? 'task-dev-running' : 'task';
        this.iconPath = new vscode.ThemeIcon(iconName, colorForTask(task));
        this.description = agentCount === 0 ? '(no live agents)' : `${agentCount}`;
        this.tooltip = `${label}\nID: ${task}\nAgents: ${agentCount}\nIcon: ${iconName}\nDev: ${isDevRunning(task) ? 'running' : 'stopped'}\n\nClick to expand.`;
    }
}

/** Recon `status` field, lowercased. `dead` = tracked in .agents but no live tmux session. */
export type AgentStatus = 'working' | 'idle' | 'input' | 'new' | 'dead';

export class AgentItem extends vscode.TreeItem {
    public readonly displayName: string;
    constructor(
        public readonly agent: string,
        public readonly task: string,
        public readonly status: AgentStatus
    ) {
        const name = displayNameForAgent(agent, task);
        super(name, vscode.TreeItemCollapsibleState.None);
        this.displayName = name;
        this.contextValue = 'agent';
        // Visually distinguish the orchestrator from other agents.
        // Agents share their parent task's color so the tree groups by hue.
        const color = colorForTask(task);
        // Icon encodes status, with role as the fallback for "idle":
        //   working → spinning sync (the `~spin` modifier animates in tree icons)
        //   input   → question mark (waiting on a user question / permission prompt)
        //   else    → role icon (mortar-board for orchestrator, robot for sub-agents)
        const baseIcon = isOrchestrator(agent, task) ? 'mortar-board' : 'robot';
        let iconName: string;
        if (status === 'working')      iconName = 'sync~spin';
        else if (status === 'input')   iconName = 'question';
        else                            iconName = baseIcon;
        this.iconPath = new vscode.ThemeIcon(iconName, color);
        // Status text next to the name — off by default; the icon already
        // conveys the state. Users opt in via `agenticTaskTrees.showStatusLabels`.
        if (getShowStatusLabels()) {
            this.description = describeStatus(status);
        }
        this.tooltip = `Agent: ${name}\nID: ${agent}\nTask: ${task}\nStatus: ${status}\n\nClick to open in a terminal panel.`;
        this.command = {
            command: 'agentic-tasktrees.openAgent',
            title: 'Open Agent Terminal',
            // Pass the AgentItem itself so the handler has access to id + task + display name.
            arguments: [{ agent, task, displayName: name }],
        };
    }
}

function describeStatus(status: AgentStatus): string | undefined {
    switch (status) {
        case 'working': return 'working';
        case 'input':   return 'awaiting input';
        case 'dead':    return 'stopped';
        case 'new':     return 'starting';
        case 'idle':
        default:        return undefined;
    }
}

export function isOrchestrator(agent: string, task: string): boolean {
    return agent === `${task}-orch` || agent.endsWith('-orch');
}

export function displayNameForAgent(agent: string, task: string): string {
    if (isOrchestrator(agent, task)) return 'Orchestrator';
    const prefix = `${task}-`;
    const stem = agent.startsWith(prefix) ? agent.slice(prefix.length) : agent;
    return titleCase(stem);
}

export function displayNameForTask(task: string): string {
    return titleCase(task);
}

function titleCase(s: string): string {
    return s
        .split('-')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export type TreeNode = TaskItem | AgentItem;

interface AgentSnapshot {
    name: string;
    status: AgentStatus;
}

interface TaskSnapshot {
    task: string;
    icon: string;
    agents: AgentSnapshot[];
}

/**
 * Tree state is fetched in the background by `poll()` and stored here. `getChildren`
 * reads synchronously from this cache so periodic polling never triggers the
 * VS Code tree-view loading indicator. The first call to `getChildren` awaits an
 * initial poll so the user sees a spinner on activation but not afterwards.
 */
export class TasksProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private snapshot: TaskSnapshot[] = [];
    private snapshotKey = '';
    private pollInFlight: Promise<void> | null = null;
    private initialLoad: Promise<void> | null = null;

    /** Force a refresh by re-polling. Fires the change event regardless of diff. */
    refresh(): void {
        void this.poll(true);
    }

    /**
     * Fetch the latest snapshot and fire the change event only if anything changed.
     * Concurrent calls share the in-flight promise.
     */
    poll(force = false): Promise<void> {
        if (this.pollInFlight) return this.pollInFlight;
        const run = (async () => {
            try {
                const next = await fetchSnapshot();
                const nextKey = JSON.stringify(next);
                if (force || nextKey !== this.snapshotKey) {
                    this.snapshot = next;
                    this.snapshotKey = nextKey;
                    this._onDidChangeTreeData.fire();
                }
            } finally {
                this.pollInFlight = null;
            }
        })();
        this.pollInFlight = run;
        return run;
    }

    /** Names of all agents currently in the snapshot for `task`. Empty if unknown. */
    agentsForTask(task: string): string[] {
        return this.snapshot.find(t => t.task === task)?.agents.map(a => a.name) ?? [];
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        // Block the very first render on a real fetch so the tree isn't empty
        // for a beat on activation. Subsequent invalidations read the cache.
        if (!this.initialLoad) {
            this.initialLoad = this.poll(true);
        }
        if (this.snapshotKey === '') {
            await this.initialLoad;
        }

        if (!element) {
            return this.snapshot.map(t => new TaskItem(t.task, t.agents.length, t.icon));
        }
        if (element instanceof TaskItem) {
            const t = this.snapshot.find(x => x.task === element.task);
            return (t?.agents ?? []).map(a => new AgentItem(a.name, element.task, a.status));
        }
        return [];
    }
}

/** Single-shot fetch of every task's icon + agent list + per-agent status. */
async function fetchSnapshot(): Promise<TaskSnapshot[]> {
    const tasks = await listTasks();
    // Notify setup module so it can background-install deps for new tasks.
    const { notifyTaskSeen } = await import('./setup');
    notifyTaskSeen(tasks);

    // Call recon + tmux once per poll, then slice the results per-task.
    const [reconAgents, tmuxNames] = await Promise.all([fetchReconAgents(), fetchTmuxSessions()]);

    return Promise.all(
        tasks.map(async task => {
            const [agents, icon] = await Promise.all([
                listAgentsForTask(task, reconAgents, tmuxNames),
                readTaskIcon(task),
            ]);
            return { task, icon, agents };
        })
    );
}

interface ReconAgentEntry { tmuxSession: string; bundle: string; status: AgentStatus; }

async function fetchReconAgents(): Promise<ReconAgentEntry[]> {
    try {
        const { stdout } = await pexec(`${shellQuoteForExec(getCliCommands().recon)} json`);
        const data = JSON.parse(stdout);
        const out: ReconAgentEntry[] = [];
        for (const s of data?.sessions ?? []) {
            if (s?.tmux_session && s?.tags?.bundle) {
                out.push({
                    tmuxSession: s.tmux_session,
                    bundle: s.tags.bundle,
                    status: normalizeStatus(s.status),
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

async function fetchTmuxSessions(): Promise<Set<string>> {
    try {
        const { stdout } = await pexec(`tmux list-sessions -F '#{session_name}'`);
        return new Set(stdout.split('\n').map((s: string) => s.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

/**
 * Per-task agent list. Three sources are unioned:
 *   1. recon (authoritative for live agents + their status)
 *   2. tmux session-name prefix (catches legacy / unrecorded sessions)
 *   3. `.worktrees/<task>/.agents` registry (survives reboot — names here that
 *      aren't in tmux are flagged `dead` and auto-resumed on click).
 */
async function listAgentsForTask(
    task: string,
    reconAgents: ReconAgentEntry[],
    tmuxNames: Set<string>,
): Promise<AgentSnapshot[]> {
    const byName = new Map<string, AgentStatus>();

    for (const r of reconAgents) {
        if (r.bundle === task) byName.set(r.tmuxSession, r.status);
    }

    for (const name of tmuxNames) {
        if (name.startsWith(`${task}-`) && !byName.has(name)) {
            byName.set(name, 'idle');
        }
    }

    try {
        const root = await repoRoot();
        if (root) {
            const agentsFile = path.join(root, '.worktrees', task, '.agents');
            const content = await fs.readFile(agentsFile, 'utf8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.includes('|')) continue;
                const name = trimmed.split('|', 1)[0];
                if (!name) continue;
                if (!byName.has(name)) {
                    // In registry but no live tmux session → dead.
                    byName.set(name, tmuxNames.has(name) ? 'idle' : 'dead');
                }
            }
        }
    } catch { /* registry missing — fine */ }

    return Array.from(byName.entries())
        .map(([name, status]) => ({ name, status }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeStatus(raw: unknown): AgentStatus {
    const s = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (s === 'working' || s === 'idle' || s === 'input' || s === 'new') return s;
    return 'idle';
}

/** Read the `icon:` line from BUNDLE.md's frontmatter. Falls back to `folder`. */
export async function readTaskIcon(task: string): Promise<string> {
    const root = await repoRoot();
    if (!root) return 'folder';
    const bundle = path.join(root, '.worktrees', task, 'BUNDLE.md');
    try {
        const content = await fs.readFile(bundle, 'utf-8');
        // Look for a `---` frontmatter block at the very top.
        const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (!fm) return 'folder';
        const iconMatch = fm[1].match(/^\s*icon:\s*([A-Za-z][A-Za-z0-9_-]*)\s*$/m);
        if (!iconMatch) return 'folder';
        const name = iconMatch[1];
        return ALLOWED_ICONS.has(name) ? name : 'folder';
    } catch {
        return 'folder';
    }
}

export async function getBundleMdPath(task: string): Promise<string | null> {
    const root = await repoRoot();
    if (!root) return null;
    return path.join(root, '.worktrees', task, 'BUNDLE.md');
}

export async function repoRoot(): Promise<string | null> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return null;
    try {
        const { stdout } = await pexec('git rev-parse --show-toplevel', { cwd: folder });
        let root = stdout.trim();
        if (root.includes('/.worktrees/')) {
            root = root.split('/.worktrees/')[0];
        }
        return root || null;
    } catch {
        return null;
    }
}

export async function listTasks(): Promise<string[]> {
    const root = await repoRoot();
    if (!root) return [];
    try {
        const { stdout } = await pexec('git worktree list --porcelain', { cwd: root });
        const tasks = new Set<string>();
        for (const line of stdout.split('\n')) {
            const m = line.match(/^worktree (.*\/\.worktrees\/([^/]+))$/);
            if (m) tasks.add(m[2]);
        }
        return Array.from(tasks).sort();
    } catch {
        return [];
    }
}

/** True if the agent is tracked in .agents but not currently in tmux. */
export async function isAgentDead(agentId: string): Promise<boolean> {
    try {
        await pexec(`tmux has-session -t ${shellQuoteForExec(agentId)}`);
        return false;
    } catch {
        return true;
    }
}

function shellQuoteForExec(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
