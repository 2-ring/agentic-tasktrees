import * as path from 'path';
import * as childProc from 'child_process';
import * as vscode from 'vscode';
import { portsForServer } from './ports';
import { displayNameForTask, repoRoot } from './tree';
import { ensureSetup, isInstalling } from './setup';
import { getDevServers, subst, substArgs, DevServerConfig } from './config';

interface RunningServer {
    proc: childProc.ChildProcess;
    port?: number;
}

interface DevState {
    servers: Map<string, RunningServer>;
    output?: vscode.OutputChannel;
}

const devServers = new Map<string, DevState>();
const listeners: Array<() => void> = [];

/** Listen for dev-state changes so the tree provider can flip play↔stop instantly. */
export function onDevStateChanged(fn: () => void): vscode.Disposable {
    listeners.push(fn);
    return {
        dispose: () => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        },
    };
}

function notify() {
    for (const fn of listeners) fn();
}

export function isDevRunning(task: string): boolean {
    const s = devServers.get(task);
    if (!s) return false;
    for (const r of s.servers.values()) {
        if (!r.proc.killed) return true;
    }
    return false;
}

/** Called from extension activate(); kills any orphaned dev children on shutdown. */
export function registerTerminalCloseHandler(context: vscode.ExtensionContext): void {
    context.subscriptions.push({
        dispose: () => {
            for (const state of devServers.values()) {
                for (const r of state.servers.values()) killProc(r.proc);
            }
            devServers.clear();
        },
    });
}

/** Bring the dev-logs Output channel for this task to the front. */
export function showDevLogs(task: string): boolean {
    const s = devServers.get(task);
    if (!s?.output) return false;
    s.output.show(true);
    return true;
}

/** Resolved port for a given dev server within a task, if it is running. */
export function getRunningPort(task: string, serverName: string): number | undefined {
    return devServers.get(task)?.servers.get(serverName)?.port;
}

/**
 * Compute the port for a dev server within a task without spawning anything.
 * Returns undefined if the server has no `portBase` (i.e., doesn't need a port).
 */
export async function plannedPort(task: string, server: DevServerConfig): Promise<number | undefined> {
    if (server.portBase === undefined) return undefined;
    return await portsForServer(task, server.name, server.portBase);
}

export async function startDev(task: string): Promise<void> {
    const root = await repoRoot();
    if (!root) {
        vscode.window.showErrorMessage('No workspace open.');
        return;
    }
    const wt = path.join(root, '.worktrees', task);
    const taskTitle = displayNameForTask(task);
    const configured = getDevServers();

    if (configured.length === 0) {
        vscode.window.showInformationMessage(
            'No dev servers configured. Set `agenticTaskTrees.devServers` in workspace settings.'
        );
        return;
    }

    // Wait on any in-flight setup; otherwise run setup synchronously if needed.
    if (isInstalling(task)) {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Waiting for '${taskTitle}' setup to finish…`,
                cancellable: false,
            },
            () => ensureSetup(task)
        );
    } else {
        try {
            await ensureSetup(task);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Setup failed for '${task}': ${e?.message ?? e}`);
            return;
        }
    }

    let state: DevState = devServers.get(task) ?? { servers: new Map() };
    if (!state.output) {
        state.output = vscode.window.createOutputChannel(`Agentic TaskTrees: ${taskTitle}`);
    }

    for (const server of configured) {
        const existing = state.servers.get(server.name);
        if (existing && !existing.proc.killed) continue;

        const port = await plannedPort(task, server);
        const vars = { worktree: wt, task, port };
        const cwd = subst(server.cwd, vars);
        const cmd = subst(server.command, vars);
        const args = substArgs(server.args, vars);

        state.output.appendLine(
            `\n──── starting ${server.name}${port !== undefined ? ` (port ${port})` : ''} ─────────────`
        );
        state.output.appendLine(`$ ${cmd} ${args.join(' ')}   (cwd=${cwd})`);

        const env: NodeJS.ProcessEnv = { ...process.env };
        if (server.portEnv && port !== undefined) env[server.portEnv] = String(port);

        const proc = childProc.spawn(cmd, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        proc.stdout?.on('data', d => state.output!.append(d.toString()));
        proc.stderr?.on('data', d => state.output!.append(d.toString()));
        proc.on('exit', (code, signal) => {
            state.output?.appendLine(`──── ${server.name} exited (code=${code}, signal=${signal}) ────`);
            const r = state.servers.get(server.name);
            if (r?.proc === proc) state.servers.delete(server.name);
            notify();
        });
        proc.on('error', err => {
            state.output?.appendLine(`──── ${server.name} error: ${err.message} ────`);
            const r = state.servers.get(server.name);
            if (r?.proc === proc) state.servers.delete(server.name);
            notify();
        });

        state.servers.set(server.name, { proc, port });
    }

    devServers.set(task, state);
    notify();
}

export async function stopDev(task: string): Promise<void> {
    const state = devServers.get(task);
    if (!state) return;
    for (const r of state.servers.values()) killProc(r.proc);
    state.servers.clear();
    state.output?.appendLine(`\n──── stop requested by user ─────────`);
    notify();
}

/** Send SIGTERM to the process group so the child + its grandchildren (vite, etc.) die cleanly. */
function killProc(proc?: childProc.ChildProcess): void {
    if (!proc || proc.killed || !proc.pid) return;
    try {
        process.kill(-proc.pid, 'SIGTERM');
    } catch {
        try {
            proc.kill('SIGTERM');
        } catch {
            // best effort
        }
    }
}
