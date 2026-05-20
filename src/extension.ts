import * as vscode from 'vscode';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import {
    TasksProvider,
    TaskItem,
    AgentItem,
    getBundleMdPath,
    isAgentDead,
    isOrchestrator,
    displayNameForTask,
    displayNameForAgent,
    repoRoot,
} from './tree';

const pexec = promisify(exec);
import { colorForTask } from './colors';
import {
    isDevRunning,
    startDev,
    stopDev,
    showDevLogs,
    onDevStateChanged,
    registerTerminalCloseHandler,
    plannedPort,
    getRunningPort,
} from './dev';
import { markFreshlyCreated } from './setup';
import { getCliCommands, getDevServers, getPollIntervalMs } from './config';

/**
 * Agentic TaskTrees extension.
 *  - Sidebar tree view of tasks + agents.
 *  - vscode://local.agentic-tasktrees/openAgent?agent=… URI handler.
 *  - Per-task dev server management (start/stop, persistent port assignment).
 *  - Stable color per task, applied to tree icons + terminal icons.
 */
export function activate(context: vscode.ExtensionContext) {
    const provider = new TasksProvider();
    vscode.window.registerTreeDataProvider('agenticTaskTrees.tree', provider);

    // Auto-poll on a configurable interval so externally-spawned/killed sessions
    // appear. `poll()` only fires the change event when the snapshot actually
    // differs, so the tree's loading bar doesn't flash on every tick.
    const refreshTimer = setInterval(() => void provider.poll(), getPollIntervalMs());
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

    // Refresh tree immediately on dev-state change so the play/stop icon swaps right away.
    context.subscriptions.push(onDevStateChanged(() => provider.refresh()));

    // Repaint the tree when any of our settings change so e.g. toggling
    // `showStatusLabels` updates instantly without needing a window reload.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agenticTaskTrees')) provider.refresh();
        })
    );

    // Drop dev-server terminal references when the user closes them.
    registerTerminalCloseHandler(context);

    // ───── open agent in a VS Code terminal ─────
    const openAgent = async (
        arg?: string | AgentItem | { agent: string; task: string; displayName?: string }
    ) => {
        let agentId: string | undefined;
        let task: string | undefined;
        let display: string | undefined;
        if (typeof arg === 'string') {
            agentId = arg;
        } else if (arg instanceof AgentItem) {
            agentId = arg.agent;
            task = arg.task;
            display = arg.displayName;
        } else if (arg && typeof arg === 'object' && 'agent' in arg) {
            agentId = arg.agent;
            task = arg.task;
            display = arg.displayName;
        } else {
            agentId = await vscode.window.showInputBox({ prompt: 'Tmux session name (agent id)' });
        }
        if (!agentId) return;

        const existing = vscode.window.terminals.find(t => (t as any)._claudeAgent === agentId);
        if (existing) {
            existing.show(false);
            return;
        }

        // Dead-agent click: auto-resume via the CLI so the tmux session comes
        // back with the same Claude conversation (via --resume <uuid>) before
        // we try to attach. User sees no difference except a brief delay.
        if (await isAgentDead(agentId)) {
            try {
                const root = await repoRoot();
                const cli = getCliCommands();
                await pexec(`${shellQuote(cli.agent)} ${shellQuote(agentId)} resume`, {
                    cwd: root ?? undefined,
                });
                // Give recon/tmux a moment to spin up the session.
                await new Promise(r => setTimeout(r, 600));
                provider.refresh();
            } catch (e: any) {
                vscode.window.showErrorMessage(
                    `Could not resume agent '${agentId}': ${e?.message ?? e}`
                );
                return;
            }
        }

        if (!task) {
            const m = agentId.match(/^([a-z0-9][a-z0-9-]*)-(orch|.*)$/);
            task = m?.[1];
        }
        if (!display && task) display = displayNameForAgent(agentId, task);

        // Use the agent's own icon (mortar-board for orchestrator, robot for
        // sub-agents) so the terminal tab matches what the user clicked in the
        // tree. Color still comes from the task so terminals group by hue.
        const iconName = task && isOrchestrator(agentId, task) ? 'mortar-board' : 'robot';
        const color = task ? colorForTask(task) : undefined;
        const termName = display ?? agentId;

        const terminal = vscode.window.createTerminal({
            name: termName,
            shellPath: '/bin/bash',
            shellArgs: ['-lc', `tmux attach -t ${shellQuote(agentId)}`],
            iconPath: new vscode.ThemeIcon(iconName, color),
            color,
        });
        (terminal as any)._claudeAgent = agentId;
        terminal.show(false);
    };

    // ───── URI handler ─────
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri: (uri: vscode.Uri) => {
                const params = new URLSearchParams(uri.query);
                const agent = params.get('agent');
                if (!agent) {
                    vscode.window.showErrorMessage(
                        'agentic-tasktrees: URI missing required ?agent=… parameter'
                    );
                    return;
                }
                openAgent(agent);
            },
        })
    );

    // ───── commands ─────
    context.subscriptions.push(
        vscode.commands.registerCommand('agentic-tasktrees.openAgent', openAgent),

        vscode.commands.registerCommand('agentic-tasktrees.refresh', () => provider.refresh()),

        vscode.commands.registerCommand('agentic-tasktrees.newTask', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'New task name (kebab-case)',
                placeHolder: 'e.g. google-auth',
                validateInput: v =>
                    /^[a-z0-9][a-z0-9-]*$/.test(v.trim())
                        ? null
                        : 'Use lowercase letters, numbers, and dashes only.',
            });
            if (!name) return;
            const desc = await vscode.window.showInputBox({
                prompt: `Description for task '${name}' (purpose, scope, plan)`,
                placeHolder: 'one-line description; agents read this as BUNDLE.md',
            });
            if (desc === undefined) return;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Creating task '${name}'…`,
                    cancellable: false,
                },
                async () => {
                    await runCli(getCliCommands().task, ['new', name, desc, '--no-attach']);
                }
            );
            // Kick off dep install immediately (npm / venv) in the background.
            markFreshlyCreated(name);
            provider.refresh();
            vscode.window.showInformationMessage(`Task '${name}' created. Installing deps in background…`);
        }),

        vscode.commands.registerCommand('agentic-tasktrees.newAgent', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const name = await vscode.window.showInputBox({
                prompt: `New agent name (kebab-case) for task '${task}'`,
                placeHolder: 'e.g. hero-section',
                validateInput: v =>
                    /^[a-z0-9][a-z0-9-]*$/.test(v.trim())
                        ? null
                        : 'Use lowercase letters, numbers, and dashes only.',
            });
            if (!name) return;
            const role = await vscode.window.showInputBox({
                prompt: `Role for '${name}'`,
                placeHolder: 'e.g. section-builder, tester, reviewer',
                value: 'agent',
            });
            if (role === undefined) return;
            const desc = await vscode.window.showInputBox({
                prompt: `Initial task for '${name}'`,
                placeHolder: 'first message delivered as [MESSAGE] from Orchestrator',
            });
            if (desc === undefined) return;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Spawning agent '${name}'…`,
                    cancellable: false,
                },
                async () => {
                    await runCli(getCliCommands().agent, ['new', '--task', task, name, role || 'agent', desc]);
                }
            );
            provider.refresh();
            vscode.window.showInformationMessage(`Agent '${name}' spawned.`);
        }),

        vscode.commands.registerCommand('agentic-tasktrees.editBundle', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const p = await getBundleMdPath(task);
            if (!p) {
                vscode.window.showErrorMessage(`Could not resolve BUNDLE.md path for task '${task}'.`);
                return;
            }
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (e) {
                vscode.window.showErrorMessage(`Could not open ${p}: ${e}`);
            }
        }),

        vscode.commands.registerCommand('agentic-tasktrees.startDev', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            await startDev(task);
        }),

        vscode.commands.registerCommand('agentic-tasktrees.stopDev', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            await stopDev(task);
            vscode.window.showInformationMessage(`Stopped dev servers for '${task}'.`);
        }),

        vscode.commands.registerCommand('agentic-tasktrees.test', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const browserServer = getDevServers().find(s => s.openInBrowser);
            if (!browserServer) {
                vscode.window.showInformationMessage(
                    'No dev server is marked `openInBrowser: true`. Configure one in `agenticTaskTrees.devServers`.'
                );
                return;
            }
            if (!isDevRunning(task)) await startDev(task);
            const port = getRunningPort(task, browserServer.name) ?? (await plannedPort(task, browserServer));
            if (port === undefined) {
                vscode.window.showWarningMessage(
                    `Dev server '${browserServer.name}' has no portBase configured.`
                );
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
        }),

        // ───── overflow ("…") menu — opens a QuickPick of secondary actions ─────
        vscode.commands.registerCommand('agentic-tasktrees.taskMore', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const devRunning = isDevRunning(task);
            const choices: Array<vscode.QuickPickItem & { id: string }> = [
                { id: 'edit',  label: '$(edit) Edit BUNDLE.md', description: 'Open the task description for manual editing' },
                devRunning
                    ? { id: 'stop',  label: '$(debug-stop) Stop dev servers', description: 'Stop the backend + web background processes' }
                    : { id: 'start', label: '$(play) Start dev servers',     description: 'Backend + web in this worktree (background, port-shifted)' },
                { id: 'logs',  label: '$(output) Show dev logs', description: 'Reveal the Output channel for this task\'s dev processes' },
                { id: 'test',  label: '$(globe) Open test URL', description: 'Ensure dev is running, open the web port in your browser' },
                { id: 'refresh', label: '$(refresh) Refresh tree', description: 'Re-scan worktrees and tmux sessions' },
            ];
            const picked = await vscode.window.showQuickPick(choices, {
                placeHolder: `Actions for ${displayNameForTask(task)}`,
            });
            if (!picked) return;
            const itemArg = item;
            switch (picked.id) {
                case 'edit':    return vscode.commands.executeCommand('agentic-tasktrees.editBundle', itemArg);
                case 'start':   return vscode.commands.executeCommand('agentic-tasktrees.startDev', itemArg);
                case 'stop':    return vscode.commands.executeCommand('agentic-tasktrees.stopDev', itemArg);
                case 'logs':    return vscode.commands.executeCommand('agentic-tasktrees.showDevLogs', itemArg);
                case 'test':    return vscode.commands.executeCommand('agentic-tasktrees.test', itemArg);
                case 'refresh': return vscode.commands.executeCommand('agentic-tasktrees.refresh');
            }
        }),

        vscode.commands.registerCommand('agentic-tasktrees.showDevLogs', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const ok = showDevLogs(task);
            if (!ok) {
                vscode.window.showInformationMessage(
                    `No dev logs yet for '${task}' — start dev servers first.`
                );
            }
        }),

        vscode.commands.registerCommand('agentic-tasktrees.finishTask', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const confirm = await vscode.window.showInformationMessage(
                `Finish task '${task}'? This runs an interactive review/merge flow in a new terminal panel.`,
                { modal: true },
                'Finish'
            );
            if (confirm !== 'Finish') return;
            const terminal = vscode.window.createTerminal({
                name: `finish: ${task}`,
                shellPath: '/bin/bash',
                shellArgs: ['-lc', `${shellQuote(getCliCommands().task)} ${shellQuote(task)} finish; echo; echo '(task finish complete — press any key to close)'; read -n1`],
            });
            terminal.show(true);
        }),

        vscode.commands.registerCommand('agentic-tasktrees.killTask', async (item?: TaskItem) => {
            const task = item?.task ?? (await pickTask());
            if (!task) return;
            const agents = provider.agentsForTask(task);
            const root = await repoRoot();
            const wtPath = root ? `${root}/.worktrees/${task}` : `.worktrees/${task}`;
            const head = agents.length === 0
                ? `Delete task '${task}'? No live agents tracked.`
                : `Delete task '${task}' and kill its ${agents.length} agent(s)?\n\n` +
                  agents.map(a => `  • ${a}`).join('\n');
            const body = `\n\nThis will:\n` +
                `  • kill every agent for this task (tmux + .agents registry)\n` +
                `  • remove the worktree directory at ${wtPath}\n` +
                `  • DISCARD any uncommitted changes in that worktree\n\n` +
                `Use Finish (✓) instead if you want to merge to main first. ` +
                `The branch itself is kept.`;
            const c1 = await vscode.window.showWarningMessage(head + body, { modal: true }, 'Delete');
            if (c1 !== 'Delete') return;
            const c2 = await vscode.window.showWarningMessage(
                `Really delete '${task}'? This cannot be undone.`,
                { modal: true },
                'Yes, delete'
            );
            if (c2 !== 'Yes, delete') return;

            // Step 1: kill each agent directly. The `task <id> kill` script has a
            // stale recon-tag filter that misses sub-agents — iterating
            // `agent <id> kill` per cached snapshot entry is reliable.
            const cli = getCliCommands();
            const results = await Promise.all(
                agents.map(async a => ({ agent: a, code: await runCli(cli.agent, [a, 'kill']) }))
            );
            const failedKills = results.filter(r => r.code !== 0);
            const succeededKills = results.length - failedKills.length;

            // Step 2: remove the worktree. --force tolerates uncommitted changes,
            // which the user just confirmed they're willing to lose.
            let worktreeRemoved = false;
            let worktreeError: string | undefined;
            if (root) {
                const code = await runCli('git', ['worktree', 'remove', '--force', wtPath]);
                if (code === 0) {
                    worktreeRemoved = true;
                } else {
                    worktreeError = `git worktree remove exited ${code}`;
                }
            } else {
                worktreeError = 'no repo root resolved';
            }

            await provider.poll(true);

            const parts: string[] = [];
            parts.push(`Killed ${succeededKills}/${results.length} agent(s)`);
            parts.push(worktreeRemoved ? 'removed worktree' : `worktree NOT removed (${worktreeError})`);
            const msg = `Task '${task}': ${parts.join('; ')}.`;
            if (failedKills.length === 0 && worktreeRemoved) {
                vscode.window.showInformationMessage(msg);
            } else {
                getCliChannel().show(true);
                vscode.window.showWarningMessage(`${msg} See 'Agentic TaskTrees' output channel.`);
            }
        }),

        vscode.commands.registerCommand('agentic-tasktrees.killAgent', async (item?: AgentItem) => {
            let agent = item?.agent;
            if (!agent) {
                agent = await vscode.window.showInputBox({
                    prompt: 'Agent (tmux session) to kill',
                });
            }
            if (!agent) return;
            const c1 = await vscode.window.showWarningMessage(
                `Kill agent '${agent}'?`,
                { modal: true },
                'Kill'
            );
            if (c1 !== 'Kill') return;
            const c2 = await vscode.window.showWarningMessage(
                `Are you sure you're sure?`,
                { modal: true },
                'Yes, kill'
            );
            if (c2 !== 'Yes, kill') return;
            const code = await runCli(getCliCommands().agent, [agent, 'kill']);
            await provider.poll(true);
            if (code === 0) {
                vscode.window.showInformationMessage(`Killed agent '${agent}'.`);
            } else {
                getCliChannel().show(true);
                vscode.window.showErrorMessage(
                    `Failed to kill agent '${agent}' (exit ${code}). See 'Agentic TaskTrees' output channel.`
                );
            }
        })
    );
}

// ───── helpers ─────

function shellQuote(s: string): string {
    if (/^[a-zA-Z0-9._-]+$/.test(s)) return s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function pickTask(): Promise<string | undefined> {
    const { listTasks } = await import('./tree');
    const tasks = await listTasks();
    if (tasks.length === 0) {
        vscode.window.showWarningMessage('No tasks found (no .worktrees/ subdirectories).');
        return undefined;
    }
    return await vscode.window.showQuickPick(tasks, { placeHolder: 'Pick a task' });
}

/**
 * Lazily-created output channel for CLI invocations the extension makes
 * (task / agent / recon). We need this on a separate channel from the
 * per-task dev/setup channels so users can see *why* a button silently
 * "succeeded".
 */
let cliChannel: vscode.OutputChannel | undefined;
function getCliChannel(): vscode.OutputChannel {
    if (!cliChannel) cliChannel = vscode.window.createOutputChannel('Agentic TaskTrees');
    return cliChannel;
}

/**
 * Run a CLI, capture stdout/stderr to the CLI output channel, and surface
 * failures via a notification. Resolves with the exit code (or -1 on spawn
 * error so callers can branch on success cleanly).
 */
function runCli(cmd: string, args: string[]): Promise<number> {
    return new Promise(resolve => {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const channel = getCliChannel();
        channel.appendLine(`\n$ ${cmd} ${args.join(' ')}   (cwd=${folder ?? '<none>'})`);
        let child;
        try {
            child = spawn(cmd, args, {
                cwd: folder,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false,
                env: process.env,
            });
        } catch (e: any) {
            const msg = `Could not spawn '${cmd}': ${e?.message ?? e}`;
            channel.appendLine(msg);
            vscode.window.showErrorMessage(msg);
            resolve(-1);
            return;
        }
        child.stdout?.on('data', d => channel.append(d.toString()));
        child.stderr?.on('data', d => channel.append(d.toString()));
        child.on('exit', code => {
            channel.appendLine(`[exit ${code}]`);
            resolve(code ?? -1);
        });
        child.on('error', err => {
            const msg = `'${cmd}' failed: ${err.message}`;
            channel.appendLine(msg);
            vscode.window.showErrorMessage(
                `${msg}. Check 'Agentic TaskTrees' output channel for details; ` +
                `you may need to set 'agenticTaskTrees.commands.${cmd === getCliCommands().task ? 'task' : cmd === getCliCommands().agent ? 'agent' : 'recon'}' to an absolute path.`
            );
            resolve(-1);
        });
    });
}

export function deactivate() {}
