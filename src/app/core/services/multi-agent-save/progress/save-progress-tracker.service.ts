import { Injectable, signal } from '@angular/core';
import type {
    SaveEntryState,
    SavePhase,
    SaveProgressEntry,
    SaveSkipReason,
} from '../multi-agent-save.types';

/**
 * Append-only ledger of per-entry cards rendered in `SaveProgressDialog`.
 * The orchestrator and dispatcher push events here; the dialog reads from
 * the public `entries` signal.
 *
 * Why a service instead of inline state on the orchestrator: the dialog
 * component opens early (showing "manifest call in progress…") before the
 * orchestrator's first await resolves. Putting state on a singleton service
 * means both components see the same ledger without dialog-data plumbing,
 * and a follow-up "save trace" download can read the final array.
 *
 * Reset semantics: `reset()` clears between save runs — the dialog stays
 * mounted across runs is not a goal in Phase 1.
 */
@Injectable({ providedIn: 'root' })
export class SaveProgressTracker {
    private _entries = signal<readonly SaveProgressEntry[]>([]);
    readonly entries = this._entries.asReadonly();

    /** Lifecycle gate read by chat mask + FileAgentService disable check. */
    private _isRunning = signal(false);
    readonly isRunning = this._isRunning.asReadonly();

    /**
     * Clears the entry ledger. Lifecycle state (`isRunning`) is NOT touched
     * here — the orchestrator's `finally` block is the canonical site for
     * `setRunning(false)`, and `reset()` is called at run start (where the
     * orchestrator is about to call `setRunning(true)`). Touching it here
     * would emit a spurious false-then-true signal flip.
     */
    reset(): void {
        this._entries.set([]);
    }

    setRunning(running: boolean): void {
        this._isRunning.set(running);
    }

    startEntry(phase: SavePhase, opts?: { toolName?: string; entityName?: string }): string {
        const entryId = crypto.randomUUID();
        const entry: SaveProgressEntry = {
            entryId,
            phase,
            state: 'running',
            toolName: opts?.toolName,
            entityName: opts?.entityName,
            thought: '',
            output: '',
            startedAt: new Date().toISOString(),
        };
        this._entries.update(arr => [...arr, entry]);
        return entryId;
    }

    appendThought(entryId: string, chunk: string): void {
        this.patch(entryId, e => ({ ...e, thought: e.thought + chunk }));
    }

    appendOutput(entryId: string, chunk: string): void {
        this.patch(entryId, e => ({ ...e, output: e.output + chunk }));
    }

    setPpProgress(entryId: string, ratio: number): void {
        this.patch(entryId, e => ({ ...e, ppProgress: ratio }));
    }

    setUsage(entryId: string, usage: { prompt: number; candidates: number; cached: number }): void {
        this.patch(entryId, e => ({ ...e, usage }));
    }

    finishEntry(entryId: string, state: SaveEntryState, statusReason?: string): void {
        this.patch(entryId, e => ({
            ...e,
            state,
            statusReason,
            finishedAt: new Date().toISOString(),
        }));
    }

    /** Convenience wrapper for `not_yet_implemented` / `empty_section` etc. */
    skip(entryId: string, reason: SaveSkipReason): void {
        this.finishEntry(entryId, 'skipped', reason);
    }

    /** Total token usage across all entries — used by cost summary. */
    totalUsage(): { prompt: number; candidates: number; cached: number } {
        let prompt = 0, candidates = 0, cached = 0;
        for (const e of this._entries()) {
            if (e.usage) {
                prompt += e.usage.prompt;
                candidates += e.usage.candidates;
                cached += e.usage.cached;
            }
        }
        return { prompt, candidates, cached };
    }

    private patch(entryId: string, updater: (e: SaveProgressEntry) => SaveProgressEntry): void {
        this._entries.update(arr => {
            const idx = arr.findIndex(e => e.entryId === entryId);
            if (idx < 0) return arr;
            const copy = arr.slice();
            copy[idx] = updater(copy[idx]);
            return copy;
        });
    }
}
