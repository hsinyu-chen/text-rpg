import { describe, expect, it } from 'vitest';
import { getResolverSchema } from './engine-protocol-two-call';

interface ResolverSchema {
    properties: {
        analysis: {
            properties: {
                steps: {
                    items: {
                        properties: Record<string, { type?: string; items?: unknown }>;
                    };
                };
            };
        };
    };
}

function stepProps(schema: unknown) {
    return (schema as ResolverSchema).properties.analysis.properties.steps.items.properties;
}

describe('getResolverSchema stat_changes threading', () => {
    it('omits stat_changes when no options are passed (opt-in off)', () => {
        expect(stepProps(getResolverSchema('English'))).not.toHaveProperty('stat_changes');
    });

    it('omits stat_changes when enableStats is false', () => {
        expect(stepProps(getResolverSchema('English', { enableStats: false }))).not.toHaveProperty('stat_changes');
    });

    it('injects stat_changes into the resolver step schema when enableStats is true', () => {
        const props = stepProps(getResolverSchema('English', { enableStats: true }));
        expect(props).toHaveProperty('stat_changes');
        expect(props['stat_changes'].type).toBe('array');
    });
});
