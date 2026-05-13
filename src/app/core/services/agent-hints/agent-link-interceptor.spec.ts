import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
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

function setup(loadedFiles = new Map<string, string>()) {
  const snackBar = { open: vi.fn() };
  const fileViewerOpener = { isOpen: () => false, open: vi.fn(() => ({ alreadyOpen: false })) };
  const stateStub = { loadedFiles: signal(loadedFiles).asReadonly() };
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
  return { interceptor, registry, snackBar, fileViewerOpener, jumper, stateStub };
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

  it('dispatches app://message/<id> via AgentMessageJumperService', () => {
    const { interceptor, jumper } = setup();
    interceptor.dispatch('app://message/abc-123');
    expect(jumper.request()).toMatchObject({ id: 'abc-123' });
  });

  it('decodes percent-encoded message ids', () => {
    const { interceptor, jumper } = setup();
    interceptor.dispatch('app://message/abc%20with%20space');
    expect(jumper.request()).toMatchObject({ id: 'abc with space' });
  });

  it('toasts and returns true on message URL with no id (treat as claimed but invalid)', () => {
    const { interceptor, snackBar } = setup();
    expect(interceptor.dispatch('app://message/')).toBe(true);
    expect(snackBar.open).toHaveBeenCalled();
  });

  it('opens the file-viewer for app://file/<filename>', () => {
    const { interceptor, fileViewerOpener } = setup(new Map([['Inventory.md', '# items']]));
    interceptor.dispatch('app://file/Inventory.md');
    expect(fileViewerOpener.open).toHaveBeenCalledWith(
      expect.objectContaining({ initialFile: 'Inventory.md', files: expect.any(Map) })
    );
  });

  it('toasts when the file scheme references a missing KB file', () => {
    const { interceptor, snackBar, fileViewerOpener } = setup(new Map());
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
});
