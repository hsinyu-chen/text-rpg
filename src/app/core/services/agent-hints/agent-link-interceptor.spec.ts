import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { I18nService } from '@app/core/i18n';
import { GameStateService } from '@app/core/services/game-state.service';
import { FILE_VIEWER_OPENER } from '@app/core/services/dev/file-viewer-opener.token';
import { AgentLinkInterceptor } from './agent-link-interceptor.service';
import { AgentHintRegistry } from './agent-hints.registry';
import { AgentMessageJumperService } from './agent-message-jumper.service';

function makeI18nStub(): Partial<I18nService> {
  return {
    translate: vi.fn((key: string, params?: Record<string, string | number>): string => {
      if (!params) return key;
      let out = key;
      for (const [k, v] of Object.entries(params)) {
        out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v));
      }
      return out;
    }),
  };
}

function setup(options: {
  loadedFiles?: Map<string, string>;
  messages?: { id: string }[];
  buttonHtml?: string;
} = {}) {
  const { loadedFiles = new Map<string, string>(), messages = [], buttonHtml = '' } = options;
  const snackBar = { open: vi.fn() };
  const fileViewerOpener = { isOpen: () => false, open: vi.fn(() => ({ alreadyOpen: false })) };
  const stateStub = {
    loadedFiles: signal(loadedFiles).asReadonly(),
    messages: signal(messages).asReadonly(),
  };
  const registry = {
    openTarget: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: MatSnackBar, useValue: snackBar },
      { provide: I18nService, useValue: makeI18nStub() },
      { provide: GameStateService, useValue: stateStub },
      { provide: FILE_VIEWER_OPENER, useValue: fileViewerOpener },
      { provide: AgentHintRegistry, useValue: registry },
    ],
  });
  const interceptor = TestBed.inject(AgentLinkInterceptor);
  const jumper = TestBed.inject(AgentMessageJumperService);
  // Mount any test buttons under doc.body so the interceptor's
  // CSS-selector walk can find them. Caller passes raw HTML containing
  // `[id^="message-"]` wrappers with their `data-msg-action` children.
  const doc = TestBed.inject(DOCUMENT);
  const fixture = doc.createElement('div');
  fixture.id = 'agent-link-interceptor-fixture';
  fixture.innerHTML = buttonHtml;
  doc.body.appendChild(fixture);
  return {
    interceptor, registry, snackBar, fileViewerOpener, jumper, stateStub,
    cleanup: () => fixture.remove(),
  };
}

describe('AgentLinkInterceptor.dispatch', () => {
  it('returns false for non-app URLs (browser handles them)', () => {
    const { interceptor } = setup();
    expect(interceptor.dispatch('https://example.com')).toBe(false);
    expect(interceptor.dispatch('mailto:foo@bar.com')).toBe(false);
    expect(interceptor.dispatch('app')).toBe(false);
  });

  it('dispatches app://hint/<path> to registry.openTarget with default highlight action', () => {
    const { interceptor, registry } = setup();
    expect(interceptor.dispatch('app://hint/chat-input/send')).toBe(true);
    expect(registry.openTarget).toHaveBeenCalledWith('chat-input/send', 'highlight');
  });

  it('parses ?do=activate query param', () => {
    const { interceptor, registry } = setup();
    interceptor.dispatch('app://hint/chat-input/chat-config?do=activate');
    expect(registry.openTarget).toHaveBeenCalledWith('chat-input/chat-config', 'activate');
  });

  it('parses ?do=focus query param', () => {
    const { interceptor, registry } = setup();
    interceptor.dispatch('app://hint/chat-input/send?do=focus');
    expect(registry.openTarget).toHaveBeenCalledWith('chat-input/send', 'focus');
  });

  it('ignores unknown do= values and falls back to highlight', () => {
    const { interceptor, registry } = setup();
    interceptor.dispatch('app://hint/chat-input/send?do=eat');
    expect(registry.openTarget).toHaveBeenCalledWith('chat-input/send', 'highlight');
  });

  it('handles nested hint paths (multi-segment)', () => {
    const { interceptor, registry } = setup();
    interceptor.dispatch('app://hint/chat-input/chat-config/profile-clone?do=activate');
    expect(registry.openTarget).toHaveBeenCalledWith('chat-input/chat-config/profile-clone', 'activate');
  });

  it('dispatches app://message/<id> via AgentMessageJumperService (action null)', () => {
    const { interceptor, jumper } = setup();
    interceptor.dispatch('app://message/abc-123');
    expect(jumper.request()).toMatchObject({ id: 'abc-123', action: null });
  });

  it('decodes percent-encoded message ids', () => {
    const { interceptor, jumper } = setup();
    interceptor.dispatch('app://message/abc%20with%20space');
    expect(jumper.request()).toMatchObject({ id: 'abc with space', action: null });
  });

  it('parses app://message/<id>/<action> sub-action segment', () => {
    const { interceptor, jumper } = setup();
    interceptor.dispatch('app://message/abc-123/auto-update');
    expect(jumper.request()).toMatchObject({ id: 'abc-123', action: 'auto-update' });
  });

  it('decodes percent-encoded action segments independently', () => {
    const { interceptor, jumper } = setup();
    interceptor.dispatch('app://message/abc%20id/delete%2Dfollowing');
    expect(jumper.request()).toMatchObject({ id: 'abc id', action: 'delete-following' });
  });

  it('toasts on a message URL with more than 2 tail segments', () => {
    const { interceptor, snackBar } = setup();
    expect(interceptor.dispatch('app://message/abc-123/foo/bar')).toBe(true);
    expect(snackBar.open).toHaveBeenCalled();
  });

  it('toasts and returns true on message URL with no id (treat as claimed but invalid)', () => {
    const { interceptor, snackBar } = setup();
    expect(interceptor.dispatch('app://message/')).toBe(true);
    expect(snackBar.open).toHaveBeenCalled();
  });

  it('opens the file-viewer for app://file/<filename>', () => {
    const { interceptor, fileViewerOpener } = setup({ loadedFiles: new Map([['Inventory.md', '# items']]) });
    interceptor.dispatch('app://file/Inventory.md');
    expect(fileViewerOpener.open).toHaveBeenCalledWith(
      expect.objectContaining({ initialFile: 'Inventory.md', files: expect.any(Map) })
    );
  });

  it('toasts when the file scheme references a missing KB file', () => {
    const { interceptor, snackBar, fileViewerOpener } = setup({ loadedFiles: new Map() });
    interceptor.dispatch('app://file/Missing.md');
    expect(fileViewerOpener.open).not.toHaveBeenCalled();
    expect(snackBar.open).toHaveBeenCalled();
  });

  it('toasts on an unknown scheme', () => {
    const { interceptor, snackBar } = setup();
    expect(interceptor.dispatch('app://wat/foo')).toBe(true);
    expect(snackBar.open).toHaveBeenCalled();
  });

  it('toasts on a malformed URL (too few segments)', () => {
    const { interceptor, snackBar } = setup();
    expect(interceptor.dispatch('app://hint')).toBe(true);
    expect(snackBar.open).toHaveBeenCalled();
  });

  describe('app://hint/chat-message/* fallback (no message id)', () => {
    it('routes app://hint/chat-message to last message flash (no action)', () => {
      const ctx = setup({ messages: [{ id: 'm1' }, { id: 'm2' }] });
      ctx.interceptor.dispatch('app://hint/chat-message');
      expect(ctx.jumper.request()).toMatchObject({ id: 'm2', action: null });
      expect(ctx.registry.openTarget).not.toHaveBeenCalled();
      ctx.cleanup();
    });

    it('maps chat-message/auto-update-files to the last message bearing auto-update', () => {
      const ctx = setup({
        messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        buttonHtml: `
          <div id="message-a"><button data-msg-action="auto-update"></button></div>
          <div id="message-b"></div>
          <div id="message-c"><button data-msg-action="auto-update"></button></div>
        `,
      });
      ctx.interceptor.dispatch('app://hint/chat-message/auto-update-files');
      expect(ctx.jumper.request()).toMatchObject({ id: 'c', action: 'auto-update' });
      ctx.cleanup();
    });

    it('walks back past a message without the button when newer messages lack it', () => {
      const ctx = setup({
        messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        buttonHtml: `
          <div id="message-a"><button data-msg-action="auto-update"></button></div>
          <div id="message-b"></div>
          <div id="message-c"></div>
        `,
      });
      ctx.interceptor.dispatch('app://hint/chat-message/auto-update-files');
      expect(ctx.jumper.request()).toMatchObject({ id: 'a', action: 'auto-update' });
      ctx.cleanup();
    });

    it('maps fork-from-here to the data-msg-action name `fork`', () => {
      const ctx = setup({
        messages: [{ id: 'x' }],
        buttonHtml: `<div id="message-x"><button data-msg-action="fork"></button></div>`,
      });
      ctx.interceptor.dispatch('app://hint/chat-message/fork-from-here');
      expect(ctx.jumper.request()).toMatchObject({ id: 'x', action: 'fork' });
      ctx.cleanup();
    });

    it('accepts either toggle-ref-only DOM name', () => {
      const ctx = setup({
        messages: [{ id: 'x' }],
        buttonHtml: `<div id="message-x"><button data-msg-action="include-in-story"></button></div>`,
      });
      ctx.interceptor.dispatch('app://hint/chat-message/toggle-ref-only');
      expect(ctx.jumper.request()).toMatchObject({ id: 'x', action: 'include-in-story' });
      ctx.cleanup();
    });

    it('falls back to last message flash when no message has the action button', () => {
      const ctx = setup({
        messages: [{ id: 'a' }, { id: 'b' }],
        buttonHtml: `<div id="message-a"></div><div id="message-b"></div>`,
      });
      ctx.interceptor.dispatch('app://hint/chat-message/auto-update-files');
      expect(ctx.jumper.request()).toMatchObject({ id: 'b', action: null });
      ctx.cleanup();
    });

    it('toasts when there are no messages at all', () => {
      const ctx = setup({ messages: [] });
      ctx.interceptor.dispatch('app://hint/chat-message/auto-update-files');
      expect(ctx.jumper.request()).toBeNull();
      expect(ctx.snackBar.open).toHaveBeenCalled();
      ctx.cleanup();
    });

    it('flashes last message for an unknown chat-message sub-id', () => {
      const ctx = setup({ messages: [{ id: 'only' }] });
      ctx.interceptor.dispatch('app://hint/chat-message/bogus-action');
      expect(ctx.jumper.request()).toMatchObject({ id: 'only', action: null });
      ctx.cleanup();
    });

    it('does not call registry.openTarget for any chat-message hint', () => {
      const ctx = setup({ messages: [{ id: 'm' }] });
      ctx.interceptor.dispatch('app://hint/chat-message/edit-text');
      expect(ctx.registry.openTarget).not.toHaveBeenCalled();
      ctx.cleanup();
    });
  });

  it('toasts (not throws) on malformed percent-encoding in any scheme', () => {
    const { interceptor, snackBar, jumper, registry, fileViewerOpener } = setup({ loadedFiles: new Map([['x.md', '']]) });
    // `%` with no hex digits triggers URIError in decodeURIComponent.
    for (const url of ['app://hint/foo%', 'app://message/abc%', 'app://file/x%.md']) {
      expect(() => interceptor.dispatch(url)).not.toThrow();
    }
    // All three should have surfaced an invalidUrl toast without firing
    // their action handlers.
    expect(snackBar.open).toHaveBeenCalled();
    expect(registry.openTarget).not.toHaveBeenCalled();
    expect(jumper.request()).toBeNull();
    expect(fileViewerOpener.open).not.toHaveBeenCalled();
  });
});
