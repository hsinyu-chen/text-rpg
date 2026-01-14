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
    private breakpointObserver = inject(BreakpointObserver);
    private scrollContainer = viewChild<ElementRef>('scrollContainer');

    // Removed chatInput viewChild approach if not strictly needed or kept for other reasons
    // If needed to call startEdit, keep it. Confirmed used in onEditAndResend.
    private chatInput = viewChild<ChatInputComponent>('chatInput');

    userInput = signal('');
    selectedIntent = signal(GAME_INTENTS.ACTION);
    editingMessageId = signal<string | null>(null);
    showScrollButton = false;
    isSidebarOpen = signal(false);

    isMobile = toSignal(
        this.breakpointObserver.observe('(max-width: 900px)').pipe(map(result => result.matches)),
        { initialValue: false }
    );

    sidenavMode = computed(() => this.isMobile() ? 'over' : 'side');

    private observer: MutationObserver | null = null;
    private needsInitialScroll = false;
    private userScrolledUp = false;
    private lastScrollTop = 0;
    private scrollFrameId: number | null = null;
    private destroyRef = inject(DestroyRef);

    constructor() {
        // Init/Loading Jump Effect
        effect(() => {
            const status = this.engine.status();
            if ((status === 'idle' || status === 'generating') && !this.userScrolledUp) {
                this.needsInitialScroll = true;
                setTimeout(() => {
                    if (this.needsInitialScroll) {
                        this.scrollToBottom(true);
                        this.needsInitialScroll = false;
                    }
                }, 100);
            }
        });

        // Smart Follow via MutationObserver
        afterNextRender(() => {
            this.observer = new MutationObserver(() => {
                this.smartScroll();
            });

            const scrollEl = this.scrollContainer();
            if (scrollEl && this.observer) {
                this.observer.observe(scrollEl.nativeElement, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
            }
            setTimeout(() => this.scrollToBottom(true), 200);
        });

        this.destroyRef.onDestroy(() => {
            this.observer?.disconnect();
        });
    }

    checkScroll() {
        const scrollRef = this.scrollContainer();
        if (!scrollRef) return;
        const el = scrollRef.nativeElement;

        const threshold = 300;
        const currentScrollTop = el.scrollTop;
        const distFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

        this.showScrollButton = distFromBottom > threshold;

        if (distFromBottom < 50) {
            this.userScrolledUp = false;
        } else if (currentScrollTop < this.lastScrollTop - 5) {
            this.userScrolledUp = true;
        }

        this.lastScrollTop = currentScrollTop;
    }

    private smartScroll() {
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

        const isGenerating = this.engine.status() === 'generating';
        if (el.scrollHeight <= el.clientHeight) return;

        if (this.needsInitialScroll) {
            this.scrollToBottom(true);
            this.needsInitialScroll = false;
            return;
        }

        const threshold = isGenerating ? 800 : 400;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;

        const shouldFollow = dist < threshold && !this.userScrolledUp;

        if (shouldFollow) {
            const forceInstant = isGenerating || dist < 100;
            this.scrollToBottom(forceInstant);
        }
    }

    scrollToBottom(force = false): void {
        const scrollRef = this.scrollContainer();
        if (!scrollRef) return;
        try {
            const el = scrollRef.nativeElement;
            el.scrollTo({
                top: el.scrollHeight,
                behavior: force ? 'auto' : 'smooth'
            });
            if (force || this.showScrollButton) {
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
        const messages = this.engine.messages();
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
        // Close sidebar on mobile, keep on desktop? 
        // For simplicity, let's keep it open on desktop or follow user pref. 
        // Current requirement implies just jumping. 
        // If "Sidebar" matches the standard behavior, it might stay open.
        // Let's scroll first.

        setTimeout(() => {
            const el = document.getElementById('message-' + id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('highlight-flash');
                setTimeout(() => el.classList.remove('highlight-flash'), 2000);
            }
        }, 100);
    }
}
