import * as vscode from 'vscode';

/**
 * Workspace settings (`agenticTaskTrees.*`). All values are read on demand so
 * users can edit settings.json without reloading the window. The extension
 * itself has no hardcoded project layout — dev servers and setup steps are
 * supplied by the workspace, which is what makes it project-agnostic.
 */

export interface DevServerConfig {
    name: string;
    cwd: string;
    command: string;
    args: string[];
    portBase?: number;
    portEnv?: string;
    openInBrowser: boolean;
}

export interface SetupStep {
    command: string;
    args: string[];
}

export interface SetupConfig {
    name: string;
    cwd: string;
    trigger?: string;
    skipMarker?: string;
    steps: SetupStep[];
}

export interface CliCommands {
    task: string;
    agent: string;
    recon: string;
}

function section(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('agenticTaskTrees');
}

export function getDevServers(): DevServerConfig[] {
    const raw = section().get<any[]>('devServers') ?? [];
    return raw.map(r => ({
        name: String(r?.name ?? ''),
        cwd: String(r?.cwd ?? ''),
        command: String(r?.command ?? ''),
        args: Array.isArray(r?.args) ? r.args.map(String) : [],
        portBase: typeof r?.portBase === 'number' ? r.portBase : undefined,
        portEnv: typeof r?.portEnv === 'string' ? r.portEnv : undefined,
        openInBrowser: Boolean(r?.openInBrowser),
    })).filter(s => s.name && s.cwd && s.command);
}

export function getSetupSteps(): SetupConfig[] {
    const raw = section().get<any[]>('setup') ?? [];
    return raw.map(r => ({
        name: String(r?.name ?? ''),
        cwd: String(r?.cwd ?? ''),
        trigger: typeof r?.trigger === 'string' ? r.trigger : undefined,
        skipMarker: typeof r?.skipMarker === 'string' ? r.skipMarker : undefined,
        steps: Array.isArray(r?.steps)
            ? r.steps
                .map((s: any) => ({
                    command: String(s?.command ?? ''),
                    args: Array.isArray(s?.args) ? s.args.map(String) : [],
                }))
                .filter((s: SetupStep) => s.command)
            : [],
    })).filter(s => s.name && s.cwd && s.steps.length > 0);
}

export function getCliCommands(): CliCommands {
    const cfg = section();
    return {
        task: cfg.get<string>('commands.task') || 'task',
        agent: cfg.get<string>('commands.agent') || 'agent',
        recon: cfg.get<string>('commands.recon') || 'recon',
    };
}

export function getPollIntervalMs(): number {
    const v = section().get<number>('pollIntervalMs');
    if (typeof v === 'number' && v >= 250) return v;
    return 3000;
}

/**
 * Replace `${worktree}`, `${task}`, `${port}` (when supplied) in a string.
 * Unknown placeholders are left as-is so users notice typos.
 */
export interface Vars { worktree: string; task: string; port?: number; }

export function subst(s: string, vars: Vars): string {
    return s
        .replace(/\$\{worktree\}/g, vars.worktree)
        .replace(/\$\{task\}/g, vars.task)
        .replace(/\$\{port\}/g, vars.port !== undefined ? String(vars.port) : '${port}');
}

export function substArgs(args: string[], vars: Vars): string[] {
    return args.map(a => subst(a, vars));
}
