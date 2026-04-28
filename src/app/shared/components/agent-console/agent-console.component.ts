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
  effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MarkdownModule } from 'ngx-markdown';
import { FileAgentService } from '../../../core/services/file-agent/file-agent.service';

@Component({
  selector: 'app-agent-console',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MarkdownModule
  ],
  templateUrl: './agent-console.component.html',
  styleUrl: './agent-console.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgentConsoleComponent implements OnDestroy {
  // Inputs
  files = input.required<Map<string, string>>();
  initialPrompt = input<string>('');

  // Injected services
  agentService = inject(FileAgentService);
  private clipboard = inject(Clipboard);

  // Internal state
  agentPrompt = signal('');

  // ViewChild refs for auto-scroll
  private agentConsoleEl = viewChild<ElementRef<HTMLElement>>('agentConsole');
  private agentConsoleContentEl = viewChild<ElementRef<HTMLElement>>('agentConsoleContent');

  // Auto-scroll state
  private agentResizeObserver: ResizeObserver | null = null;
  private agentScrollListener: (() => void) | null = null;
  private agentScrollFrameId: number | null = null;
  private userScrolledUpAgent = false;
  private lastAgentScrollTop = 0;
  private initialPromptTimeoutId: number | null = null;

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
          this.runAgent();
        }, 200);
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
    await this.agentService.runAgent(prompt, {
      files: this.files(),
      onFileReplaced: (filename, content) => {
        this.files().set(filename, content);
      }
    });
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
