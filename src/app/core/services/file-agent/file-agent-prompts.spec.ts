import { describe, expect, it } from 'vitest';
import { buildSystemInstruction } from './file-agent-prompts';
import { EN_US_LOCALE } from '@app/core/constants/locales/en';
import { ZH_TW_LOCALE } from '@app/core/constants/locales/zh-tw';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';

const FAKE_I18N: Record<string, string> = {
  'ui.EDIT_RESEND_TOOLTIP': 'Edit & Resend',
  'ui.EDIT_TEXT': 'Edit Text',
  'ui.MARK_AS_REF_ONLY': 'Mark as Ref Only',
  'ui.INCLUDE_IN_STORY': 'Include in Story',
  'ui.FORK_FROM_HERE_TOOLTIP': 'Fork from here',
  'ui.DELETE_ALL_FOLLOWING': 'Delete This and All Following',
  'ui.DELETE_MESSAGE': 'Delete Message',
  'ui.AUTO_UPDATE_FILES': 'Auto Update Files',
  'sidebar.controls.startNewGame': 'Start New Game',
  'sidebar.controls.createNext': 'Create Next',
  'sidebar.controls.createScene': 'Create Scene',
  'sidebar.newGame.tabPrebuildLabel': 'Pre-build',
  'sidebar.newGame.tabGenerateLabel': 'Generate'
};

const i18n = (key: string): string => FAKE_I18N[key] ?? `[[${key}]]`;

function build(opts: {
  mode?: 'native' | 'json';
  parallel?: boolean;
  readOnly?: boolean;
  uiLanguage?: string;
  narrativeLanguage?: string;
  locale?: AppLocale;
} = {}): string {
  return buildSystemInstruction(
    '- 1.md\n- 2.md',
    opts.mode ?? 'native',
    opts.parallel ?? false,
    {
      uiLanguage: opts.uiLanguage,
      narrativeLanguage: opts.narrativeLanguage,
    },
    opts.locale ?? EN_US_LOCALE,
    i18n
  );
}

describe('buildSystemInstruction', () => {
  describe('header & role', () => {
    it('declares the three file-agent capabilities', () => {
      const out = build();
      expect(out).toMatch(/Edit KB files/);
      expect(out).toMatch(/Q&A \/ consultation/);
      expect(out).toMatch(/Guide UI features/);
    });

    it('embeds the supplied file list', () => {
      const out = build();
      expect(out).toContain('- 1.md\n- 2.md');
    });
  });

  describe('locale interpolation — coreFilenames', () => {
    it('uses English chapter filenames when locale is en-US', () => {
      const out = build({ locale: EN_US_LOCALE });
      for (const name of Object.values(EN_US_LOCALE.coreFilenames)) {
        expect(out).toContain(name);
      }
    });

    it('uses Traditional Chinese chapter filenames when locale is zh-tw', () => {
      const out = build({ locale: ZH_TW_LOCALE });
      expect(out).toContain(ZH_TW_LOCALE.coreFilenames.BASIC_SETTINGS);
      expect(out).toContain(ZH_TW_LOCALE.coreFilenames.STORY_OUTLINE);
      expect(out).toContain(ZH_TW_LOCALE.coreFilenames.INVENTORY);
      // English chapter names should NOT leak into a zh-tw build.
      expect(out).not.toContain(EN_US_LOCALE.coreFilenames.BASIC_SETTINGS);
    });
  });

  describe('locale interpolation — intentTags', () => {
    it('lists English intent tags when locale is en-US', () => {
      const out = build({ locale: EN_US_LOCALE });
      expect(out).toContain(EN_US_LOCALE.intentTags.SAVE);
      expect(out).toContain(EN_US_LOCALE.intentTags.ACTION);
      expect(out).toContain(EN_US_LOCALE.intentTags.SYSTEM);
    });

    it('lists zh-tw intent tags when locale is zh-tw', () => {
      const out = build({ locale: ZH_TW_LOCALE });
      expect(out).toContain(ZH_TW_LOCALE.intentTags.SAVE);
      expect(out).toContain(ZH_TW_LOCALE.intentTags.ACTION);
    });
  });

  describe('i18n interpolation', () => {
    it('resolves per-message toolbar i18n keys', () => {
      const out = build();
      expect(out).toContain('Edit & Resend');
      expect(out).toContain('Fork from here');
      expect(out).toContain('Delete This and All Following');
    });

    it('resolves sidebar entry-point i18n keys', () => {
      const out = build();
      expect(out).toContain('Start New Game');
      expect(out).toContain('Create Next');
      expect(out).toContain('Create Scene');
      expect(out).toContain('Pre-build');
      expect(out).toContain('Generate');
    });
  });

  describe('link schemes block', () => {
    it('teaches the app://message/<id>/<action> sub-action syntax', () => {
      const out = build();
      expect(out).toContain('app://message/<id>/<action>');
      // A few representative action names from the per-message toolbar so
      // a typo / rename in the prompt list gets flagged.
      expect(out).toContain('auto-update');
      expect(out).toContain('fork');
    });

    it('teaches the app://book/<id>[/<action>] syntax with the per-row action vocabulary', () => {
      const out = build();
      expect(out).toContain('app://book/<id>');
      expect(out).toContain('app://book/<id>/<action>');
      // Action names ground the link to actual book-list DOM attributes;
      // a rename without updating the prompt would break the agent's vocabulary.
      expect(out).toContain('move-book');
      expect(out).toContain('rename-book');
      expect(out).toContain('delete-book');
      expect(out).toContain('active-cache-badge');
    });

    it('teaches the app://collection/<id>[/<action>] syntax with the per-row action vocabulary', () => {
      const out = build();
      expect(out).toContain('app://collection/<id>');
      expect(out).toContain('app://collection/<id>/<action>');
      expect(out).toContain('add-book');
      expect(out).toContain('rename-collection');
      expect(out).toContain('delete-collection');
    });

    it('lays down a HARD RULE forbidding bare book/collection GUIDs', () => {
      const out = build();
      // Same shape as the existing message-id hard rule so the agent treats
      // book/collection ids with the same strictness.
      expect(out).toMatch(/HARD RULE:.*book.*collection.*bare GUID/);
    });
  });

  describe('surface-mode block (mode-tag protocol)', () => {
    // The block is static — both [mode: editor] and [mode: readonly] are
    // described in every system prompt, with the marker on the user message
    // selecting which applies on a given turn. Decoupling readOnly from the
    // system prompt is what keeps the LLM KV cache stable across panel toggles.
    it('describes both modes regardless of readOnly', () => {
      const ro = build({ readOnly: true });
      const rw = build({ readOnly: false });
      for (const out of [ro, rw]) {
        expect(out).toContain('EDITING SURFACE — TWO MODES');
        expect(out).toContain('[mode: editor]');
        expect(out).toContain('[mode: readonly]');
        expect(out).toContain('app://file/');
      }
    });

    it('keeps the system prompt byte-identical between readOnly modes', () => {
      // KV-cache stability invariant: the readOnly flag must NOT branch the
      // system instruction. If this breaks, the mode marker on user messages
      // is the right knob — not a system-prompt fork.
      expect(build({ readOnly: true })).toBe(build({ readOnly: false }));
    });
  });

  describe('tool-call mode block', () => {
    it('says "PARALLEL ALLOWED" in native+parallel mode', () => {
      const out = build({ mode: 'native', parallel: true });
      expect(out).toContain('PARALLEL ALLOWED');
    });

    it('says "SINGLE" in native+non-parallel mode', () => {
      const out = build({ mode: 'native', parallel: false });
      expect(out).toContain('NATIVE, SINGLE');
      expect(out).not.toContain('PARALLEL ALLOWED');
    });

    it('produces the JSON-mode block when mode=json', () => {
      const out = build({ mode: 'json' });
      expect(out).toContain('TOOL-CALL MODE — JSON');
      expect(out).toContain('valid JSON');
      expect(out).toContain('"reason"');
    });

    it('lists listBooks / listCollections in the JSON-mode action enum', () => {
      const out = build({ mode: 'json' });
      expect(out).toContain('action: "listBooks"');
      expect(out).toContain('action: "listCollections"');
    });
  });

  describe('language block', () => {
    it('embeds an explicit narrativeLanguage', () => {
      const out = build({ uiLanguage: 'en-US', narrativeLanguage: 'zh-TW' });
      expect(out).toContain('UI language**: `en-US`');
      expect(out).toContain('Narrative language**: `zh-TW`');
    });

    it('falls back to placeholder text when narrativeLanguage is "default"', () => {
      const out = build({ narrativeLanguage: 'default' });
      expect(out).toMatch(/Narrative language\*\*: `\(unspecified/);
    });
  });

  describe('always-on blocks', () => {
    it('includes workflowRules Rule 7 about best-effort search', () => {
      const out = build();
      expect(out).toContain('Rule 7');
      expect(out).toContain('BEST-EFFORT SEARCH BEFORE GIVING UP');
    });

    it('includes workflowRules Rule 8 about chat=ground-truth', () => {
      const out = build();
      expect(out).toContain('Rule 8');
      expect(out).toContain('VERIFY THE STORY BEFORE FIXING THE FILES');
    });

    it('includes workflowRules Rule 9 fail-safe (say-you-don\'t-know)', () => {
      const out = build();
      expect(out).toContain('Rule 9');
      expect(out).toContain("DON'T KNOW, SAY SO");
      expect(out).toMatch(/do NOT invent.*menu paths|fabricat/i);
    });

    it('lists deeper-reference topics', () => {
      const out = build();
      expect(out).toContain('story-prebuilt-events');
      expect(out).toContain('prompt-profiles');
      expect(out).toContain('ui-features');
    });

    it('declares the cannot-do list', () => {
      const out = build();
      expect(out).toContain('WHAT YOU CANNOT DO');
      expect(out).toContain('Edit chat messages');
    });

    it('routes KB-behind-chat questions to Auto Update first, direct edit last', () => {
      const out = build();
      expect(out).toContain('When the user asks about a KB-sync gap');
      expect(out).toMatch(/Trigger.*user.*raised/i);
      expect(out).toContain('Auto Update Files');
      expect(out).toMatch(/Re-run Auto Update/i);
      expect(out).toMatch(/last resort/i);
    });

    it('teaches reach-back constraints on Edit & Resend and <System>', () => {
      const out = build();
      expect(out).toContain('Reach-back map');
      // Edit & Resend constraint
      expect(out).toMatch(/Edit & Resend.*latest.*user msg/i);
      expect(out).toMatch(/cannot reach historic turns/i);
      // <System> constraint
      expect(out).toMatch(/only steers the \*\*next\*\* response/);
      expect(out).toMatch(/CANNOT retroactively rewrite/);
    });

    it('correctly frames Edit text as persisted retcon, not cosmetic', () => {
      const out = build();
      expect(out).toMatch(/NOT cosmetic/);
      expect(out).toMatch(/feeds into every future LLM turn as canonical history/);
      expect(out).toMatch(/retcon historic dialogue/);
    });

    it('teaches the three valid paths for modifying historic turns', () => {
      const out = build();
      expect(out).toContain('Modifying historic turns');
      expect(out).toMatch(/Manual edit/);
      expect(out).toMatch(/Rewind and replay/);
      expect(out).toMatch(/Narrative progression/);
      // Present all three simultaneously, don't preselect
      expect(out).toMatch(/Present all three simultaneously/);
      expect(out).toMatch(/do NOT preselect one/);
    });

    it('requires investigation + concrete proposed content for Path 1', () => {
      const out = build();
      // Investigation step before suggesting
      expect(out).toMatch(/Step 0.*investigate before suggesting/i);
      expect(out).toMatch(/searchChatMessages.*readChatMessage/);
      expect(out).toMatch(/Verify the gap is real/);
      expect(out).toMatch(/readSection/);
      // Concrete content required for Path 1
      expect(out).toMatch(/Always include a concrete suggested insertion/);
    });
  });
});
