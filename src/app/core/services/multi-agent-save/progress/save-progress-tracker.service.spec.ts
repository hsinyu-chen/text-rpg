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
        const id2 = tracker.startEntry('sub-tool', { toolName: 'inventoryDeltas' });
        expect(id1).not.toBe(id2);
        const entries = tracker.entries();
        expect(entries).toHaveLength(2);
        expect(entries[0].state).toBe('running');
        expect(entries[1].toolName).toBe('inventoryDeltas');
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
        const id = tracker.startEntry('sub-tool', { toolName: 'inventoryDeltas' });
        tracker.finishEntry(id, 'done');
        const e = tracker.entries()[0];
        expect(e.state).toBe('done');
        expect(e.finishedAt).toBeDefined();
    });

    it('skip(reason) is a shortcut for finishEntry("skipped", reason)', () => {
        const id = tracker.startEntry('sub-tool', { toolName: 'magicSkillsUpdates' });
        tracker.skip(id, 'not_yet_implemented');
        const e = tracker.entries()[0];
        expect(e.state).toBe('skipped');
        expect(e.statusReason).toBe('not_yet_implemented');
    });

    it('patch operations on unknown entryId are no-ops (no throw)', () => {
        tracker.appendThought('does-not-exist', 'x');
        tracker.finishEntry('also-no', 'done');
        expect(tracker.entries()).toEqual([]);
    });

    it('totalUsage sums across entries; entries without usage are skipped', () => {
        const a = tracker.startEntry('manifest');
        tracker.setUsage(a, { prompt: 10, candidates: 2, cached: 8 });
        tracker.startEntry('sub-tool');
        const c = tracker.startEntry('sub-tool');
        tracker.setUsage(c, { prompt: 5, candidates: 1, cached: 3 });
        expect(tracker.totalUsage()).toEqual({ prompt: 15, candidates: 3, cached: 11 });
    });

    it('reset clears entries + isRunning flag', () => {
        tracker.startEntry('manifest');
        tracker.setRunning(true);
        tracker.reset();
        expect(tracker.entries()).toEqual([]);
        expect(tracker.isRunning()).toBe(false);
    });
});
