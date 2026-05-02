import { Injectable, signal, effect, inject, isDevMode, DestroyRef } from '@angular/core';
import { SessionService } from '../session.service';
import { GameStateService } from '../game-state.service';
import { GameEngineService } from '../game-engine.service';
import { GAME_INTENTS } from '../../constants/game-intents';
import { ChatMessage } from '../../models/types';

/**
 * Dev-only relay client. Connects to a local BridgeServer (sibling repo
 * `TextRPG_TestBridge`) over WebSocket so an external agent can drive the
 * running app via HTTP. No-op in production builds — gated by isDevMode().
 *
 * Handles three server commands:
 *   send_action — runs a real GameEngineService.sendMessage turn and replies
 *                 with the same pair JSON shape as the in-app "copy" feature.
 *   list        — last N messages (id / role / 80-char preview / intent).
 *   delete      — removes a message; alsoDeletePair (default true) also nukes
 *                 the matching user/model sibling so a turn can be re-run.
 */

const STORAGE_URL = 'app_debug_bridge_url';
const STORAGE_ENABLED = 'app_debug_bridge_enabled';
const HEARTBEAT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type BridgeStatus = 'idle' | 'connecting' | 'connected' | 'error';

interface BridgeFrame {
    type?: string;
    requestId?: string;
}

interface SendActionFrame extends BridgeFrame {
    userInput?: string;
    intent?: string | null;
}

interface ListFrame extends BridgeFrame {
    limit?: number;
}

interface DeleteFrame extends BridgeFrame {
    messageId?: string;
    alsoDeletePair?: boolean;
}

@Injectable({ providedIn: 'root' })
export class BridgeService {
    private session = inject(SessionService);
    private state = inject(GameStateService);
    private engine = inject(GameEngineService);
    private destroyRef = inject(DestroyRef);

    private static readonly VALID_INTENTS: ReadonlySet<string> = new Set(Object.values(GAME_INTENTS));

    readonly url = signal(localStorage.getItem(STORAGE_URL) ?? '');
    readonly enabled = signal(localStorage.getItem(STORAGE_ENABLED) === 'true');
    readonly status = signal<BridgeStatus>('idle');
    readonly lastError = signal<string | null>(null);

    private ws: WebSocket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = RECONNECT_MIN_MS;
    private intentionalClose = false;

    setUrl(url: string): void {
        this.url.set(url);
        localStorage.setItem(STORAGE_URL, url);
    }

    setEnabled(enabled: boolean): void {
        this.enabled.set(enabled);
        localStorage.setItem(STORAGE_ENABLED, String(enabled));
    }

    constructor() {
        if (!isDevMode()) return;

        effect(() => {
            const url = this.url().trim();
            const enabled = this.enabled();
            this.intentionalClose = true;
            this.teardown();
            if (enabled && url) {
                this.intentionalClose = false;
                this.reconnectDelay = RECONNECT_MIN_MS;
                this.connect(url);
            } else {
                this.status.set('idle');
                this.lastError.set(null);
            }
        });

        this.destroyRef.onDestroy(() => {
            this.intentionalClose = true;
            this.teardown();
        });
    }

    private connect(url: string): void {
        this.status.set('connecting');
        this.lastError.set(null);
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            this.lastError.set((e as Error).message);
            this.status.set('error');
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.addEventListener('open', () => {
            if (this.ws !== ws) return;
            this.status.set('connected');
            this.reconnectDelay = RECONNECT_MIN_MS;
            this.send({
                type: 'hello',
                appVersion: 'dev',
                bookLoaded: this.session.currentBookId() !== null,
            });
            this.startHeartbeat();
        });

        ws.addEventListener('message', event => {
            if (this.ws !== ws) return;
            // Server only sends text frames; defensive guard so a stray binary frame
            // doesn't get coerced through `JSON.parse(<Blob>)`.
            if (typeof event.data !== 'string') {
                console.warn('[bridge] non-text frame', event.data);
                return;
            }
            let frame: BridgeFrame;
            try {
                frame = JSON.parse(event.data) as BridgeFrame;
            } catch {
                console.warn('[bridge] non-json frame', event.data);
                return;
            }
            this.routeMessage(frame);
        });

        ws.addEventListener('close', () => {
            if (this.ws !== ws) return;
            this.stopHeartbeat();
            this.ws = null;
            if (this.intentionalClose) {
                this.status.set('idle');
                return;
            }
            this.status.set('error');
            this.scheduleReconnect();
        });

        ws.addEventListener('error', () => {
            if (this.ws !== ws) return;
            this.lastError.set('websocket error');
        });
    }

    private routeMessage(frame: BridgeFrame): void {
        const { type } = frame;
        switch (type) {
            case 'send_action':
                void this.handleSendAction(frame as SendActionFrame);
                break;
            case 'list':
                this.handleList(frame as ListFrame);
                break;
            case 'delete':
                void this.handleDelete(frame as DeleteFrame);
                break;
            default:
                console.warn('[bridge] unknown frame type', type, frame);
        }
    }

    private async handleSendAction(frame: SendActionFrame): Promise<void> {
        const { requestId, userInput, intent: rawIntent } = frame;
        if (!requestId) return;
        if (typeof userInput !== 'string') {
            this.send({ type: 'action_error', requestId, error: 'invalid_userInput' });
            return;
        }
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        const intent = BridgeService.normalizeIntent(rawIntent);
        // Snapshot ids before the await so we can verify the pair we surface is genuinely new.
        // Engine no-ops (e.g. empty userInput on ACTION/SYSTEM/FAST_FORWARD) return without
        // touching status or messages; without this guard we would silently report the
        // *previous* turn's pair as a fresh result.
        const existingIds = new Set(this.state.messages().map(m => m.id));

        try {
            await this.engine.sendMessage(userInput, intent ? { intent } : undefined);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'unknown';
            this.send({ type: 'action_error', requestId, error: msg });
            return;
        }

        if (this.state.status() === 'error') {
            this.send({ type: 'action_error', requestId, error: 'generation_failed' });
            return;
        }

        // Walk from the end to find the most recent user→model adjacency. Index-from-`before`
        // is unreliable because the user can delete messages in the UI mid-turn.
        const all = this.state.messages();
        let modelMsg: ChatMessage | null = null;
        let userMsg: ChatMessage | null = null;
        for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].role === 'model') {
                modelMsg = all[i];
                if (i > 0 && all[i - 1].role === 'user') userMsg = all[i - 1];
                break;
            }
        }
        if (!modelMsg || !userMsg || existingIds.has(modelMsg.id)) {
            this.send({ type: 'action_error', requestId, error: 'no_pair_produced' });
            return;
        }

        const pair = {
            user: {
                intent: userMsg.intent,
                content: userMsg.content,
            },
            model: {
                thought: modelMsg.thought,
                analysis: modelMsg.analysis,
                summary: modelMsg.summary,
                character_log: modelMsg.character_log,
                inventory_log: modelMsg.inventory_log,
                quest_log: modelMsg.quest_log,
                world_log: modelMsg.world_log,
                content: modelMsg.content,
            },
        };

        this.send({
            type: 'action_complete',
            requestId,
            messageId: modelMsg.id,
            userMessageId: userMsg.id,
            pair,
        });
    }

    private handleList(frame: ListFrame): void {
        const { requestId, limit: rawLimit } = frame;
        if (!requestId) return;
        const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
        const all = this.state.messages();
        const slice = all.slice(-limit);
        const messages = slice.map(m => ({
            id: m.id,
            role: m.role,
            headPreview: (m.content ?? '').slice(0, 80),
            intent: m.intent,
        }));
        this.send({ type: 'list_response', requestId, messages });
    }

    private async handleDelete(frame: DeleteFrame): Promise<void> {
        const { requestId, messageId, alsoDeletePair } = frame;
        if (!requestId) return;
        if (typeof messageId !== 'string') {
            this.send({ type: 'action_error', requestId, error: 'invalid_messageId' });
            return;
        }
        const all = this.state.messages();
        const idx = all.findIndex(m => m.id === messageId);
        if (idx === -1) {
            this.send({ type: 'delete_response', requestId, deleted: [] });
            return;
        }

        const target = all[idx];
        const ids: string[] = [target.id];
        if (alsoDeletePair !== false) {
            if (target.role === 'model' && idx > 0 && all[idx - 1].role === 'user') {
                ids.unshift(all[idx - 1].id);
            } else if (target.role === 'user' && idx + 1 < all.length && all[idx + 1].role === 'model') {
                ids.push(all[idx + 1].id);
            }
        }

        for (const id of ids) {
            await this.engine.deleteMessage(id);
        }
        this.send({ type: 'delete_response', requestId, deleted: ids });
    }

    private static normalizeIntent(raw: string | null | undefined): string | undefined {
        if (!raw) return undefined;
        const lower = raw.toLowerCase();
        return BridgeService.VALID_INTENTS.has(lower) ? lower : undefined;
    }

    private send(payload: object): void {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(payload));
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => this.send({ type: 'heartbeat' }), HEARTBEAT_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            const url = this.url().trim();
            if (!this.intentionalClose && this.enabled() && url) {
                this.connect(url);
            }
        }, delay);
    }

    private teardown(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopHeartbeat();
        if (this.ws) {
            try { this.ws.close(); } catch { /* already closed */ }
            this.ws = null;
        }
    }
}
