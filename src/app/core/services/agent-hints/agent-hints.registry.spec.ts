/* eslint-disable no-restricted-globals -- test setup uses document.createElement directly for ElementRef stubs */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ElementRef } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { I18nService } from '@app/core/i18n';
import { AgentHintRegistry } from './agent-hints.registry';

/**
 * Translation stub that mimics I18nService.walk: returns the value if found
 * in `dict`, else returns the key (matches the production fallback so the
 * tests exercise both the hit and miss paths without setting up a real
 * UI_LOCALE registry).
 */
function makeI18nStub(dict: Record<string, string> = {}): Partial<I18nService> {
  return {
    translate: vi.fn((key: string, params?: Record<string, string | number>): string => {
      const raw = dict[key] ?? key;
      if (!params) return raw;
      return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(params[name] ?? `{{${name}}}`));
    }),
  };
}

function setup(dict: Record<string, string> = {}): {
  registry: AgentHintRegistry;
  snackBar: { open: ReturnType<typeof vi.fn> };
  translateFn: ReturnType<typeof vi.fn>;
} {
  const snackBar = { open: vi.fn() };
  const i18n = makeI18nStub(dict);
  TestBed.configureTestingModule({
    providers: [
      { provide: MatSnackBar, useValue: snackBar },
      { provide: I18nService, useValue: i18n },
    ],
  });
  const registry = TestBed.inject(AgentHintRegistry);
  return { registry, snackBar, translateFn: i18n.translate as ReturnType<typeof vi.fn> };
}

describe('AgentHintRegistry — walkTree', () => {
  it('flattens the manifest into byPath with full slash paths', () => {
    const { registry } = setup();
    const paths = registry._allPaths();
    expect(paths).toContain('chat-input');
    expect(paths).toContain('chat-input/send');
    expect(paths).toContain('chat-input/chat-config/profile-manage-menu/profile-clone');
    expect(paths).toContain('sidebar/adventure-books/add-book');
    expect(paths).toContain('sidebar/session-tab/start-session/select-scenario');
  });

  it('preserves parent / depth fields', () => {
    const { registry } = setup();
    const profileClone = registry.findByPath('chat-input/chat-config/profile-manage-menu/profile-clone');
    expect(profileClone).not.toBeNull();
    expect(profileClone!.parent).toBe('chat-input/chat-config/profile-manage-menu');
    expect(profileClone!.depth).toBe(3);

    const root = registry.findByPath('chat-input');
    expect(root!.parent).toBeNull();
    expect(root!.depth).toBe(0);
  });
});

describe('AgentHintRegistry — describe() / nameOf()', () => {
  it('returns the `.self.description` for container entries', () => {
    const { registry } = setup({
      'agentHint.chat-input.self.description': 'Bottom toolbar',
      'agentHint.chat-input.self.name': 'Toolbar',
    });
    expect(registry.describe('chat-input')).toBe('Bottom toolbar');
    expect(registry.nameOf('chat-input')).toBe('Toolbar');
  });

  it('returns the leaf `.description` / `.name`', () => {
    const { registry } = setup({
      'agentHint.chat-input.send.description': 'Send message',
      'agentHint.chat-input.send.name': 'Send',
    });
    expect(registry.describe('chat-input/send')).toBe('Send message');
    expect(registry.nameOf('chat-input/send')).toBe('Send');
  });

  it('falls back to the key on a translation miss', () => {
    const { registry } = setup();
    expect(registry.describe('chat-input/send')).toBe('agentHint.chat-input.send.description');
    expect(registry.nameOf('chat-input/send')).toBe('agentHint.chat-input.send.name');
  });
});

describe('AgentHintRegistry — getChildren / getAncestorChain', () => {
  it('lists immediate children only', () => {
    const { registry } = setup();
    const children = registry.getChildren('chat-input/chat-config');
    expect(children.map(c => c.path)).toContain('chat-input/chat-config/save-current');
    expect(children.map(c => c.path)).toContain('chat-input/chat-config/profile-manage-menu');
    // grandchildren are not included
    expect(children.map(c => c.path)).not.toContain('chat-input/chat-config/profile-manage-menu/profile-clone');
    expect(children.every(c => c.depth === 2)).toBe(true);
  });

  it('walks ancestors root → self', () => {
    const { registry } = setup();
    const chain = registry.getAncestorChain('chat-input/chat-config/profile-manage-menu/profile-clone');
    expect(chain.map(r => r.path)).toEqual([
      'chat-input',
      'chat-input/chat-config',
      'chat-input/chat-config/profile-manage-menu',
      'chat-input/chat-config/profile-manage-menu/profile-clone',
    ]);
  });
});

describe('AgentHintRegistry — attachElement / detachElement', () => {
  let registry: AgentHintRegistry;
  beforeEach(() => {
    registry = setup().registry;
  });

  it('binds ElementRef + onActivate; detachElement clears them', () => {
    const ref = new ElementRef(document.createElement('button'));
    const onActivate = vi.fn();
    registry.attachElement('chat-input/send', ref, onActivate);

    const r = registry.findByPath('chat-input/send')!;
    expect(r.elementRef).toBe(ref);
    expect(r.onActivate).toBe(onActivate);

    registry.detachElement('chat-input/send', ref);
    const after = registry.findByPath('chat-input/send')!;
    expect(after.elementRef).toBeNull();
    expect(after.onActivate).toBeUndefined();
  });

  it('detach with a stale ref does not clear an attached newer ref', () => {
    const refA = new ElementRef(document.createElement('button'));
    const refB = new ElementRef(document.createElement('button'));
    registry.attachElement('chat-input/send', refA);
    registry.attachElement('chat-input/send', refB);
    // refA detaches AFTER refB attached — should be a no-op (we hold refB now).
    registry.detachElement('chat-input/send', refA);
    expect(registry.findByPath('chat-input/send')!.elementRef).toBe(refB);
  });

  it('warns + ignores attach to an unknown path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registry.attachElement('totally/not/a/path', new ElementRef(document.createElement('button')));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown path'));
    warn.mockRestore();
  });
});

describe('AgentHintRegistry — openTarget', () => {
  it('returns unknown reason + toasts when the path is not in the manifest', () => {
    const { registry, snackBar } = setup({
      'agentHint.toast.unknownPath': 'UNKNOWN: {{path}}',
      'ui.CLOSE': 'Close',
    });
    const result = registry.openTarget('made/up/path');
    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(snackBar.open).toHaveBeenCalledWith('UNKNOWN: made/up/path', 'Close', expect.any(Object));
  });

  it('activates a mounted activatable entry by calling onActivate (no synthetic click)', () => {
    const { registry } = setup();
    const onActivate = vi.fn();
    const element = document.createElement('button');
    const clickSpy = vi.spyOn(element, 'click');
    registry.attachElement('chat-input/chat-config', new ElementRef(element), onActivate);
    Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body });

    const result = registry.openTarget('chat-input/chat-config', 'activate');

    expect(result).toEqual({ ok: true, action: 'activate' });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('degrades activate to highlight on non-activatable entries', () => {
    const { registry } = setup();
    const onActivate = vi.fn();
    const element = document.createElement('button');
    element.scrollIntoView = vi.fn();
    Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body });
    registry.attachElement('chat-input/send', new ElementRef(element), onActivate);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registry.openTarget('chat-input/send', 'activate');

    expect(onActivate).not.toHaveBeenCalled();
    expect(element.scrollIntoView).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('activate degraded to highlight'));
    warn.mockRestore();
  });

  it('focuses an element on `focus` action', () => {
    const { registry } = setup();
    const element = document.createElement('input');
    const focusSpy = vi.spyOn(element, 'focus');
    Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body });
    registry.attachElement('chat-input/send', new ElementRef(element));

    registry.openTarget('chat-input/send', 'focus');

    expect(focusSpy).toHaveBeenCalled();
  });
});

describe('AgentHintRegistry — breadcrumb (unreachable targets)', () => {
  it('returns unreachable + toasts the localized breadcrumb when target is unmounted', () => {
    const { registry, snackBar } = setup({
      'agentHint.sidebar.self.name': 'Sidebar',
      'agentHint.sidebar.settings.self.name': 'Settings',
      'agentHint.sidebar.settings.font-size.name': 'Font size',
      'agentHint.toast.findItHere': 'FIND: {{breadcrumb}}',
      'ui.CLOSE': 'Close',
    });
    const result = registry.openTarget('sidebar/settings/font-size');
    expect(result).toEqual({
      ok: false,
      reason: 'unreachable',
      breadcrumb: 'Sidebar > Settings > Font size',
    });
    expect(snackBar.open).toHaveBeenCalledWith(
      'FIND: Sidebar > Settings > Font size',
      'Close',
      expect.any(Object)
    );
  });

  it('treats directive-attached-but-hidden as unreachable (offsetParent null + zero-size rect)', () => {
    const { registry, snackBar } = setup({
      'agentHint.toast.findItHere': 'FIND: {{breadcrumb}}',
      'ui.CLOSE': 'Close',
    });
    const el = document.createElement('button');
    // Simulate display:none ancestor — offsetParent=null AND empty rect.
    Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => null });
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}),
    });
    registry.attachElement('sidebar/session-tab/start-session', new ElementRef(el));
    const result = registry.openTarget('sidebar/session-tab/start-session');
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(snackBar.open).toHaveBeenCalled();
  });

  it('breadcrumbLabel joins the chain with " > " using short names', () => {
    const { registry } = setup({
      'agentHint.chat-input.self.name': 'Toolbar',
      'agentHint.chat-input.chat-config.self.name': 'Chat config',
      'agentHint.chat-input.chat-config.profile-manage-menu.self.name': 'Profile menu',
      'agentHint.chat-input.chat-config.profile-manage-menu.profile-clone.name': 'Clone profile',
    });
    expect(registry.breadcrumbLabel('chat-input/chat-config/profile-manage-menu/profile-clone'))
      .toBe('Toolbar > Chat config > Profile menu > Clone profile');
  });

  it('buildUiMap returns indented markdown tree with name + description', () => {
    const { registry } = setup({
      'agentHint.chat-input.self.name': 'Toolbar',
      'agentHint.chat-input.self.description': 'Bottom toolbar',
      'agentHint.chat-input.send.name': 'Send',
      'agentHint.chat-input.send.description': 'Send message',
    });
    const map = registry.buildUiMap();
    expect(map).toContain('- chat-input — Toolbar — Bottom toolbar');
    expect(map).toContain('  - chat-input/send — Send — Send message');
    expect(map).toContain('(activatable)');
  });
});

describe('AgentHintRegistry — getMountedReport (debug)', () => {
  it('groups paths by mount state and flags activatable-without-listener', () => {
    const { registry } = setup();
    // Mount chat-input/chat-config WITHOUT an onActivate listener — manifest
    // says activatable, so this is the authoring-bug scenario.
    registry.attachElement('chat-input/chat-config', new ElementRef(document.createElement('button')));
    // Mount chat-input/send with no onActivate — non-activatable, so this is fine.
    registry.attachElement('chat-input/send', new ElementRef(document.createElement('button')));

    const report = registry.getMountedReport();
    expect(report.mounted).toContain('chat-input/send');
    expect(report.mounted).toContain('chat-input/chat-config');
    expect(report.unmounted).toContain('chat-input/chat-config/profile-manage-menu/profile-clone');
    expect(report.activatableMounted).toContain('chat-input/chat-config');
    expect(report.activatableMounted).not.toContain('chat-input/send');
    expect(report.activatableWithoutListener).toContain('chat-input/chat-config');
    expect(report.activatableWithoutListener).not.toContain('chat-input/send');
  });
});
