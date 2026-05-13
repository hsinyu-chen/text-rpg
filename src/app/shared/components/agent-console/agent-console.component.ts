import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  input,
  viewChild,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  isDevMode
} from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { DecimalPipe, NgClass } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { FormsModule } from '@angular/forms';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MarkdownModule } from 'ngx-markdown';
import { FileAgentService } from '@app/core/services/file-agent/file-agent.service';
import { BuiltInPromptsService } from '@app/core/services/file-agent/built-in-prompts.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { CORE_MAT, FORM_MAT } from '@app/shared/material/material-groups';
import type { ChatMessage } from '@app/core/models/types';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { AgentLinkInterceptor } from '@app/core/services/agent-hints/agent-link-interceptor.service';
import { AgentHintRegistry } from '@app/core/services/agent-hints/agent-hints.registry';
import { AgentPanelStateService } from '@app/core/services/file-agent/agent-panel-state.service';
import type { AgentLogEntry } from '@app/core/services/file-agent/file-agent.types';

@Component({
  selector: 'app-agent-console',
  standalone: true,
  imports: [
    ...CORE_MAT,
    ...FORM_MAT,
    MatProgressSpinnerModule,
    MatMenuModule,
    FormsModule,
    NgClass,
    DecimalPipe,
    MarkdownModule,
    TranslatePipe
  ],
  templateUrl: './agent-console.component.html',
  styleUrl: './agent-console.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgentConsoleComponent implements OnDestroy {
  // Inputs
  files = input.required<Map<string, string>>();
  initialPrompt = input<string>('');
  /** Optional in-game chat snapshot for chat-aware tools. Omit (or pass undefined) when no game is active — chat-aware tools degrade with a "no chat history available" error. */
  chatMessages = input<ChatMessage[] | undefined>(undefined);
  /** When true, write tools are rejected at the executor and the prompt notes the read-only constraint. Used on the main-screen surface where there is no editor view to review edits. */
  readOnly = input<boolean>(false);
  /** Dev-bridge external fill request: when the tick increments, push `prompt` into the input and optionally auto-run. Null = no fill request. */
  externalFillRequest = input<{ prompt: string; autoSend: boolean; tick: number } | null>(null);

  // Injected services
  agentService = inject(FileAgentService);
  builtInPromptsService = inject(BuiltInPromptsService);
  private clipboard = inject(Clipboard);
  private snackBar = inject(MatSnackBar);
  private i18n = inject(I18nService);
  private appConfig = inject(AppConfigStore);
  private linkInterceptor = inject(AgentLinkInterceptor);
  private hintRegistry = inject(AgentHintRegistry);
  private panelState = inject(AgentPanelStateService);
  private matDialog = inject(MatDialog);
  /** Memoizes `breadcrumbifyLinks` by source text — same input string ⇒ same output reference, so <markdown [data]> doesn't re-parse on every CD. */
  private readonly breadcrumbCache = new WeakMap<AgentLogEntry, { src: string; out: string }>();

  /** Dev-only flag — shows the agent-hint debug button next to built-in-prompts. Resolved eagerly so the @if in template doesn't need to call a method per check. */
  protected readonly isDevMode = isDevMode();

  // Internal state
  agentPrompt = signal('');

  /**
   * Per-log-entry fold toggles. The collapse flags live on `AgentLogEntry`
   * (the streaming side sets `isThoughtCollapsed` automatically when text
   * follows thought), but the toggle action itself is a view concern —
   * driven by user clicks in this template.
   */
  toggleLogSection(index: number, key: 'isThoughtCollapsed' | 'isToolCallCollapsed' | 'isToolResultCollapsed'): void {
    this.agentService.agentLogs.update(logs => {
      const next = [...logs];
      if (next[index]) {
        next[index] = { ...next[index], [key]: !next[index][key] };
      }
      return next;
    });
  }

  // ViewChild refs for auto-scroll
  private agentConsoleEl = viewChild<ElementRef<HTMLElement>>('agentConsole');
  private agentConsoleContentEl = viewChild<ElementRef<HTMLElement>>('agentConsoleContent');

  // Auto-scroll state
  private agentResizeObserver: ResizeObserver | null = null;
  private agentScrollListener: (() => void) | null = null;
  private agentScrollFrameId: number | null = null;
  private userScrolledUpAgent = false;
  private lastAgentScrollTop = 0;
  private initialPromptTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Auto-scroll: observe content growth and follow the bottom unless the user
    // has scrolled up. Re-runs whenever the console elements appear/disappear.
    effect((onCleanup) => {
      const scrollEl = this.agentConsoleEl()?.nativeElement;
      const contentEl = this.agentConsoleContentEl()?.nativeElement;
      if (!scrollEl || !contentEl) return;

      this.userScrolledUpAgent = false;
      this.lastAgentScrollTop = 0;

      const onScroll = () => this.checkAgentScroll(scrollEl);
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
      this.agentScrollListener = onScroll;

      const ro = new ResizeObserver(() => this.smartScrollAgent());
      ro.observe(contentEl);
      this.agentResizeObserver = ro;

      // Snap to bottom on first show.
      requestAnimationFrame(() => {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      });

      onCleanup(() => {
        scrollEl.removeEventListener('scroll', onScroll);
        ro.disconnect();
        if (this.agentResizeObserver === ro) this.agentResizeObserver = null;
        if (this.agentScrollListener === onScroll) this.agentScrollListener = null;
        if (this.agentScrollFrameId) {
          cancelAnimationFrame(this.agentScrollFrameId);
          this.agentScrollFrameId = null;
        }
      });
    });

    afterNextRender(() => {
      const prompt = this.initialPrompt();
      if (prompt && this.agentService.agentHistory().length === 0 && !this.agentService.isAgentRunning()) {
        this.agentPrompt.set(prompt);
        // Small delay lets the input render before runAgent clears it.
        // Tracked so a fast close doesn't fire an orphan request.
        this.initialPromptTimeoutId = setTimeout(() => {
          this.initialPromptTimeoutId = null;
          void this.runAgent();
        }, 200);
      }
    });

    // Dev-bridge fill driver: tick-keyed, fires only on new requests so
    // the initial null + page reloads don't auto-replay a stale prompt.
    // The tick lives on AgentPanelStateService (lifetime-stable) — this
    // component is destroyed/recreated on every panel toggle, so a local
    // counter would reset to 0 and replay a pre-existing fill request on
    // every reopen.
    effect(() => {
      const req = this.externalFillRequest();
      if (!req || req.tick === this.panelState.lastFillTick) return;
      this.panelState.lastFillTick = req.tick;
      this.agentPrompt.set(req.prompt);
      if (req.autoSend && !this.agentService.isAgentRunning()) {
        void this.runAgent();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.initialPromptTimeoutId !== null) {
      clearTimeout(this.initialPromptTimeoutId);
      this.initialPromptTimeoutId = null;
    }
    this.teardownAgentConsoleScroll();
  }

  copyDebugLog(): void {
    const logs = this.agentService.agentLogs();
    const files = this.files();

    const lines: string[] = ['=== AGENT LOG ===', ''];

    logs.forEach((log, i) => {
      const prefix = log.role === 'user' ? 'USER' : log.role === 'model' ? 'MODEL' : 'SYSTEM';
      const tag = log.isToolCall ? ` [TOOL CALL: ${log.toolName ?? ''}]`
        : log.isToolResult ? ` [TOOL RESULT: ${log.toolName ?? ''}]`
        : '';
      lines.push(`[${i + 1}] ${prefix}${tag}`);
      if (log.thought) lines.push(`<thinking>\n${log.thought}\n</thinking>`);
      if (log.text) lines.push(log.text);
      lines.push('');
    });

    lines.push('', '=== FILE CONTENTS (current in-memory state) ===', '');
    files.forEach((content, name) => {
      lines.push(`${'─'.repeat(60)}`, `FILE: ${name}`, `${'─'.repeat(60)}`);
      lines.push(content, '');
    });

    this.clipboard.copy(lines.join('\n'));
  }

  async runAgent(): Promise<void> {
    const prompt = this.agentPrompt().trim();
    if (!prompt) return;
    this.agentPrompt.set('');
    // When an external editing surface (file-viewer's Monaco buffer) has
    // registered an edit channel, route ALL reads and writes through it —
    // the agent then sees that surface's live unsaved buffer and edits
    // accumulate there, letting the surface's own Save flow persist them.
    // No channel ⇒ fall back to the caller-supplied files Map (file-viewer's
    // own internal panel passes its data.files; chat-side is read-only).
    const channel = this.panelState.editChannel();
    await this.agentService.runAgent(prompt, {
      files: channel ? channel.read() : this.files(),
      onFileReplaced: channel
        ? (filename, content) => channel.write(filename, content)
        : (filename, content) => this.files().set(filename, content),
      chatMessages: this.chatMessages(),
      uiLanguage: this.i18n.currentLang(),
      narrativeLanguage: this.appConfig.outputLanguage(),
      readOnly: this.readOnly()
    });
  }

  /**
   * Dev-only: pop the AgentHintDebugDialog so testers can fire highlight /
   * focus / activate on any manifest entry without going through the LLM.
   * Lazy-imported so production bundles don't pay for it.
   */
  async openHintDebug(): Promise<void> {
    const mod = await import('@app/core/services/agent-hints/agent-hint-debug-dialog.component');
    this.matDialog.open(mod.AgentHintDebugDialogComponent, {
      hasBackdrop: false,
      position: { right: '20px', top: '60px' },
      panelClass: 'agent-hint-debug-panel',
      autoFocus: false,
      restoreFocus: false,
    });
  }

  /**
   * Intercept `app://...` links in agent output. Bound on each markdown
   * wrapper via `(click)`. Falls through silently for non-`app://` anchors
   * so external links keep working.
   *
   * Angular's HTML sanitizer doesn't whitelist `app:` as a known-safe scheme
   * (only http/https/mailto/data/ftp/tel/file/sms), so it prefixes the rendered
   * href with `unsafe:` — a selector like `a[href^="app://"]` won't match.
   * Read the raw attribute and strip the prefix instead.
   */
  onAgentLogClick(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const raw = anchor.getAttribute('href') ?? '';
    const cleaned = raw.startsWith('unsafe:') ? raw.slice('unsafe:'.length) : raw;
    if (!cleaned.startsWith('app://')) return;
    if (this.linkInterceptor.dispatch(cleaned)) {
      event.preventDefault();
    }
  }

  /**
   * Expand `[anything](app://hint/A/B/C)` into a per-segment clickable chain:
   * `[A](app://hint/A) › [B](app://hint/A/B) › [C](app://hint/A/B/C)`.
   *
   * Two passes:
   *   1. **Collapse manually-composed chains.** LLMs sometimes ignore the
   *      "emit only the deepest" rule and string ancestor links together
   *      with `›` / `>` separators. Each ancestor would then re-expand on
   *      pass 2, producing nested duplicates. Detect adjacent links where
   *      the earlier path is a prefix of the later one and drop the earlier.
   *   2. **Per-segment expansion.** Single deep link → chain of one link per
   *      segment. Trailing query (e.g. `?do=activate`) stays on the LAST
   *      segment only. Top-level entries (no `/`) keep the original markup.
   *
   * Cached per log entry by source-text identity so <markdown [data]> doesn't
   * re-parse on every CD.
   */
  protected breadcrumbifyLinks(log: AgentLogEntry): string {
    const src = log.text ?? '';
    const cached = this.breadcrumbCache.get(log);
    if (cached?.src === src) return cached.out;

    let collapsed = src;
    const chainRe = /\[([^\]]+)\]\(app:\/\/hint\/([^)?\s]+)(?:\?[^)]*)?\)(\s*[›»→>]+\s*)\[([^\]]+)\]\(app:\/\/hint\/([^)?\s]+)([^)]*)\)/g;
    for (let pass = 0; pass < 8; pass++) {
      const next = collapsed.replace(chainRe, (whole, _l1, p1: string, _sep, l2: string, p2: string, q2: string) => {
        return (p2 + '/').startsWith(p1 + '/') ? `[${l2}](app://hint/${p2}${q2})` : whole;
      });
      if (next === collapsed) break;
      collapsed = next;
    }

    const out = collapsed.replace(
      /\[([^\]]+)\]\(app:\/\/hint\/([^)?\s]+)([^)]*)\)/g,
      (whole, _label, path: string, query: string) => {
        if (!path.includes('/')) return whole;
        const segments = path.split('/');
        // Bail if ANY segment in the chain isn't a real manifest path — LLM
        // can hallucinate segment ids, and expanding then surfaces raw dict
        // keys like `agentHint.sidebar.new-game.name` as the link text.
        // Keep the LLM's original markup so the click handler can toast a
        // "target not found" instead.
        for (let i = 0; i < segments.length; i++) {
          const sub = segments.slice(0, i + 1).join('/');
          if (!this.hintRegistry.findByPath(sub)) return whole;
        }
        return segments.map((_seg, i) => {
          const sub = segments.slice(0, i + 1).join('/');
          const name = this.hintRegistry.nameOf(sub);
          const url = `app://hint/${sub}${i === segments.length - 1 ? query : ''}`;
          return `[${name}](${url})`;
        }).join(' › ');
      },
    );
    this.breadcrumbCache.set(log, { src, out });
    return out;
  }

  /** Fill the input with a built-in prompt body; auto-run only if the entry opts in. */
  async useBuiltInPrompt(id: string): Promise<void> {
    try {
      const body = await this.builtInPromptsService.loadPromptBody(id);
      this.agentPrompt.set(body);
      const meta = (this.builtInPromptsService.index.value() ?? []).find(p => p.id === id);
      if (meta?.autoRun) {
        await this.runAgent();
      }
    } catch (err) {
      console.error('Failed to load built-in prompt', id, err);
      // Surface the failure — silent fallback would mask a missing translation file
      // and the user would only see an empty input. Each prompt MUST have a body
      // file for every supported language; a missing one is a maintenance error.
      this.snackBar.open(
        this.i18n.translate('dialog.agentLoadPromptFailed', { id }),
        this.i18n.translate('ui.CLOSE'),
        { duration: 5000 }
      );
    }
  }

  private setupAgentConsoleScroll(): void {
    // Setup is handled reactively via the effect() in the constructor
  }

  private teardownAgentConsoleScroll(): void {
    const scrollEl = this.agentConsoleEl()?.nativeElement;
    if (scrollEl && this.agentScrollListener) {
      scrollEl.removeEventListener('scroll', this.agentScrollListener);
      this.agentScrollListener = null;
    }
    if (this.agentResizeObserver) {
      this.agentResizeObserver.disconnect();
      this.agentResizeObserver = null;
    }
    if (this.agentScrollFrameId) {
      cancelAnimationFrame(this.agentScrollFrameId);
      this.agentScrollFrameId = null;
    }
  }

  private scheduleAgentScroll(): void {
    this.smartScrollAgent();
  }

  private checkAgentScroll(el: HTMLElement): void {
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 50) {
      this.userScrolledUpAgent = false;
    } else if (el.scrollTop < this.lastAgentScrollTop - 5) {
      this.userScrolledUpAgent = true;
    }
    this.lastAgentScrollTop = el.scrollTop;
  }

  private smartScrollAgent(): void {
    if (this.agentScrollFrameId) cancelAnimationFrame(this.agentScrollFrameId);
    this.agentScrollFrameId = requestAnimationFrame(() => {
      this.agentScrollFrameId = null;
      const el = this.agentConsoleEl()?.nativeElement;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight) return;

      const isRunning = this.agentService.isAgentRunning();
      const threshold = isRunning ? 800 : 400;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const shouldFollow = dist < threshold && !this.userScrolledUpAgent;
      if (!shouldFollow) return;

      const forceInstant = isRunning || dist < 100;
      try {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: forceInstant ? 'auto' : 'smooth'
        });
      } catch {
        el.scrollTop = el.scrollHeight;
      }
      if (forceInstant) this.userScrolledUpAgent = false;
    });
  }
}
