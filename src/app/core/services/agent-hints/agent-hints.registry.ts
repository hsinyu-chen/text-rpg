import { Injectable, inject, ElementRef } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { I18nService } from '@app/core/i18n';
import { AGENT_HINTS_MANIFEST } from './agent-hints.manifest';
import { spotlightElement } from './spotlight.util';
import type { AgentHintEntry, ResolvedEntry, HintAction } from './agent-hints.types';

const BREADCRUMB_TOAST_MS = 6000;

@Injectable({ providedIn: 'root' })
export class AgentHintRegistry {
  private readonly byPath = new Map<string, ResolvedEntry>();
  private readonly snackBar = inject(MatSnackBar);
  private readonly i18n = inject(I18nService);

  constructor() {
    this.walkTree(AGENT_HINTS_MANIFEST, []);
  }

  private walkTree(entries: AgentHintEntry[], ancestors: AgentHintEntry[]): void {
    for (const entry of entries) {
      const path = [...ancestors.map(a => a.id), entry.id].join('/');
      if (this.byPath.has(path)) {
        throw new Error(`[agent-hint] duplicate manifest path: ${path}`);
      }
      this.byPath.set(path, {
        entry,
        path,
        parent: ancestors.length ? ancestors.map(a => a.id).join('/') : null,
        depth: ancestors.length,
        elementRef: null,
        onActivate: undefined,
      });
      if (entry.children?.length) {
        this.walkTree(entry.children, [...ancestors, entry]);
      }
    }
  }

  findByPath(path: string): ResolvedEntry | null {
    return this.byPath.get(path) ?? null;
  }

  getChildren(path: string): ResolvedEntry[] {
    const resolved = this.byPath.get(path);
    if (!resolved?.entry.children) return [];
    return resolved.entry.children
      .map(c => this.byPath.get(`${path}/${c.id}`))
      .filter((r): r is ResolvedEntry => !!r);
  }

  /** Returns [root, ..., self]. Empty list if path unknown. */
  getAncestorChain(path: string): ResolvedEntry[] {
    const segments = path.split('/');
    const chain: ResolvedEntry[] = [];
    for (let i = 1; i <= segments.length; i++) {
      const r = this.byPath.get(segments.slice(0, i).join('/'));
      if (r) chain.push(r);
    }
    return chain;
  }

  /**
   * Long-form description. Containers store theirs at `<key>.self.description`,
   * leaves at `<key>.description`. Falls back to the raw key on miss so typos
   * surface visibly in the UI.
   */
  describe(path: string): string {
    return this.lookup(path, 'description');
  }

  /** Short name for the entry; used in breadcrumbs and location labels. */
  nameOf(path: string): string {
    return this.lookup(path, 'name');
  }

  private lookup(path: string, field: 'name' | 'description'): string {
    const base = 'agentHint.' + path.replace(/\//g, '.');
    const selfKey = `${base}.self.${field}`;
    const selfValue = this.i18n.translate(selfKey);
    if (selfValue !== selfKey) return selfValue;
    return this.i18n.translate(`${base}.${field}`);
  }

  /** Comma-joined ancestor names (root → parent). Used by ui_search location field. */
  locationLabel(path: string): string {
    const ancestors = this.getAncestorChain(path).slice(0, -1);
    if (!ancestors.length) return this.i18n.translate('agentHint.toast.mainArea');
    return ancestors.map(a => this.nameOf(a.path)).join(' > ');
  }

  attachElement(path: string, ref: ElementRef, onActivate?: () => void): void {
    const resolved = this.byPath.get(path);
    if (!resolved) {
      console.warn(`[agent-hint] attachElement to unknown path: ${path}`);
      return;
    }
    if (resolved.elementRef && resolved.elementRef !== ref) {
      console.warn(`[agent-hint] duplicate attach at ${path} — class-level entry shouldn't have a directive`);
    }
    resolved.elementRef = ref;
    resolved.onActivate = onActivate;
  }

  detachElement(path: string, ref: ElementRef): void {
    const resolved = this.byPath.get(path);
    if (!resolved) return;
    if (resolved.elementRef === ref) {
      resolved.elementRef = null;
      resolved.onActivate = undefined;
    }
  }

  /**
   * Visible target → perform the action. Otherwise toast a breadcrumb so the
   * user learns the navigation path; we do NOT auto-open ancestor surfaces
   * (many ancestors are toggle handlers, and auto-open also teaches nothing).
   */
  openTarget(path: string, action: HintAction = 'highlight'): { ok: true; action: HintAction } | { ok: false; reason: 'unknown' | 'unreachable'; breadcrumb?: string } {
    const resolved = this.byPath.get(path);
    if (!resolved) {
      this.toast('agentHint.toast.unknownPath', { path }, 4000);
      return { ok: false, reason: 'unknown' };
    }

    const visible = resolved.elementRef && this.isElementVisible(resolved.elementRef.nativeElement as HTMLElement);
    if (!visible) {
      const breadcrumb = this.breadcrumbLabel(path);
      this.toast('agentHint.toast.findItHere', { breadcrumb }, BREADCRUMB_TOAST_MS);
      return { ok: false, reason: 'unreachable', breadcrumb };
    }

    this.applyAction(resolved, action, path);
    return { ok: true, action };
  }

  private isElementVisible(el: HTMLElement): boolean {
    if (el.offsetParent !== null) return true;
    // position:fixed has null offsetParent even when visible.
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Localized chain root→self, joined by ' > '. Uses short names, not descriptions. */
  breadcrumbLabel(path: string): string {
    const chain = this.getAncestorChain(path);
    if (!chain.length) return path;
    return chain.map(n => this.nameOf(n.path)).join(' > ');
  }

  /**
   * Indented markdown dump of the full manifest tree for the agent's `uiMap`
   * tool. One line per entry: `<indent>- <path> [(activatable)] — <name> — <description>`.
   * mounted state intentionally omitted — it's runtime-volatile and the
   * breadcrumb-on-click flow handles unmounted targets automatically.
   */
  buildUiMap(): string {
    const lines: string[] = [];
    const walk = (entries: AgentHintEntry[], ancestors: AgentHintEntry[]): void => {
      for (const entry of entries) {
        const path = [...ancestors.map(a => a.id), entry.id].join('/');
        const tag = entry.activatable ? ' (activatable)' : '';
        const indent = '  '.repeat(ancestors.length);
        lines.push(`${indent}- ${path}${tag} — ${this.nameOf(path)} — ${this.describe(path)}`);
        if (entry.children?.length) walk(entry.children, [...ancestors, entry]);
      }
    };
    walk(AGENT_HINTS_MANIFEST, []);
    return lines.join('\n');
  }

  private applyAction(resolved: ResolvedEntry, action: HintAction, originalPath: string): void {
    const el = resolved.elementRef!.nativeElement as HTMLElement;

    if (action === 'activate') {
      if (resolved.entry.activatable && resolved.onActivate) {
        resolved.onActivate();
        return;
      }
      console.warn(`[agent-hint] activate degraded to highlight: ${originalPath} (activatable=${!!resolved.entry.activatable}, hasListener=${!!resolved.onActivate})`);
      // fallthrough to highlight
    }

    if (action === 'focus') {
      el.focus({ preventScroll: false });
      return;
    }

    this.scrollIntoCenter(el);
    // scrollIntoCenter is smooth-async; let it settle before snapping the
    // spotlight to the final bbox so the hole doesn't jump halfway through.
    setTimeout(() => this.spotlight(el), 250);
  }

  private spotlight(el: HTMLElement): void {
    spotlightElement(el);
  }

  /**
   * Walk up every scrollable ancestor and scroll it so `el` ends near the
   * vertical center of each container's visible area. Native
   * `scrollIntoView({ block: 'center' })` is supposed to walk all scrollable
   * ancestors but is unreliable inside Angular Material / CDK nested scroll
   * containers (the inner one often stays put). Doing the math manually is
   * cheap and predictable.
   */
  private scrollIntoCenter(el: HTMLElement): void {
    let parent: HTMLElement | null = el.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      const overflowY = style.overflowY;
      const scrollable = (overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight;
      if (scrollable) {
        const elRect = el.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        const targetOffset = (elRect.top - parentRect.top) + (elRect.height / 2) - (parentRect.height / 2);
        parent.scrollBy({ top: targetOffset, behavior: 'smooth' });
      }
      parent = parent.parentElement;
    }
    // Also pump the window scroll in case el is off-page entirely (covers the
    // root document, which doesn't show up in overflowY checks above).
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private toast(key: string, params: Record<string, string | number>, duration = 5000): void {
    this.snackBar.open(
      this.i18n.translate(key, params),
      this.i18n.translate('ui.CLOSE'),
      { duration }
    );
  }

  /** Test-only: snapshot of all paths in the registry. */
  _allPaths(): string[] {
    return Array.from(this.byPath.keys());
  }

  /**
   * Debug snapshot: which paths are physically attached (directive mounted)
   * vs. waiting for their parent dialog/panel to open. Surfaced via the
   * dev bridge (`agent_get_hints`) so an outside agent / PS helper can
   * verify the template was wired up correctly.
   *
   * `activatableWithoutListener` flags an authoring bug: the manifest says
   * the entry is activatable, but the directive's `(hintActivate)` output
   * isn't bound — `?do=activate` URLs silently degrade to highlight.
   */
  getMountedReport(): {
    total: number;
    mounted: string[];
    unmounted: string[];
    activatableMounted: string[];
    activatableUnmounted: string[];
    activatableWithoutListener: string[];
  } {
    const mounted: string[] = [];
    const unmounted: string[] = [];
    const activatableMounted: string[] = [];
    const activatableUnmounted: string[] = [];
    const activatableWithoutListener: string[] = [];
    for (const r of this.byPath.values()) {
      const isMounted = r.elementRef !== null;
      (isMounted ? mounted : unmounted).push(r.path);
      if (r.entry.activatable) {
        (isMounted ? activatableMounted : activatableUnmounted).push(r.path);
        if (isMounted && !r.onActivate) activatableWithoutListener.push(r.path);
      }
    }
    return {
      total: this.byPath.size,
      mounted: mounted.sort(),
      unmounted: unmounted.sort(),
      activatableMounted: activatableMounted.sort(),
      activatableUnmounted: activatableUnmounted.sort(),
      activatableWithoutListener: activatableWithoutListener.sort(),
    };
  }
}
