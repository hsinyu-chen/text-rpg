import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeService } from './knowledge.service';
import { LOCALES } from '../constants/locales';

describe('KnowledgeService — KB exclusions', () => {
    let kb: KnowledgeService;

    beforeEach(() => {
        kb = new KnowledgeService();
    });

    const STATS_YAML_NAMES = Object.values(LOCALES).map(l => l.optionalFilenames.STATS_YAML);

    function filesWithStatsYaml(): Map<string, string> {
        const files = new Map<string, string>();
        files.set('1.Base_Settings.md', 'WORLD LORE');
        for (const name of STATS_YAML_NAMES) {
            files.set(name, 'stats:\n  hp:\n    value: 100\n');
        }
        return files;
    }

    it('excludes the stats YAML from buildKnowledgeBaseText but keeps normal KB files', () => {
        const text = kb.buildKnowledgeBaseText(filesWithStatsYaml());
        expect(text).toContain('WORLD LORE');
        expect(text).toContain('1.Base_Settings.md');
        for (const name of STATS_YAML_NAMES) {
            expect(text).not.toContain(name);
        }
        expect(text).not.toContain('value: 100');
    });

    it('excludes the stats YAML from buildKnowledgeBaseParts as well (shared filter)', () => {
        const parts = kb.buildKnowledgeBaseParts(filesWithStatsYaml());
        const joined = parts.map(p => p.text ?? '').join('\n');
        expect(joined).toContain('WORLD LORE');
        for (const name of STATS_YAML_NAMES) {
            expect(joined).not.toContain(name);
        }
    });

    it('still drops system_files/ and system_prompt.md (existing exclusions preserved)', () => {
        const files = new Map<string, string>([
            ['1.Base_Settings.md', 'KEEP ME'],
            ['system_prompt.md', 'SYSTEM PROMPT'],
            ['system_files/x.md', 'INTERNAL'],
        ]);
        const text = kb.buildKnowledgeBaseText(files);
        expect(text).toContain('KEEP ME');
        expect(text).not.toContain('SYSTEM PROMPT');
        expect(text).not.toContain('INTERNAL');
    });
});
