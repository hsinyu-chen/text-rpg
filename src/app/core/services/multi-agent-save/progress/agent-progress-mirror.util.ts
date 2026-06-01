import { Signal, effect } from '@angular/core';
import type { AgentLogEntry, TodoItem } from '../../agent-runner/agent-runner.types';
import type { SaveProgressTracker } from './save-progress-tracker.service';

/**
 * The agent-loop signals an advanced-save agent mirrors into its active
 * {@link SaveProgressTracker} entry. `activeEntryId` gates all three — when
 * null (no entry in flight) nothing is written. Every read is a signal so an
 * effect re-fires on an entry-id swap OR a new value.
 */
export interface AgentProgressMirrorDeps {
    progress: SaveProgressTracker;
    activeEntryId: Signal<string | null>;
    promptProgress: Signal<number | undefined>;
    agentLogs: Signal<readonly AgentLogEntry[]>;
    todoList: Signal<readonly TodoItem[]>;
}

/**
 * Installs the standard live-mirror effects from an advanced-save agent's loop
 * state into its progress-dialog card: prefill/PP bar, streamed trace logs, and
 * the `updateTodos` checklist (which drives the header's "current step (N/M)"
 * readout). Shared by every advanced-save agent that runs the tool-call loop
 * inside the save progress dialog (InventoryConsistencyAgent + the per-entity
 * agents) so the three effects aren't re-hand-rolled per agent.
 *
 * Call from the agent's constructor — `effect()` needs the injection context,
 * which is active through the constructor's synchronous body.
 */
export function installAgentProgressMirrors(deps: AgentProgressMirrorDeps): void {
    // PP / prefill bar.
    effect(() => {
        const id = deps.activeEntryId();
        const pp = deps.promptProgress();
        if (id && pp !== undefined) deps.progress.setPpProgress(id, pp);
    });
    // Streamed trace logs — re-rendered live, not just at turn boundaries.
    effect(() => {
        const id = deps.activeEntryId();
        const logs = deps.agentLogs();
        if (id) deps.progress.setEntryLogs(id, logs);
    });
    // updateTodos checklist — drives the compact "current step (N/M)" readout.
    effect(() => {
        const id = deps.activeEntryId();
        const todos = deps.todoList();
        if (id) deps.progress.setEntryTodos(id, todos);
    });
}
