import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  OnDestroy,
  afterNextRender,
  effect,
  isDevMode
} from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Overlay, OverlayContainer } from '@angular/cdk/overlay';
import { DecimalPipe } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { FormsModule } from '@angular/forms';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FileAgentService } from '@app/core/services/file-agent/file-agent.service';
import { BuiltInPromptsService } from '@app/core/services/file-agent/built-in-prompts.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { CORE_MAT, FORM_MAT } from '@app/shared/material/material-groups';
import type { ChatMessage } from '@app/core/models/types';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { AgentPanelStateService } from '@app/core/services/file-agent/agent-panel-state.service';
import { formatAgentDebugLog } from '@app/core/utils/format-agent-debug-log';
import {
  AgentTraceSurfaceComponent,
  type AgentRunningIndicator,
} from '../agent-trace-surface/agent-trace-surface.component';
import { PipAwareOverlayContainer } from './pip-aware-overlay-container';

@Component({
  selector: 'app-agent-console',
  standalone: true,
  imports: [
    ...CORE_MAT,
    ...FORM_MAT,
    MatMenuModule,
    FormsModule,
    DecimalPipe,
    TranslatePipe,
    AgentTraceSurfaceComponent,
  ],
  templateUrl: './agent-console.component.html',
  styleUrl: './agent-console.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Swap the CDK OverlayContainer + re-provide Overlay at this scope so
  // descendant overlays (matTooltip / mat-menu / mat-dialog inside this
  // panel) render in the PiP window's document while PiP is active.
  //
  // Overlay must also be re-provided here: the root-singleton Overlay
  // was constructed with the root OverlayContainer baked in, so
  // overriding OverlayContainer alone wouldn't reach matTooltip — it
  // injects Overlay, not the container. A scoped Overlay re-resolves
  // its OverlayContainer dependency through this injector, picking up
  // our PipAware version. (Other Overlay deps — ScrollStrategyOptions,
  // _OverlayKeyboardDispatcher, etc. — are providedIn:'root' singletons
  // that the scoped instance still shares with the rest of the app.)
  providers: [
    { provide: OverlayContainer, useClass: PipAwareOverlayContainer },
    Overlay,
  ]
})
export class AgentConsoleComponent implements OnDestroy {
  // Inputs
  files = input.required<Map<string, string>>();
  initialPrompt = input<string>('');
  /** Optional in-game chat snapshot for chat-aware tools. Omit (or pass undefined) when no game is active — chat-aware tools degrade with a "no chat history available" error. */
  chatMessages = input<ChatMessage[] | undefined>(undefined);
  /** When true, write tools are rejected at the executor and the prompt notes the read-only constraint. Used on the main-screen surface where there is no editor view to review edits. */
  readOnly = input<boolean>(false);
  /** Which physical AgentConsole this instance is — `main` for the chat-panel console (and its PiP popout, which portals from the same instance), `file-edit` for the console embedded inside the file-viewer dialog. Surfaced on the per-turn user-message tag so the LLM tracks it across turns, and consumed by interactive propose-tools that only make sense on `main`. */
  surface = input<'main' | 'file-edit'>('main');
  /** Dev-bridge external fill request: when the tick increments, push `prompt` into the input and optionally auto-run. Null = no fill request. */
  externalFillRequest = input<{ prompt: string; autoSend: boolean; tick: number } | null>(null);

  // Injected services
  agentService = inject(FileAgentService);
  builtInPromptsService = inject(BuiltInPromptsService);
  private clipboard = inject(Clipboard);
  private snackBar = inject(MatSnackBar);
  private i18n = inject(I18nService);
  private appConfig = inject(AppConfigStore);
  private panelState = inject(AgentPanelStateService);
  // Used by openHintDebug (dev-only). The propose-chat-replace dialog used
  // to live here too but moved into FileAgentService (proposer is part of
  // the agent FSM, not the view).
  private matDialog = inject(MatDialog);

  /** Dev-only flag — shows the agent-hint debug button next to built-in-prompts. Resolved eagerly so the @if in template doesn't need to call a method per check. */
  protected readonly isDevMode = isDevMode();

  // Draft input lives on the singleton AgentPanelStateService so unsent text
  // survives panel toggle / PiP open-close (which destroys + recreates this
  // component). Exposed as a getter for ngModel two-way binding.
  get agentPrompt() { return this.panelState.draftPrompt; }

  /**
   * Projects FileAgentService's live "is the loop turning?" state into the
   * indicator shape the trace surface consumes. Null when idle so the surface
   * omits the indicator row.
   */
  protected runningIndicator = computed<AgentRunningIndicator | null>(() => {
    if (!this.agentService.isAgentRunning()) return null;
    return {
      awaitingApproval: this.agentService.awaitingProposerDialog(),
      promptProgress: this.agentService.promptProgress(),
      tokenCount: this.agentService.generatedTokenCount(),
      chunkCount: this.agentService.generatedChunkCount(),
    };
  });

  private initialPromptTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
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
  }

  copyDebugLog(): void {
    const text = formatAgentDebugLog([{
      title: 'AGENT',
      logs: this.agentService.agentLogs(),
      files: this.files(),
    }]);
    this.clipboard.copy(text);
  }

  async runAgent(): Promise<void> {
    const prompt = this.agentPrompt().trim();
    if (!prompt) return;
    this.agentPrompt.set('');
    // The console is a pure view onto FileAgentService — it does NOT hold any
    // agent state (history, logs, FSM) and does NOT capture closures the loop
    // needs. The service builds onFileReplaced + proposers internally from
    // its root deps (AgentPanelStateService, MatDialog) so closing this
    // console mid-turn drops nothing the loop relies on. Initial `files` is
    // sourced from the edit channel when one is registered (file-viewer's
    // Monaco buffer); otherwise the caller-passed snapshot is used (engine's
    // live loadedFiles map for chat-side, dialog's working map for createWorld).
    const channelAtStart = this.panelState.editChannel();
    await this.agentService.runAgent(prompt, {
      files: channelAtStart ? channelAtStart.read() : this.files(),
      chatMessages: this.chatMessages(),
      uiLanguage: this.i18n.currentLang(),
      narrativeLanguage: this.appConfig.outputLanguage(),
      readOnly: this.readOnly(),
      surface: this.surface(),
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

}
