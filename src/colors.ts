import * as vscode from 'vscode';

/** Six-color palette used to tint each task's icon (in the tree) and the
 *  matching terminal. Picked deterministically from a hash of the task name,
 *  so a given task keeps the same color across sessions. */
const PALETTE = [
    'terminal.ansiRed',
    'terminal.ansiYellow',
    'terminal.ansiGreen',
    'terminal.ansiCyan',
    'terminal.ansiBlue',
    'terminal.ansiMagenta',
];

export function colorForTask(task: string): vscode.ThemeColor {
    let hash = 0;
    for (const c of task) {
        hash = (hash * 31 + c.charCodeAt(0)) & 0x7fffffff;
    }
    return new vscode.ThemeColor(PALETTE[hash % PALETTE.length]);
}
