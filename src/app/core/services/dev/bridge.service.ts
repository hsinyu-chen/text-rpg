import { Injectable, signal, effect, inject, isDevMode, DestroyRef } from '@angular/core';
import { SessionService } from '../session.service';
import { GameStateService } from '../game-state.service';
import { GameEngineService } from '../game-engine.service';
import { InjectionService } from '../injection.service';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { ConfigService } from '../config.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { LLMConfigService } from '../llm-config.service';
import { AppConfigStore, AppConfigShape } from '../app-config-store';
import { BookRepository } from '../storage/book.repository';
import { FileRepository } from '../storage/file.repository';
import { isValidInterfaceLanguage } from '../../i18n/ui-locales';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { ChatMessage, Scenario } from '@app/core/models/types';
import { WINDOW } from '@app/core/tokens/window.token';
import { KVStore } from '../kv/kv-store';
import { isSystemMainCompatible } from '../profile-compat';

/**
 * Dev-only relay client. Connects to a local BridgeServer (sibling repo
 * `TextRPG_TestBridge`) over WebSocket so an external agent can drive the
 * running app via HTTP. No-op in production builds — gated by isDevMode().
 *
 * Frame types handled:
 *   send_action       — real GameEngineService.sendMessage turn + pair reply
 *   list              — last N messages (id / role / preview)
 *   delete            — removes a message ± its pair sibling
 *   reload            — triggers window.location.reload()
 *   profile_list      — built-in + user profiles with per-profile compat tag
 *   profile_get_active— active id + meta + compat
 *   profile_switch    — switches active profile by id
 *   config_get        — full AppConfigShape snapshot + modelId (read-only echo)
 *   config_set        — partial-patch writes covering every AppConfigShape
 *                       field (per-field validator); invalid keys are reported
 *                       under `rejected` rather than silently dropped
 *   kb_list           — knowledge-base files loaded in the active book
 *                       (filename + content size + tokenCount)
 *   kb_read           — full content of one KB file by filename
 *   book_list         — every persisted Book (id / name / messageCount /
 *                       isActive flag); does NOT include messages — agents
 *                       fetch those via `list` against the active Book
 *   book_get_active   — id + name + messageCount of the currently loaded Book
 *   book_fork         — clones the active Book truncated to a target message
 *                       (inclusive), switches to the new Book
 *   book_switch       — loads a different Book as the active session
 *   llm_list          — every LLM profile + per-profile `isLocal` flag
 *                       (= provider's `LLMProviderCapabilities.isLocalProvider`,
 *                       used as the paid/free proxy for the confirm guard)
 *   llm_get_active    — active LLM profile id + name + provider + modelId + isLocal
 *   llm_switch        — switch active LLM profile by id. Requires
 *                       `confirmPaid: true` when the target profile is NOT
 *                       local — guards against accidentally driving turns
 *                       through a paid model. Local→local & local→paid w/
 *                       confirm & paid→paid w/ confirm all pass; paid w/o
 *                       confirm returns `paid_requires_confirm` + target meta
 *   book_repair_kb    — fill in scenario files missing from the active Book's
 *                       KB. Only ADDS missing filenames (per the named
 *                       scenario's manifest); existing KB entries are
 *                       preserved untouched. Recovery path for books built
 *                       from a scenario whose manifest was incomplete at
 *                       creation time (e.g. stale scenarios.json filenames).
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
    full?: boolean;
}

interface DeleteFrame extends BridgeFrame {
    messageId?: string;
    alsoDeletePair?: boolean;
}

interface ReloadFrame extends BridgeFrame {
    // The Location.reload(force) parameter is non-standard and ignored by
    // modern browsers, but accept it for forward-compat / explicit intent.
    force?: boolean;
}

interface ProfileSwitchFrame extends BridgeFrame {
    id?: string;
}

// Any AppConfigShape field; handleConfigSet validates per-field and reports
// unknown / mistyped keys via `rejected` in the response.
type ConfigSetFrame = BridgeFrame & Record<string, unknown>;

interface KbReadFrame extends BridgeFrame {
    filename?: string;
}

interface BookForkFrame extends BridgeFrame {
    messageId?: string;
    newName?: string;
}

interface BookSwitchFrame extends BridgeFrame {
    id?: string;
}

interface LLMSwitchFrame extends BridgeFrame {
    id?: string;
    confirmPaid?: boolean;
}

interface BookRepairKbFrame extends BridgeFrame {
    scenarioId?: string;
}

type FieldValidator<K extends keyof AppConfigShape> = (raw: unknown) => AppConfigShape[K] | undefined;

const BRIDGE_SETTABLE_FIELDS: { [K in keyof AppConfigShape]?: FieldValidator<K> } = {
    engineMode:             v => (v === 'single' || v === 'two-call') ? v : undefined,
    outputLanguage:         v => (typeof v === 'string' && v.length > 0) ? v : undefined,
    fontSize:               v => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : undefined,
    fontFamily:             v => (typeof v === 'string' && v.length > 0) ? v : undefined,
    screensaverType:        v => (v === 'invaders' || v === 'code') ? v : undefined,
    currency:               v => (typeof v === 'string' && v.length > 0) ? v : undefined,
    enableConversion:       v => typeof v === 'boolean' ? v : undefined,
    idleOnBlur:             v => typeof v === 'boolean' ? v : undefined,
    enableAdultDeclaration: v => typeof v === 'boolean' ? v : undefined,
    exchangeRate:           v => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : undefined,
    interfaceLanguage:      v => isValidInterfaceLanguage(v) ? v : undefined,
    smartContextTurns:      v => (typeof v === 'number' && Number.isInteger(v) && v > 0) ? v : undefined,
};

@Injectable({ providedIn: 'root' })
export class BridgeService {
    private session = inject(SessionService);
    private state = inject(GameStateService);
    private engine = inject(GameEngineService);
    private injection = inject(InjectionService);
    private registry = inject(PromptProfileRegistryService);
    private config = inject(ConfigService);
    private appConfig = inject(AppConfigStore);
    private providerRegistry = inject(LLMProviderRegistryService);
    private llmConfig = inject(LLMConfigService);
    private destroyRef = inject(DestroyRef);
    private win = inject(WINDOW);
    private kv = inject(KVStore);
    private books = inject(BookRepository);
    private files = inject(FileRepository);

    private static readonly VALID_INTENTS: ReadonlySet<string> = new Set(Object.values(GAME_INTENTS));

    readonly url = signal(this.kv.get(STORAGE_URL) ?? '');
    readonly enabled = signal(this.kv.get(STORAGE_ENABLED) === 'true');
    readonly status = signal<BridgeStatus>('idle');
    readonly lastError = signal<string | null>(null);

    private ws: WebSocket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = RECONNECT_MIN_MS;
    private intentionalClose = false;

    setUrl(url: string): void {
        this.url.set(url);
        this.kv.set(STORAGE_URL, url);
    }

    /**
     * One-shot WebSocket dial to verify a URL is reachable, without disturbing the
     * active connection. Resolves to `{ ok: true }` on `open`, `{ ok: false, error }`
     * on a constructor throw, the `error` event, or after `timeoutMs`.
     */
    async testConnection(url: string, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
        return new Promise(resolve => {
            let probe: WebSocket;
            try {
                probe = new WebSocket(url);
            } catch (e) {
                resolve({ ok: false, error: e instanceof Error ? e.message : 'invalid url' });
                return;
            }
            const timer = setTimeout(() => {
                try { probe.close(); } catch { /* already closed */ }
                resolve({ ok: false, error: 'timeout' });
            }, timeoutMs);
            probe.addEventListener('open', () => {
                clearTimeout(timer);
                try { probe.close(); } catch { /* already closed */ }
                resolve({ ok: true });
            }, { once: true });
            probe.addEventListener('error', () => {
                clearTimeout(timer);
                try { probe.close(); } catch { /* already closed */ }
                resolve({ ok: false, error: 'connection failed' });
            }, { once: true });
        });
    }

    setEnabled(enabled: boolean): void {
        this.enabled.set(enabled);
        this.kv.set(STORAGE_ENABLED, String(enabled));
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
            case 'reload':
                void this.handleReload(frame as ReloadFrame);
                break;
            case 'profile_list':
                void this.handleProfileList(frame);
                break;
            case 'profile_get_active':
                this.handleProfileGetActive(frame);
                break;
            case 'profile_switch':
                void this.handleProfileSwitch(frame as ProfileSwitchFrame);
                break;
            case 'config_get':
                this.handleConfigGet(frame);
                break;
            case 'config_set':
                void this.handleConfigSet(frame as ConfigSetFrame);
                break;
            case 'kb_list':
                this.handleKbList(frame);
                break;
            case 'kb_read':
                this.handleKbRead(frame as KbReadFrame);
                break;
            case 'book_list':
                void this.handleBookList(frame);
                break;
            case 'book_get_active':
                void this.handleBookGetActive(frame);
                break;
            case 'book_fork':
                void this.handleBookFork(frame as BookForkFrame);
                break;
            case 'book_switch':
                void this.handleBookSwitch(frame as BookSwitchFrame);
                break;
            case 'llm_list':
                this.handleLLMList(frame);
                break;
            case 'llm_get_active':
                this.handleLLMGetActive(frame);
                break;
            case 'llm_switch':
                this.handleLLMSwitch(frame as LLMSwitchFrame);
                break;
            case 'book_repair_kb':
                void this.handleBookRepairKb(frame as BookRepairKbFrame);
                break;
            default:
                console.warn('[bridge] unknown frame type', type, frame);
        }
    }

    private async handleBookList(frame: BridgeFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        const all = await this.books.list();
        const activeId = this.session.currentBookId();
        // The active Book's in-memory messages can be ahead of what's on disk
        // (edits not yet flushed). Surface the live count for it so an agent
        // doesn't see a stale snapshot when polling right after a turn.
        const liveMessageCount = this.state.messages().length;
        const books = all.map(b => ({
            id: b.id,
            name: b.name,
            collectionId: b.collectionId,
            createdAt: b.createdAt,
            lastActiveAt: b.lastActiveAt,
            messageCount: b.id === activeId ? liveMessageCount : b.messages.length,
            isActive: b.id === activeId,
        }));
        this.send({ type: 'book_list_response', requestId, activeId, books });
    }

    private async handleBookGetActive(frame: BridgeFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        const id = this.session.currentBookId();
        if (!id) {
            this.send({ type: 'book_get_active_response', requestId, id: null });
            return;
        }
        const book = await this.books.get(id);
        this.send({
            type: 'book_get_active_response',
            requestId,
            id,
            name: book?.name ?? null,
            collectionId: book?.collectionId ?? null,
            messageCount: this.state.messages().length,
            lastActiveAt: book?.lastActiveAt ?? null,
        });
    }

    private async handleBookFork(frame: BookForkFrame): Promise<void> {
        const { requestId, messageId, newName } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        const sourceId = this.session.currentBookId();
        if (!sourceId) {
            this.send({ type: 'action_error', requestId, error: 'no_active_book' });
            return;
        }
        if (typeof messageId !== 'string' || !messageId) {
            this.send({ type: 'action_error', requestId, error: 'invalid_messageId' });
            return;
        }
        if (!this.state.messages().some(m => m.id === messageId)) {
            this.send({ type: 'action_error', requestId, error: 'message_not_found' });
            return;
        }
        let name = (typeof newName === 'string' ? newName.trim() : '');
        if (!name) {
            const source = await this.books.get(sourceId);
            name = `${source?.name ?? 'Book'} (fork)`;
        }
        try {
            const newBookId = await this.session.forkBookFromMessage(sourceId, messageId, name);
            this.send({
                type: 'book_fork_response',
                requestId,
                newBookId,
                name,
                switched: true,
            });
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            this.send({ type: 'action_error', requestId, error: 'fork_failed', detail });
        }
    }

    private async handleBookSwitch(frame: BookSwitchFrame): Promise<void> {
        const { requestId, id } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        if (typeof id !== 'string' || !id) {
            this.send({ type: 'action_error', requestId, error: 'invalid_id' });
            return;
        }
        const book = await this.books.get(id);
        if (!book) {
            this.send({ type: 'action_error', requestId, error: 'unknown_book' });
            return;
        }
        try {
            await this.session.loadBook(id);
            this.send({
                type: 'book_switch_response',
                requestId,
                activeBookId: id,
                name: book.name,
                messageCount: this.state.messages().length,
            });
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            this.send({ type: 'action_error', requestId, error: 'switch_failed', detail });
        }
    }

    // getCapabilities() may be config-dependent at runtime (e.g. some providers
    // gate caching by additionalSettings), but `isLocalProvider` is a fixed
    // property of the provider class — safe to read without supplying config.
    private isProfileLocal(providerName: string): boolean {
        return this.providerRegistry.getProvider(providerName)?.getCapabilities()?.isLocalProvider ?? false;
    }

    private llmProfileMeta(p: { id: string; name: string; provider: string; settings: { modelId?: string } }) {
        return {
            id: p.id,
            name: p.name,
            provider: p.provider,
            modelId: p.settings.modelId ?? null,
            isLocal: this.isProfileLocal(p.provider),
        };
    }

    private handleLLMList(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        const profiles = this.llmConfig.profiles().map(p => this.llmProfileMeta(p));
        this.send({
            type: 'llm_list_response',
            requestId,
            active: this.llmConfig.activeProfileId(),
            profiles,
        });
    }

    private handleLLMGetActive(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        const active = this.llmConfig.activeProfile();
        if (!active) {
            this.send({ type: 'llm_get_active_response', requestId, id: null });
            return;
        }
        this.send({ type: 'llm_get_active_response', requestId, ...this.llmProfileMeta(active) });
    }

    private handleLLMSwitch(frame: LLMSwitchFrame): void {
        const { requestId, id, confirmPaid } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        if (typeof id !== 'string' || !id) {
            this.send({ type: 'action_error', requestId, error: 'invalid_id' });
            return;
        }
        const target = this.llmConfig.profiles().find(p => p.id === id);
        if (!target) {
            this.send({ type: 'action_error', requestId, error: 'unknown_profile' });
            return;
        }
        const meta = this.llmProfileMeta(target);
        if (!meta.isLocal && confirmPaid !== true) {
            this.send({ type: 'action_error', requestId, error: 'paid_requires_confirm', target: meta });
            return;
        }
        this.llmConfig.setActiveProfileId(id);
        this.send({ type: 'llm_switch_response', requestId, ...meta });
    }

    private async handleBookRepairKb(frame: BookRepairKbFrame): Promise<void> {
        const { requestId, scenarioId } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        const bookId = this.session.currentBookId();
        if (!bookId) {
            this.send({ type: 'action_error', requestId, error: 'no_active_book' });
            return;
        }
        if (typeof scenarioId !== 'string' || !scenarioId) {
            this.send({ type: 'action_error', requestId, error: 'invalid_scenarioId' });
            return;
        }

        let scenarios: Scenario[];
        try {
            const resp = await fetch('assets/system_files/scenario/scenarios.json');
            if (!resp.ok) throw new Error(`scenarios.json HTTP ${resp.status}`);
            scenarios = await resp.json() as Scenario[];
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            this.send({ type: 'action_error', requestId, error: 'scenarios_json_unreachable', detail });
            return;
        }
        const scenario = scenarios.find(s => s.id === scenarioId);
        if (!scenario) {
            this.send({ type: 'action_error', requestId, error: 'unknown_scenario', scenarioId });
            return;
        }

        const current = this.state.loadedFiles();
        const newMap = new Map(current);
        const updates: { filename: string; key: string; status: 'added' | 'skipped_existing' | 'fetch_failed'; detail?: string }[] = [];

        for (const [key, filename] of Object.entries(scenario.files)) {
            if (current.has(filename)) {
                updates.push({ key, filename, status: 'skipped_existing' });
                continue;
            }
            try {
                const fileResp = await fetch(`${scenario.baseDir}/${filename}`);
                if (!fileResp.ok) throw new Error(`HTTP ${fileResp.status}`);
                const content = await fileResp.text();
                await this.files.save(filename, content);
                newMap.set(filename, content);
                updates.push({ key, filename, status: 'added' });
            } catch (e) {
                const detail = e instanceof Error ? e.message : 'unknown';
                updates.push({ key, filename, status: 'fetch_failed', detail });
            }
        }

        const added = updates.filter(u => u.status === 'added').length;
        if (added > 0) {
            this.state.loadedFiles.set(newMap);
            // Persist the in-memory KB into the active Book record so the
            // recovered files survive a reload (FileRepository.save handles
            // the per-file IDB write; this flush rewrites the Book aggregate).
            await this.session.saveCurrentSessionToBook({ bumpTimestamp: false });
        }

        this.send({
            type: 'book_repair_kb_response',
            requestId,
            bookId,
            scenarioId,
            addedCount: added,
            updates,
        });
    }

    private async handleProfileList(frame: BridgeFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        const all = [...this.registry.builtInProfiles(), ...this.registry.userProfiles()];
        const profiles = await Promise.all(all.map(async p => {
            let compat: 'compatible' | 'legacy' | 'unknown' = 'unknown';
            try {
                const content = await this.injection.getResolvedProfilePrompt('system_main', p.id);
                compat = isSystemMainCompatible(content) ? 'compatible' : 'legacy';
            } catch { /* leave unknown */ }
            return {
                id: p.id,
                displayName: p.displayName ?? p.id,
                isBuiltIn: p.isBuiltIn,
                baseProfileId: p.baseProfileId,
                compat,
            };
        }));
        this.send({ type: 'profile_list_response', requestId, active: this.state.activePromptProfile(), profiles });
    }

    private handleProfileGetActive(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        const id = this.state.activePromptProfile();
        const profile = this.registry.get(id);
        this.send({
            type: 'profile_get_active_response',
            requestId,
            id,
            displayName: profile?.displayName ?? id,
            isBuiltIn: profile?.isBuiltIn ?? false,
            baseProfileId: profile?.baseProfileId ?? null,
            compat: this.state.activeProfileCompat(),
        });
    }

    private async handleProfileSwitch(frame: ProfileSwitchFrame): Promise<void> {
        const { requestId, id } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            // Switching mid-turn would swap injections under a live engine call.
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        if (typeof id !== 'string' || !id) {
            this.send({ type: 'action_error', requestId, error: 'invalid_id' });
            return;
        }
        if (!this.registry.get(id)) {
            this.send({ type: 'action_error', requestId, error: 'unknown_profile' });
            return;
        }
        await this.injection.switchProfile(id);
        // switchProfile silently no-ops on unknown id; surface the actual
        // post-switch state so the caller can detect a mid-flight delete race.
        const active = this.state.activePromptProfile();
        if (active !== id) {
            this.send({ type: 'action_error', requestId, error: 'switch_failed', active });
            return;
        }
        this.send({
            type: 'profile_switch_response',
            requestId,
            active,
            compat: this.state.activeProfileCompat(),
        });
    }

    private handleKbList(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        const files = this.state.loadedFiles();
        const tokens = this.state.fileTokenCounts();
        const entries = Array.from(files.entries()).map(([filename, content]) => ({
            filename,
            size: content.length,
            tokenCount: tokens.get(filename) ?? null,
        }));
        this.send({ type: 'kb_list_response', requestId, files: entries });
    }

    private handleKbRead(frame: KbReadFrame): void {
        const { requestId, filename } = frame;
        if (!requestId) return;
        if (typeof filename !== 'string' || !filename) {
            this.send({ type: 'action_error', requestId, error: 'invalid_filename' });
            return;
        }
        const content = this.state.loadedFiles().get(filename);
        if (content === undefined) {
            this.send({ type: 'action_error', requestId, error: 'not_found' });
            return;
        }
        this.send({
            type: 'kb_read_response',
            requestId,
            filename,
            content,
            tokenCount: this.state.fileTokenCounts().get(filename) ?? null,
        });
    }

    private handleConfigGet(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        this.send({
            type: 'config_get_response',
            requestId,
            ...this.appConfig.snapshot(),
            modelId: this.providerRegistry.getActiveModelId() || null,
        });
    }

    private async handleConfigSet(frame: ConfigSetFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            // engineMode swap mid-turn could change dispatch under a live call.
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        const patch: Partial<AppConfigShape> = {};
        const rejected: string[] = [];
        for (const key of Object.keys(frame)) {
            if (key === 'type' || key === 'requestId') continue;
            const validator = BRIDGE_SETTABLE_FIELDS[key as keyof AppConfigShape];
            if (!validator) {
                rejected.push(key);
                continue;
            }
            const value = (validator as (raw: unknown) => unknown)(frame[key]);
            if (value === undefined) {
                rejected.push(key);
                continue;
            }
            (patch as Record<string, unknown>)[key] = value;
        }
        if (Object.keys(patch).length === 0) {
            this.send({ type: 'action_error', requestId, error: 'no_valid_fields', rejected });
            return;
        }
        await this.config.saveConfig(patch);
        this.send({
            type: 'config_set_response',
            requestId,
            applied: this.appConfig.snapshot(),
            rejected: rejected.length > 0 ? rejected : undefined,
        });
    }

    private async handleReload(frame: ReloadFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        // Ack first — once reload() runs, the WS tears down and any later
        // frame would be lost. Tiny delay ensures the response flushes.
        this.send({ type: 'reload_response', requestId, ok: true });
        await new Promise(r => setTimeout(r, 50));
        this.win.location.reload();
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
        const { requestId, limit: rawLimit, full } = frame;
        if (!requestId) return;
        const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
        const all = this.state.messages();
        const slice = all.slice(-limit);
        const messages = full
            ? slice.map(m => ({
                id: m.id,
                role: m.role,
                intent: m.intent,
                content: m.content,
                analysis: m.analysis,
                thought: m.thought,
                summary: m.summary,
                character_log: m.character_log,
                inventory_log: m.inventory_log,
                quest_log: m.quest_log,
                world_log: m.world_log,
            }))
            : slice.map(m => ({
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

        await this.engine.deleteMessages(ids);
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
