import { Component, inject, ElementRef, effect, viewChild, signal, computed, afterNextRender, DestroyRef, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSidenavModule } from '@angular/material/sidenav';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { CommonModule } from '@angular/common';
import { GameEngineService } from '../../core/services/game-engine.service';
import { GameStateService } from '../../core/services/game-state.service';
import { ChatMessage } from '../../core/models/types';
import { GAME_INTENTS } from '../../core/constants/game-intents';
import { ChatMessageComponent } from './components/chat-message/chat-message.component';
import { ChatInputComponent } from './components/chat-input/chat-input.component';
import { TurnUpdatePanelComponent } from './components/turn-update-panel/turn-update-panel.component';

@Component({
    selector: 'app-chat',
    standalone: true,
    imports: [
        CommonModule,
        MatButtonModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatSidenavModule,
        ChatMessageComponent,
        ChatInputComponent,
        TurnUpdatePanelComponent
    ],
    templateUrl: './chat.component.html',
    styleUrl: './chat.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    private breakpointObserver = inject(BreakpointObserver);
    private destroyRef = inject(DestroyRef);

    private scrollContainer = viewChild<ElementRef>('scrollContainer');
    private contentWrapper = viewChild<ElementRef>('contentWrapper');
    private chatInput = viewChild<ChatInputComponent>('chatInput');

    userInput = signal('');
    selectedIntent = signal(GAME_INTENTS.ACTION);
    editingMessageId = signal<string | null>(null);
    showScrollButton = signal(false);
    isSidebarOpen = signal(false);

    isMobile = toSignal(
        this.breakpointObserver.observe('(max-width: 900px)').pipe(map(result => result.matches)),
        { initialValue: false }
    );

    sidenavMode = computed(() => this.isMobile() ? 'over' : 'side');

    private resizeObserver: ResizeObserver | null = null;
    private userScrolledUp = false;
    private lastScrollTop = 0;
    private scrollFrameId: number | null = null;

    constructor() {
        // Init/Loading Jump Effect
        effect(() => {
            const status = this.state.status();
            // When going to idle or generating (and not scrolled up), ensure we are at bottom.
            if ((status === 'idle' || status === 'generating') && !this.userScrolledUp) {
                // We use a small timeout to allow new elements to render before scrolling
                setTimeout(() => {
                    this.scrollToBottom(true);
                }, 50);
            }
        });

        afterNextRender(() => {
            this.initScrollObservers();
        });

        this.destroyRef.onDestroy(() => {
            this.resizeObserver?.disconnect();
            if (this.scrollFrameId) {
                cancelAnimationFrame(this.scrollFrameId);
            }
        });
    }

    private initScrollObservers() {
        const scrollEl = this.scrollContainer()?.nativeElement;
        const contentEl = this.contentWrapper()?.nativeElement;

        if (!scrollEl || !contentEl) return;

        // 1. Scroll Listener (Access user scroll state)
        scrollEl.addEventListener('scroll', () => {
            this.checkScroll(scrollEl);
        }, { passive: true }); // passive improves scroll performance

        // 2. Resize Observer (Detect content changes)
        this.resizeObserver = new ResizeObserver(() => {
            this.smartScroll();
        });
        this.resizeObserver.observe(contentEl);
    }

    checkScroll(el: HTMLElement) {
        // Run light check logic
        const threshold = 300;
        const currentScrollTop = el.scrollTop;
        const distFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

        const show = distFromBottom > threshold;

        // Detect user intent (scrolling up vs down)
        if (distFromBottom < 50) {
            this.userScrolledUp = false;
        } else if (currentScrollTop < this.lastScrollTop - 5) {
            this.userScrolledUp = true;
        }

        this.lastScrollTop = currentScrollTop;

        // Update signal only if changed
        if (this.showScrollButton() !== show) {
            this.showScrollButton.set(show);
        }
    }

    private smartScroll() {
        // Debounce with RAF to avoid thrashing if multiple resize events fire
        if (this.scrollFrameId) {
            cancelAnimationFrame(this.scrollFrameId);
        }

        this.scrollFrameId = requestAnimationFrame(() => {
            this.scrollFrameId = null;
            this.performSmartScroll();
        });
    }

    private performSmartScroll() {
        const scrollRef = this.scrollContainer();
        if (!scrollRef) return;
        const el = scrollRef.nativeElement;

        // Logic: specific thresholds for when to auto-scroll
        const isGenerating = this.state.status() === 'generating';

        // If content is smaller than view, nothing to do
        if (el.scrollHeight <= el.clientHeight) return;

        // More generous threshold during generation
        const threshold = isGenerating ? 800 : 400;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;

        const shouldFollow = dist < threshold && !this.userScrolledUp;

        if (shouldFollow) {
            // Instant scroll if very close or generating to keep up with stream
            const forceInstant = isGenerating || dist < 100;
            this.scrollToBottom(forceInstant);
        }
    }

    scrollToBottom(force = false): void {
        const scrollRef = this.scrollContainer();
        if (!scrollRef) return;

        // This is a UI update
        const el = scrollRef.nativeElement;
        try {
            el.scrollTo({
                top: el.scrollHeight,
                behavior: force ? 'auto' : 'smooth'
            });

            // Allow auto-scroll to resume if we forced it down
            if (force) {
                this.userScrolledUp = false;
            }
        } catch { /* ignore */ }
    }

    onEditAndResend(msg: ChatMessage) {
        this.editingMessageId.set(msg.id);
        const intent = msg.intent || GAME_INTENTS.ACTION;
        const content = msg.content.replace(/^<[^>]+>/, '').trim();
        this.chatInput()?.startEdit(intent, content);
    }

    isLastUserMessage(id: string): boolean {
        const messages = this.state.messages();
        let lastUser: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastUser = messages[i];
                break;
            }
        }
        return id === lastUser?.id;
    }

    toggleSidebar() {
        this.isSidebarOpen.update(v => !v);
    }

    onJumpToMessage(id: string) {
        setTimeout(() => {
            const el = document.getElementById('message-' + id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('highlight-flash');
                setTimeout(() => el.classList.remove('highlight-flash'), 2000);
            }
        }, 50);
    }
}
