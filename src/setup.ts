import * as fs from 'fs/promises';
import * as path from 'path';
import * as childProc from 'child_process';
import * as vscode from 'vscode';
import { repoRoot, displayNameForTask } from './tree';
import { getSetupSteps, subst, substArgs, SetupConfig } from './config';

/**
 * Per-task setup steps (e.g. dependency installs). Each item in
 * `agenticTaskTrees.setup` declares a `cwd`, an optional `trigger` file that
 * must exist for it to apply, an optional `skipMarker` that means it's already
 * done, and an ordered list of commands to run.
 *
 * Strategy:
 *   - Extension start: existing tasks are recorded but NOT re-installed.
 *   - New task appears: kick off install in the background.
 *   - startDev: `ensureSetup` is idempotent — completes immediately if done,
 *     awaits in-flight, or runs from scratch if needed.
 */

interface InstallState {
    promise: Promise<void>;
    output: vscode.OutputChannel;
}

const installs = new Map<string, InstallState>();
const seen = new Set<string>();
let initialized = false;

function getChannel(task: string): vscode.OutputChannel {
    const existing = installs.get(task);
    if (existing) return existing.output;
    return vscode.window.createOutputChannel(`Agentic TaskTrees: ${displayNameForTask(task)} (setup)`);
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    } catch {
        return false;
    }
}

interface ApplicableStep { config: SetupConfig; cwd: string; }

/**
 * Resolve which setup blocks apply: their cwd's trigger file exists and the
 * skipMarker doesn't. Skip blocks whose trigger is missing — that signals
 * "this language/component isn't part of this task."
 */
async function applicableSteps(wt: string, task: string): Promise<ApplicableStep[]> {
    const configured = getSetupSteps();
    const out: ApplicableStep[] = [];
    for (const block of configured) {
        const vars = { worktree: wt, task };
        const cwd = subst(block.cwd, vars);
        if (block.trigger) {
            const triggerPath = path.isAbsolute(block.trigger) ? block.trigger : path.join(cwd, block.trigger);
            if (!(await fileExists(triggerPath))) continue;
        }
        if (block.skipMarker) {
            const markerPath = path.isAbsolute(block.skipMarker) ? block.skipMarker : path.join(cwd, block.skipMarker);
            if (await fileExists(markerPath)) continue;
        }
        out.push({ config: block, cwd });
    }
    return out;
}

function runWithOutput(
    cmd: string,
    args: string[],
    cwd: string,
    channel: vscode.OutputChannel
): Promise<void> {
    return new Promise((resolve, reject) => {
        channel.appendLine(`$ ${cmd} ${args.join(' ')}   (cwd=${cwd})`);
        const proc = childProc.spawn(cmd, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        proc.stdout?.on('data', d => channel.append(d.toString()));
        proc.stderr?.on('data', d => channel.append(d.toString()));
        proc.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

/** Idempotent: returns instantly if no work is needed, awaits in-flight installs,
 *  or kicks off and awaits a fresh install. */
export async function ensureSetup(task: string): Promise<void> {
    const existing = installs.get(task);
    if (existing) return existing.promise;

    const root = await repoRoot();
    if (!root) return;
    const wt = path.join(root, '.worktrees', task);

    const applicable = await applicableSteps(wt, task);
    if (applicable.length === 0) return;

    const channel = getChannel(task);
    const promise = (async () => {
        const jobs: Promise<void>[] = [];
        for (const block of applicable) {
            channel.appendLine(`\n──── ${block.config.name} (${task}) ────`);
            jobs.push((async () => {
                const vars = { worktree: wt, task };
                for (const step of block.config.steps) {
                    await runWithOutput(
                        subst(step.command, vars),
                        substArgs(step.args, vars),
                        block.cwd,
                        channel,
                    );
                }
            })());
        }
        try {
            await Promise.all(jobs);
            channel.appendLine(`\n──── setup complete for '${task}' ─────────────`);
        } catch (e: any) {
            channel.appendLine(`\n──── setup FAILED: ${e?.message ?? e} ────`);
            throw e;
        }
    })();

    installs.set(task, { promise, output: channel });
    promise.finally(() => installs.delete(task));
    return promise;
}

/** Returns `true` if a setup is currently running for this task. */
export function isInstalling(task: string): boolean {
    return installs.has(task);
}

/** Called from the tree provider on every refresh. The FIRST call records the
 *  current tasks without triggering anything (they may already be set up).
 *  Subsequent calls trigger background install for any new task. */
export function notifyTaskSeen(tasks: string[]): void {
    if (!initialized) {
        for (const t of tasks) seen.add(t);
        initialized = true;
        return;
    }
    for (const t of tasks) {
        if (!seen.has(t)) {
            seen.add(t);
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: `Setting up '${displayNameForTask(t)}' deps…`,
                },
                () => ensureSetup(t).catch(() => { /* errors shown in setup channel */ })
            );
        }
    }
}

/** Manually mark a task as seen+install-triggered. Useful when the extension
 *  itself just created the task (so we don't wait for the 3s refresh tick). */
export function markFreshlyCreated(task: string): void {
    seen.add(task);
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: `Setting up '${displayNameForTask(task)}' deps…`,
        },
        () => ensureSetup(task).catch(() => { /* errors visible in setup channel */ })
    );
}
