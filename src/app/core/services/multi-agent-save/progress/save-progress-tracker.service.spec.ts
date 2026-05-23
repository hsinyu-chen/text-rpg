import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SaveProgressTracker } from './save-progress-tracker.service';

describe('SaveProgressTracker', () => {
    let tracker: SaveProgressTracker;

    beforeEach(() => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        tracker = TestBed.inject(SaveProgressTracker);
        tracker.reset();
    });

    it('starts empty', () => {
        expect(tracker.entries()).toEqual([]);
        expect(tracker.isRunning()).toBe(false);
    });

    it('startEntry appends a running entry with a unique id', () => {
        const id1 = tracker.startEntry('manifest');
        const id2 = tracker.startEntry('manifest', { toolName: 'SaveAgent' });
        expect(id1).not.toBe(id2);
        const entries = tracker.entries();
        expect(entries).toHaveLength(2);
        expect(entries[0].state).toBe('running');
        expect(entries[1].toolName).toBe('SaveAgent');
    });

    it('appendThought / appendOutput accumulate streamed chunks', () => {
        const id = tracker.startEntry('manifest');
        tracker.appendThought(id, 'a');
        tracker.appendThought(id, 'b');
        tracker.appendOutput(id, '{');
        tracker.appendOutput(id, '}');
        const e = tracker.entries()[0];
        expect(e.thought).toBe('ab');
        expect(e.output).toBe('{}');
    });

    it('setPpProgress / setUsage attach metadata to an entry', () => {
        const id = tracker.startEntry('manifest');
        tracker.setPpProgress(id, 0.2);
        tracker.setUsage(id, { prompt: 1000, candidates: 200, cached: 800 });
        const e = tracker.entries()[0];
        expect(e.ppProgress).toBe(0.2);
        expect(e.usage).toEqual({ prompt: 1000, candidates: 200, cached: 800 });
    });

    it('finishEntry sets state + statusReason + finishedAt', () => {
        const id = tracker.startEntry('manifest', { toolName: 'SaveAgent' });
        tracker.finishEntry(id, 'done');
        const e = tracker.entries()[0];
        expect(e.state).toBe('done');
        expect(e.finishedAt).toBeDefined();
    });

    it('skip(reason) is a shortcut for finishEntry("skipped", reason)', () => {
        const id = tracker.startEntry('manifest', { toolName: 'SaveAgent' });
        tracker.skip(id, 'user_aborted');
        const e = tracker.entries()[0];
        expect(e.state).toBe('skipped');
        expect(e.statusReason).toBe('user_aborted');
    });

    it('patch operations on unknown entryId are no-ops (no throw)', () => {
        tracker.appendThought('does-not-exist', 'x');
        tracker.finishEntry('also-no', 'done');
        expect(tracker.entries()).toEqual([]);
    });

    it('totalUsage sums across entries; entries without usage are skipped', () => {
        const a = tracker.startEntry('manifest');
        tracker.setUsage(a, { prompt: 10, candidates: 2, cached: 8 });
        tracker.startEntry('manifest');
        const c = tracker.startEntry('manifest');
        tracker.setUsage(c, { prompt: 5, candidates: 1, cached: 3 });
        expect(tracker.totalUsage()).toEqual({ prompt: 15, candidates: 3, cached: 11 });
    });

    it('setWorkComplete optional hasUpdates flag drives the dialog Continue button', () => {
        expect(tracker.workComplete()).toBe(false);
        expect(tracker.hasUpdates()).toBe(false);
        tracker.setWorkComplete(true, true);
        expect(tracker.workComplete()).toBe(true);
        expect(tracker.hasUpdates()).toBe(true);
        tracker.reset();
        expect(tracker.workComplete()).toBe(false);
        expect(tracker.hasUpdates()).toBe(false);
    });

    it('reset clears entries but leaves isRunning alone (orchestrator owns lifecycle)', () => {
        tracker.startEntry('manifest');
        tracker.setRunning(true);
        tracker.reset();
        expect(tracker.entries()).toEqual([]);
        // isRunning untouched by reset — caller's responsibility (the
        // orchestrator calls reset() then setRunning(true) in sequence; a
        // false-then-true flip from reset would emit a spurious signal).
        expect(tracker.isRunning()).toBe(true);
    });
});
