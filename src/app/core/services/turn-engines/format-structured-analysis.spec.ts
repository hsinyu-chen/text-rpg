import { describe, expect, it } from 'vitest';
import { assembleStoryWithSceneHeader, buildSceneHeaderLine, formatResolverIntent, formatStructuredAnalysis } from './format-structured-analysis';
import { AnalysisStep, SceneSnapshot, StructuredAnalysis } from '@app/core/constants/engine-protocol-structured';

function step(overrides: Partial<AnalysisStep> = {}): AnalysisStep {
    return {
        kind: 'user_intent',
        action: 'walk',
        pc_dialogue: '',
        mood: '',
        risk_factors: [],
        outcome: '成功',
        breaks_ideal: false,
        npc_reactions: [],
        object_reactions: [],
        ...overrides
    };
}

function snap(overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
    return {
        date_in_world: '',
        time_hhmm: '12:00',
        location: '',
        environment: '',
        pc_in_header: '',
        present_npcs: [],
        key_objects: [],
        ...overrides
    };
}

function analysis(overrides: Partial<StructuredAnalysis> = {}): StructuredAnalysis {
    return {
        scene_snapshot: snap(),
        steps: [],
        ...overrides
    };
}

describe('formatStructuredAnalysis', () => {
    it('returns empty string for null/undefined', () => {
        expect(formatStructuredAnalysis(null)).toBe('');
        expect(formatStructuredAnalysis(undefined)).toBe('');
    });

    it('renders empty string when input has no observable content', () => {
        expect(formatStructuredAnalysis({})).toBe('');
    });

    it('renders the scene snapshot with each segment on its own line', () => {
        const out = formatStructuredAnalysis(analysis({
            scene_snapshot: snap({
                date_in_world: '聖曆 1000年04月02日 週二',
                time_hhmm: '18:40',
                location: '旅店一樓',
                environment: '暴雨中',
                pc_in_header: '程楊宗(平靜)',
                present_npcs: [{ name: '鮑伯', state: '昏迷' }, { name: '德茲爾', state: '通訊' }],
                key_objects: [{ name: '窗戶', state: '半開' }]
            })
        }));
        expect(out).toContain('[現況]');
        expect(out).toContain('時間: 聖曆 1000年04月02日 週二 18:40');
        expect(out).toContain('地點: 旅店一樓');
        expect(out).toContain('主角: 程楊宗(平靜)');
        expect(out).toContain('鮑伯(昏迷)');
        expect(out).toContain('德茲爾(通訊)');
        expect(out).toContain('暴雨中');
        expect(out).toContain('窗戶(半開)');
    });

    it('marks the first broken step with 🔴 and tags later steps as truncated', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [
                step({ action: 'walk' }),
                step({ action: 'reach', breaks_ideal: true, outcome: '失敗 - NPC 拒絕' }),
                step({ action: 'shake' })
            ]
        }));
        expect(out).toContain('[動作1]** ✅ walk');
        expect(out).toContain('[動作2]** 🔴 reach');
        expect(out).toContain('NPC 拒絕');
        expect(out).toContain('[動作3]** ⏸ shake');
        expect(out).toContain('truncated after first break');
    });

    describe('buildSceneHeaderLine', () => {
        it('returns empty string when minimum fields are missing', () => {
            expect(buildSceneHeaderLine(snap())).toBe('');
            expect(buildSceneHeaderLine(snap({ date_in_world: 'X', time_hhmm: '12:00' }))).toBe(''); // location missing
        });

        it('builds the bracketed line with PC + present NPCs joined by commas', () => {
            const line = buildSceneHeaderLine(snap({
                date_in_world: '聖曆 1000年04月02日 週二',
                time_hhmm: '18:40',
                location: '旅店一樓',
                pc_in_header: '程楊宗',
                present_npcs: [{ name: '鮑伯', state: '昏迷' }, { name: '德茲爾', state: '通訊' }]
            }));
            expect(line).toBe('[聖曆 1000年04月02日 週二 18:40 / 旅店一樓 / 程楊宗, 鮑伯(昏迷), 德茲爾(通訊)]');
        });

        it('omits the comma when no NPCs are present', () => {
            const line = buildSceneHeaderLine(snap({
                date_in_world: 'D',
                time_hhmm: '00:00',
                location: 'L',
                pc_in_header: 'P'
            }));
            expect(line).toBe('[D 00:00 / L / P]');
        });
    });

    describe('formatResolverIntent', () => {
        it('renders both fields when supplied', () => {
            const out = formatResolverIntent('主角想潛行到櫃檯後製造驚喜', 'pragmatic');
            expect(out).toContain('**[意圖判讀]**');
            expect(out).toContain('- 目標: 主角想潛行到櫃檯後製造驚喜');
            expect(out).toContain('- 強度: pragmatic');
        });

        it('renders only the present field', () => {
            expect(formatResolverIntent('reach plaza', '')).toContain('- 目標: reach plaza');
            expect(formatResolverIntent('reach plaza', '')).not.toContain('- 強度');
        });

        it('returns empty string when both are unset', () => {
            expect(formatResolverIntent('', '')).toBe('');
            expect(formatResolverIntent(null, undefined)).toBe('');
        });
    });

    describe('assembleStoryWithSceneHeader', () => {
        const fullSnap: SceneSnapshot = snap({
            date_in_world: '聖曆 1000年04月02日 週二',
            time_hhmm: '18:40',
            location: '旅店一樓',
            pc_in_header: '程楊宗',
            present_npcs: []
        });

        it('prepends the bracket line in front of the story (LLM keeps emitting CFC + body)', () => {
            const raw = '<CREATIVE FICTION CONTEXT>\n艾爾走進旅店。';
            const out = assembleStoryWithSceneHeader(raw, fullSnap);
            expect(out.startsWith('[聖曆 1000年04月02日 週二 18:40 / 旅店一樓 / 程楊宗]\n\n')).toBe(true);
            expect(out).toContain('<CREATIVE FICTION CONTEXT>');
            expect(out).toContain('艾爾走進旅店');
        });

        it('strips an LLM-emitted bracket line still living after the CFC marker (legacy habit)', () => {
            const raw = '<CREATIVE FICTION CONTEXT>\n[wrong header LLM put here]\n\n艾爾走進旅店。';
            const out = assembleStoryWithSceneHeader(raw, fullSnap);
            expect(out).not.toContain('wrong header LLM put here');
            expect(out).toContain('[聖曆 1000年04月02日 週二 18:40 / 旅店一樓 / 程楊宗]');
            expect(out).toContain('<CREATIVE FICTION CONTEXT>');
        });

        it('returns raw story unchanged when snapshot is too partial', () => {
            const raw = '<CREATIVE FICTION CONTEXT>\nbody';
            expect(assembleStoryWithSceneHeader(raw, snap())).toBe(raw);
        });
    });

    it('renders verbatim NPC dialogue (the rule that was failing in the old schema)', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [step({
                action: 'greet',
                npc_reactions: [{
                    actor: '梨菲',
                    physical: '側身閃過',
                    dialogue: '就這點本事？',
                    motivation: '戰鬥本能+敵意'
                }]
            })]
        }));
        expect(out).toContain('梨菲');
        expect(out).toContain('側身閃過');
        expect(out).toContain('「就這點本事？」');
        expect(out).toContain('（戰鬥本能+敵意）');
    });

    it('renders object reactions including the "無變化" reserved literal', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [step({
                object_reactions: [
                    { name: '窗戶', change: '無變化' },
                    { name: '碎玻璃', change: '碎片微微滑動' }
                ]
            })]
        }));
        expect(out).toContain('窗戶: 無變化');
        expect(out).toContain('碎玻璃: 碎片微微滑動');
    });

    it('renders pc_dialogue and mood when present', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [step({ action: 'greet', pc_dialogue: '你好', mood: '友善' })]
        }));
        expect(out).toContain('"你好"');
        expect(out).toContain('_(友善)_');
    });

    it('renders risk factors as inline list', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [step({ risk_factors: ['梨菲反擊', '大雨影響'] })]
        }));
        expect(out).toContain('風險:');
        expect(out).toContain('梨菲反擊; 大雨影響');
    });

    it('renders random_event steps with the [事件N] header instead of [動作N]', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [
                step({ kind: 'user_intent', action: 'walk to plaza' }),
                step({ kind: 'random_event', action: '雷劈附近樹木', outcome: '失敗 - 主角被氣浪震退', breaks_ideal: true })
            ]
        }));
        expect(out).toContain('[動作1]** ✅ walk to plaza');
        expect(out).toContain('[事件2]** 🔴 雷劈附近樹木');
        expect(out).toContain('主角被氣浪震退');
    });

    it('strips model-emitted CJK / ASCII quote wrappers so analysis panel does not show 「「...」」', () => {
        const out = formatStructuredAnalysis(analysis({
            steps: [step({
                npc_reactions: [
                    { actor: '梨菲', physical: '揚眉', dialogue: '「別過來」', motivation: '' },
                    { actor: '艾爾', physical: '低頭', dialogue: '"go away"', motivation: '' }
                ]
            })]
        }));
        expect(out).toContain('「別過來」');
        expect(out).not.toContain('「「');
        expect(out).toContain('「go away」');
        expect(out).not.toContain('"go away"');
    });

    it('strips trailing periods on environment', () => {
        const out = formatStructuredAnalysis(analysis({
            scene_snapshot: snap({
                environment: '室內安靜。',
                present_npcs: [{ name: '梨菲', state: '' }]
            })
        }));
        expect(out).toContain('環境: 室內安靜');
        expect(out).not.toContain('安靜。');
    });

    it('handles streaming partial input (snapshot only, no steps yet)', () => {
        const out = formatStructuredAnalysis({
            scene_snapshot: snap({
                time_hhmm: '',
                environment: '室內安靜'
            })
        });
        expect(out).toContain('[現況]');
        expect(out).toContain('室內安靜');
    });
});
