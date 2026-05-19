import { describe, expect, it } from 'vitest';
import { LogBasedSceneEventProvider } from './log-based-scene-event.provider';
import type { SceneEventProvider } from './scene-event-provider.interface';
import type { ChatMessage } from '@app/core/models/types';

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'model',
    content: '',
    summary: `summary-${id.slice(0, 4)}`,
    ...over,
  };
}

describe('LogBasedSceneEventProvider.listEvents', () => {
  const provider: SceneEventProvider = new LogBasedSceneEventProvider();

  it('returns [] for empty input', async () => {
    expect(await provider.listEvents([], { saveContextMode: 'full', smartContextTurns: 10 })).toEqual([]);
  });

  it('drops user messages and messages with no narrative payload', async () => {
    const msgs: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'do thing', summary: '' },
      msg('m1'),
      { id: 'mEmpty', role: 'model', content: '', summary: '' },
    ];
    const events = await provider.listEvents(msgs, { saveContextMode: 'full', smartContextTurns: 10 });
    expect(events.map(e => e.messageId)).toEqual(['m1']);
  });

  it('full mode returns events from every model message', async () => {
    const msgs: ChatMessage[] = Array.from({ length: 5 }, (_, i) => msg(`m${i}`));
    const events = await provider.listEvents(msgs, { saveContextMode: 'full', smartContextTurns: 10 });
    expect(events).toHaveLength(5);
  });

  it('summarized mode caps to last 2 raw messages', async () => {
    const msgs: ChatMessage[] = Array.from({ length: 5 }, (_, i) => msg(`m${i}`));
    const events = await provider.listEvents(msgs, { saveContextMode: 'summarized', smartContextTurns: 10 });
    expect(events.map(e => e.messageId)).toEqual(['m3', 'm4']);
  });

  it('smart mode caps to last smartContextTurns * 2 raw messages', async () => {
    const msgs: ChatMessage[] = Array.from({ length: 10 }, (_, i) => msg(`m${i}`));
    const events = await provider.listEvents(msgs, { saveContextMode: 'smart', smartContextTurns: 3 });
    // 3 * 2 = 6 — last six messages, m4..m9
    expect(events.map(e => e.messageId)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
  });

  it('drops isRefOnly messages from the slice (parity with context-builder default filter)', async () => {
    const msgs: ChatMessage[] = [
      msg('m1'),
      msg('m2', { isRefOnly: true }),
      msg('m3'),
    ];
    const events = await provider.listEvents(msgs, { saveContextMode: 'full', smartContextTurns: 10 });
    expect(events.map(e => e.messageId)).toEqual(['m1', 'm3']);
  });

  it('keeps isRefOnly messages that carry a functionResponse part (tool result)', async () => {
    const msgs: ChatMessage[] = [
      msg('m1'),
      msg('m2', {
        isRefOnly: true,
        parts: [{ functionResponse: { name: 'doStuff', response: { ok: true } } }],
      }),
    ];
    const events = await provider.listEvents(msgs, { saveContextMode: 'full', smartContextTurns: 10 });
    expect(events.map(e => e.messageId)).toEqual(['m1', 'm2']);
  });

  it('window cap respects the post-filter sequence (refOnly are excluded before counting)', async () => {
    // 4 model + 2 ref-only-without-tool = 6 raw; default filter drops the 2 ref-only → 4 visible
    const msgs: ChatMessage[] = [
      msg('m1'),
      msg('skip1', { isRefOnly: true }),
      msg('m2'),
      msg('skip2', { isRefOnly: true }),
      msg('m3'),
      msg('m4'),
    ];
    const events = await provider.listEvents(msgs, { saveContextMode: 'summarized', smartContextTurns: 10 });
    expect(events.map(e => e.messageId)).toEqual(['m3', 'm4']);
  });
});
