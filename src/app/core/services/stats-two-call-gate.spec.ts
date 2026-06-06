import { describe, expect, it, vi } from 'vitest';
import { needsStatsTwoCallGate, runStatsTwoCallGate } from './stats-two-call-gate';
import { GAME_INTENTS } from '../constants/game-intents';

describe('needsStatsTwoCallGate', () => {
    it('fires for a stats Book on single-call with a story intent', () => {
        expect(needsStatsTwoCallGate(true, 'single', GAME_INTENTS.ACTION)).toBe(true);
        expect(needsStatsTwoCallGate(true, 'single', GAME_INTENTS.CONTINUE)).toBe(true);
        expect(needsStatsTwoCallGate(true, 'single', GAME_INTENTS.FAST_FORWARD)).toBe(true);
    });

    it('does not fire when the Book has no stats file (opt-in off = zero pollution)', () => {
        expect(needsStatsTwoCallGate(false, 'single', GAME_INTENTS.ACTION)).toBe(false);
    });

    it('does not fire when already on two-call', () => {
        expect(needsStatsTwoCallGate(true, 'two-call', GAME_INTENTS.ACTION)).toBe(false);
    });

    it('does not fire for non-story intents (SYSTEM bypasses the resolver split)', () => {
        expect(needsStatsTwoCallGate(true, 'single', GAME_INTENTS.SYSTEM)).toBe(false);
    });
});

describe('runStatsTwoCallGate', () => {
    it('confirm=true switches to two-call and proceeds', async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        const switchToTwoCall = vi.fn().mockResolvedValue(undefined);

        const proceed = await runStatsTwoCallGate({
            hasStatsYaml: true, engineMode: 'single', intent: GAME_INTENTS.ACTION, confirm, switchToTwoCall,
        });

        expect(proceed).toBe(true);
        expect(confirm).toHaveBeenCalledOnce();
        expect(switchToTwoCall).toHaveBeenCalledOnce();
    });

    it('confirm=false aborts without switching mode', async () => {
        const confirm = vi.fn().mockResolvedValue(false);
        const switchToTwoCall = vi.fn().mockResolvedValue(undefined);

        const proceed = await runStatsTwoCallGate({
            hasStatsYaml: true, engineMode: 'single', intent: GAME_INTENTS.ACTION, confirm, switchToTwoCall,
        });

        expect(proceed).toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
        expect(switchToTwoCall).not.toHaveBeenCalled();
    });

    it('already two-call proceeds with no prompt', async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        const switchToTwoCall = vi.fn().mockResolvedValue(undefined);

        const proceed = await runStatsTwoCallGate({
            hasStatsYaml: true, engineMode: 'two-call', intent: GAME_INTENTS.ACTION, confirm, switchToTwoCall,
        });

        expect(proceed).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(switchToTwoCall).not.toHaveBeenCalled();
    });

    it('non-stats Book proceeds with no prompt (opt-in off)', async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        const switchToTwoCall = vi.fn().mockResolvedValue(undefined);

        const proceed = await runStatsTwoCallGate({
            hasStatsYaml: false, engineMode: 'single', intent: GAME_INTENTS.ACTION, confirm, switchToTwoCall,
        });

        expect(proceed).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(switchToTwoCall).not.toHaveBeenCalled();
    });
});
