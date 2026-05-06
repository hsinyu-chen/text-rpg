import { describe, expect, it } from 'vitest';
import { extractActName } from './act-name.util';
import { ChatMessage } from '../models/types';

const m = (role: 'user' | 'model', content: string): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  parts: [{ text: content }],
});

describe('extractActName', () => {
  it('returns null for empty messages', () => {
    expect(extractActName([])).toBeNull();
  });

  it('returns null when no model message contains an act marker', () => {
    expect(extractActName([m('user', '## Act.5'), m('model', 'just narration')])).toBeNull();
  });

  it('matches `## Act.N` in a model message', () => {
    expect(extractActName([m('model', 'intro\n\n## Act.3\n\nbody')])).toBe('Act.3 ');
  });

  it('matches `第N章` (Traditional Chinese) in a model message', () => {
    expect(extractActName([m('model', '第 7 章\n\n內文')])).toBe('第7 章');
  });

  it('walks backward — picks the latest matching message', () => {
    const messages = [
      m('model', '## Act.1'),
      m('model', '## Act.2'),
      m('user', '## Act.99'), // user messages ignored
      m('model', '## Act.5'),
    ];
    expect(extractActName(messages)).toBe('Act.5 ');
  });

  it('prefers Act marker over zh marker when both appear in the same message', () => {
    expect(extractActName([m('model', '## Act.2 / 第3章')])).toBe('Act.2 ');
  });

  it('skips model messages with empty content', () => {
    expect(extractActName([m('model', '## Act.1'), m('model', '')])).toBe('Act.1 ');
  });

  it('case-insensitive on the Act keyword', () => {
    expect(extractActName([m('model', '## ACT.4')])).toBe('Act.4 ');
  });
});
