import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Stable per-task port offsets, persisted to `.vscode/agentic-tasktrees.json`.
 *
 * Each task gets a single non-negative integer offset assigned the first time
 * one of its dev servers needs a port. Every server's effective port is
 * `server.portBase + offset`. The offset is shared across all servers in a
 * task so a single task occupies a contiguous block of ports per portBase.
 */

interface PersistedConfig {
    /** Per-task offset (kept for backwards compat with the previous schema). */
    taskOffsets?: { [task: string]: number };
    /** Legacy v0 schema — backend/web ports per task. Migrated on first read. */
    ports?: { [task: string]: { backend?: number; web?: number } };
}

async function configPath(): Promise<string | null> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return null;
    return path.join(folder, '.vscode', 'agentic-tasktrees.json');
}

async function loadAll(): Promise<PersistedConfig> {
    const p = await configPath();
    if (!p) return {};
    try {
        return JSON.parse(await fs.readFile(p, 'utf-8'));
    } catch {
        return {};
    }
}

async function saveAll(cfg: PersistedConfig): Promise<void> {
    const p = await configPath();
    if (!p) return;
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Resolve the port for (task, serverName) with the given base. Allocates and
 * persists a new offset for the task if none exists yet. `serverName` is
 * currently used only for the migration path; the assigned offset is per-task,
 * not per-server, so a single task occupies portBase+N across all its servers.
 */
export async function portsForServer(task: string, _serverName: string, portBase: number): Promise<number> {
    const cfg = await loadAll();
    cfg.taskOffsets ??= {};

    // One-shot migration: if the legacy schema persisted backend ports starting
    // at 5000, infer the offset from there so existing tasks keep their ports.
    if (cfg.ports && cfg.ports[task] && cfg.taskOffsets[task] === undefined) {
        const legacy = cfg.ports[task];
        if (typeof legacy.backend === 'number') {
            cfg.taskOffsets[task] = legacy.backend - 5000;
        }
    }

    if (cfg.taskOffsets[task] === undefined) {
        const used = new Set(Object.values(cfg.taskOffsets));
        let offset = 1;
        while (used.has(offset)) offset++;
        cfg.taskOffsets[task] = offset;
        await saveAll(cfg);
    }

    return portBase + cfg.taskOffsets[task]!;
}
