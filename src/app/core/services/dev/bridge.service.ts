import {
    Injectable, signal, effect, inject, DestroyRef,
    EnvironmentInjector, createEnvironmentInjector
} from '@angular/core';
import { FILE_VIEWER_OPENER } from './file-viewer-opener.token';
import { FileAgentService } from '../file-agent/file-agent.service';
import { FileAgentSettingsStore } from '../file-agent/file-agent-settings.store';
import { I18nService } from '@app/core/i18n';
import { SessionService } from '../session.service';
import { GameStateService } from '../game-state.service';
import { GameEngineService } from '../game-engine.service';
import { InjectionService, ALL_PROMPT_TYPES, type PromptType } from '../injection.service';
import { PromptRepository } from '../storage/prompt.repository';
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
import { AgentHintRegistry } from '../agent-hints/agent-hints.registry';
import { AgentHintDebugDialogComponent } from '../agent-hints/agent-hint-debug-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { DiskProfileSyncService } from '../sync/disk-profile-sync.service';

/**
 * Relay client. Connects to a local BridgeServer (sibling repo
 * `TextRPG_TestBridge`) over WebSocket so an external agent can drive the
 * running app via HTTP. Available in all builds — opt-in by toggling
 * `enabled` from the Settings dialog (default off). The `agent_eval` frame
 * is additionally gated by a separate Settings toggle (default off).
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
 *   file_agent_get_profile
 *                     — active file-agent LLM profile (independent of the
 *                       chat-side `llm_get_active`). Returns the same meta
 *                       shape; id is null if no profile is configured.
 *   file_agent_set_profile
 *                     — switch the file-agent LLM profile. Same paid-guard
 *                       semantics as `llm_switch`. Lets A/B testing drive
 *                       different models on chat vs file-agent without
 *                       touching the UI.
 *   book_repair_kb    — fill in scenario files missing from the active Book's
 *                       KB. Only ADDS missing filenames (per the named
 *                       scenario's manifest); existing KB entries are
 *                       preserved untouched. Recovery path for books built
 *                       from a scenario whose manifest was incomplete at
 *                       creation time (e.g. stale scenarios.json filenames).
 *   agent_open_file_viewer
 *                     — opens the File Viewer dialog (full read+write KB
 *                       editor) with the agent panel pre-opened so the user
 *                       can interrogate / drive the file-agent on a specific
 *                       file. `initialFile` selects which file is active.
 *   agent_open_chat_agent_panel
 *                     — opens the chat-side agent panel (read-only sidebar
 *                       surface, no editor). ChatComponent watches
 *                       `openChatAgentPanelTick` and toggles its sidenav
 *                       open on each increment.
 *   agent_fill_chat_panel_prompt
 *                     — opens the chat-side agent panel AND pushes a
 *                       prompt into the input box (optionally auto-sends
 *                       via runAgent). Lets the caller drive the visible
 *                       panel for live observation, complementing the
 *                       headless `agent_ask` path.
 *   agent_ask         — runs a headless FileAgentService turn against the
 *                       active book's KB + chat snapshot, returns the full
 *                       agent log (tool calls + results + thoughts + final
 *                       submitResponse). Defaults to sidebar mode (readOnly,
 *                       write tools rejected). In `fileViewer` mode writes
 *                       hit a snapshot Map only — the engine's KB is never
 *                       persisted to, so handbook validation can't trash
 *                       the active playthrough.
 *   agent_get_hints   — returns the AgentHintRegistry's mount report
 *                       (total / mounted / unmounted / activatable-without-
 *                       listener). Use to verify a template wiring change
 *                       — a directive that didn't import / didn't mount
 *                       leaves its path in `unmounted` even when the UI
 *                       region is on-screen.
 *   profile_pull_from_disk
 *                     — pulls the active user-defined profile's prompt
 *                       files from the bound FSA folder into IDB, then
 *                       triggers injection.forceReload() so the next
 *                       turn picks up the edits without an app reload.
 *                       Rejected if active profile is built-in or no
 *                       folder is bound. Mutually exclusive with mid-
 *                       turn state (returns `busy`).
 *   profile_push_to_disk
 *                     — writes the active user-defined profile's IDB
 *                       prompt rows out to the bound FSA folder. Same
 *                       built-in / busy guards as pull.
 *   profile_get_prompt
 *                     — reads one prompt for a profile (defaults to
 *                       active; any profile id accepted). `content` is
 *                       the resolved text (custom IDB row → shipped
 *                       base via seed chain), and `hasOverride` is
 *                       true iff the profile has its own IDB row for
 *                       the type (vs reading the base).
 *   profile_get_all_prompts
 *                     — reads all 11 prompts for a profile in one call.
 *                       Same resolved/hasOverride semantics as
 *                       `_get_prompt`.
 *   profile_set_prompt
 *                     — writes one prompt row to the ACTIVE profile's
 *                       IDB. Active must be user-defined (built-in
 *                       rejected). Auto-fires forceReload so the next
 *                       turn uses the edit. Refuses mid-turn (`busy`).
 *                       Canonical AI A/B path — bypasses FSA entirely,
 *                       no permission dance, no per-session manual seed.
 */

const STORAGE_URL = 'app_debug_bridge_url';
const STORAGE_ENABLED = 'app_debug_bridge_enabled';
const STORAGE_CLIENT_ID = 'app_debug_bridge_client_id';
const STORAGE_EVAL_ENABLED = 'app_debug_bridge_eval_enabled';
const HEARTBEAT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// Cross-tab leader election. Same origin (same KVStore) ⇒ same clientId, so
// two open tabs would race to claim the BridgeServer slot via `client_replaced`
// and ping-pong at ~2s intervals. The leader announces itself via this channel;
// later tabs see the announcement and stand down (no auto-handoff — closing
// the leader tab leaves the others idle until reload).
const LEADER_CHANNEL = 'textrpg-bridge-leader';
const LEADER_ELECT_MS = 200;

// base30 alphabet — strips visually-confusable iloruz01 from base32. Eight
// random chars give ~40 bits of entropy, ~10⁻¹¹ collision probability for the
// personal-device population we care about.
const CLIENT_ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

function generateClientId(): string {
    // Rejection sampling — `b % 30` on a uniform [0, 255] byte would bias
    // indices 0-15 (256 ≡ 16 mod 30), so discard bytes ≥ threshold and
    // re-roll. Pull extra bytes per round to amortize the discard rate.
    const ALPHABET_LEN = CLIENT_ID_ALPHABET.length;
    const threshold = 256 - (256 % ALPHABET_LEN);
    const bytes = new Uint8Array(16);
    let out = '';
    while (out.length < 8) {
        crypto.getRandomValues(bytes);
        for (const b of bytes) {
            if (b < threshold) {
                out += CLIENT_ID_ALPHABET[b % ALPHABET_LEN];
                if (out.length === 8) return out;
            }
        }
    }
    return out;
}

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

interface FileAgentSetProfileFrame extends BridgeFrame {
    id?: string;
    confirmPaid?: boolean;
}

interface BookRepairKbFrame extends BridgeFrame {
    scenarioId?: string;
}

interface ProfileGetPromptFrame extends BridgeFrame {
    type?: string;
    /** Defaults to active profile when omitted. */
    profileId?: string;
}

interface ProfileGetAllPromptsFrame extends BridgeFrame {
    profileId?: string;
}

interface ProfileSetPromptFrame extends BridgeFrame {
    type?: string;
    content?: string;
}

interface AgentOpenFileViewerFrame extends BridgeFrame {
    /** Filename to land on. Omitted = first file in the active KB. */
    initialFile?: string;
}

interface AgentAskFrame extends BridgeFrame {
    prompt?: string;
    /** sidebar = readOnly (default, handbook Q&A); fileViewer = writes allowed against a snapshot Map (the engine's KB is NOT mutated). */
    mode?: 'sidebar' | 'fileViewer';
    /** Default true — wipe prior turn history so each call is a fresh conversation. */
    clearHistory?: boolean;
}

interface AgentFillChatPanelPromptFrame extends BridgeFrame {
    prompt?: string;
    /** When true, also kicks runAgent after the prompt lands in the input — caller sees the agent stream live in the visible panel. */
    autoSend?: boolean;
}

interface AgentTriggerHintFrame extends BridgeFrame {
    path?: string;
    action?: 'highlight' | 'focus' | 'activate';
}

interface AgentGetHintBBoxFrame extends BridgeFrame {
    path?: string;
}

interface AgentEvalFrame extends BridgeFrame {
    /** JS expression evaluated as `(() => <expr>)()` in app context (dev mode only). */
    expr?: string;
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
    private fileAgentSettings = inject(FileAgentSettingsStore);
    private destroyRef = inject(DestroyRef);
    private win = inject(WINDOW);
    private kv = inject(KVStore);
    private books = inject(BookRepository);
    private files = inject(FileRepository);
    private fileViewerOpener = inject(FILE_VIEWER_OPENER);
    private envInjector = inject(EnvironmentInjector);
    private i18nService = inject(I18nService);
    private hintRegistry = inject(AgentHintRegistry);
    private matDialog = inject(MatDialog);
    private diskProfileSync = inject(DiskProfileSyncService);
    private prompts = inject(PromptRepository);

    /**
     * Lazy headless FileAgentService instance for `agent_ask`. Lives in a
     * child injector so it doesn't share state with the sidebar / file-viewer
     * agent panels — their `providers: [FileAgentService]` already gives each
     * its own instance; the bridge gets a third, dedicated one for outside-
     * driven Q&A. Created on first use because most sessions never call
     * agent_ask, and FileAgentService spins up a KV-backed settings store.
     */
    private bridgeFileAgent: FileAgentService | null = null;
    private getBridgeFileAgent(): FileAgentService {
        if (!this.bridgeFileAgent) {
            const child = createEnvironmentInjector(
                [FileAgentService], this.envInjector, 'bridge-file-agent'
            );
            this.bridgeFileAgent = child.get(FileAgentService);
        }
        return this.bridgeFileAgent;
    }

    /**
     * Tick counter that ChatComponent watches via effect to open its
     * right-side agent sidenav. Counter (not boolean) so successive bridge
     * calls always re-fire the open even if the panel is already open and
     * the user just closed it.
     */
    readonly openChatAgentPanelTick = signal(0);

    /**
     * Drives a prompt into the visible chat-side agent panel's input box
     * (and optionally auto-sends). ChatComponent forwards this into the
     * AgentConsoleComponent via signal input. Tick on the payload so
     * successive identical prompts still re-fire the effect.
     */
    readonly chatPanelPromptFill = signal<{ prompt: string; autoSend: boolean; tick: number } | null>(null);

    private static readonly VALID_INTENTS: ReadonlySet<string> = new Set(Object.values(GAME_INTENTS));

    readonly url = signal(this.kv.get(STORAGE_URL) ?? '');
    readonly enabled = signal(this.kv.get(STORAGE_ENABLED) === 'true');
    readonly clientId = signal(this.initClientId());
    readonly evalEnabled = signal(this.kv.get(STORAGE_EVAL_ENABLED) === 'true');
    readonly status = signal<BridgeStatus>('idle');
    readonly lastError = signal<string | null>(null);
    // Null while the election is still pending (LEADER_ELECT_MS window).
    // True if this tab won, false if another tab already claimed the slot.
    readonly leaderClaimed = signal<boolean | null>(null);
    private leaderChannel: BroadcastChannel | null = null;

    private initClientId(): string {
        const stored = this.kv.get(STORAGE_CLIENT_ID)?.trim();
        if (stored) return stored;
        const fresh = generateClientId();
        this.kv.set(STORAGE_CLIENT_ID, fresh);
        return fresh;
    }

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

    setClientId(id: string): void {
        const trimmed = id.trim() || generateClientId();
        this.clientId.set(trimmed);
        this.kv.set(STORAGE_CLIENT_ID, trimmed);
    }

    setEvalEnabled(enabled: boolean): void {
        this.evalEnabled.set(enabled);
        this.kv.set(STORAGE_EVAL_ENABLED, String(enabled));
    }

    constructor() {
        this.electLeader();

        effect(() => {
            const url = this.url().trim();
            const enabled = this.enabled();
            // clientId tracked here so a rename triggers a reconnect with the new id.
            this.clientId();
            const leader = this.leaderClaimed();
            this.intentionalClose = true;
            this.teardown();
            if (leader === null) {
                // Election in flight — hold off without touching status.
                return;
            }
            if (leader === false) {
                this.status.set('idle');
                this.lastError.set(this.i18nService.translate('settings.bridgeAnotherTabActive'));
                return;
            }
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
            this.leaderChannel?.close();
            this.leaderChannel = null;
        });
    }

    private electLeader(): void {
        if (typeof BroadcastChannel === 'undefined') {
            // No cross-tab signaling available — fall back to "always leader"
            // (legacy behavior). Multi-tab users get the old ping-pong but
            // single-tab is unaffected.
            this.leaderClaimed.set(true);
            return;
        }
        const bc = new BroadcastChannel(LEADER_CHANNEL);
        this.leaderChannel = bc;
        let standingDown = false;
        bc.onmessage = event => {
            const msg = event.data as { type?: string } | null;
            if (!msg) return;
            if (msg.type === 'who' && this.leaderClaimed() === true) {
                bc.postMessage({ type: 'here' });
            } else if (msg.type === 'here' && this.leaderClaimed() !== true) {
                standingDown = true;
                this.leaderClaimed.set(false);
            }
        };
        bc.postMessage({ type: 'who' });
        // Jitter (0–150ms) breaks the tie when two tabs open simultaneously —
        // without it both elections fire at exactly LEADER_ELECT_MS and both
        // claim, reproducing the very ping-pong this election prevents. The
        // winner also announces 'here' on claim so the loser short-circuits.
        setTimeout(() => {
            if (!standingDown && this.leaderClaimed() === null) {
                this.leaderClaimed.set(true);
                bc.postMessage({ type: 'here' });
            }
        }, LEADER_ELECT_MS + Math.random() * 150);
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
                clientId: this.clientId(),
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
            case 'file_agent_get_profile':
                this.handleFileAgentGetProfile(frame);
                break;
            case 'file_agent_set_profile':
                this.handleFileAgentSetProfile(frame as FileAgentSetProfileFrame);
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
            case 'agent_open_file_viewer':
                this.handleAgentOpenFileViewer(frame as AgentOpenFileViewerFrame);
                break;
            case 'agent_open_chat_agent_panel':
                this.handleAgentOpenChatAgentPanel(frame);
                break;
            case 'agent_fill_chat_panel_prompt':
                this.handleAgentFillChatPanelPrompt(frame as AgentFillChatPanelPromptFrame);
                break;
            case 'agent_ask':
                void this.handleAgentAsk(frame as AgentAskFrame);
                break;
            case 'agent_get_hints':
                this.handleAgentGetHints(frame);
                break;
            case 'agent_open_hint_debug':
                this.handleAgentOpenHintDebug(frame);
                break;
            case 'agent_trigger_hint':
                this.handleAgentTriggerHint(frame as AgentTriggerHintFrame);
                break;
            case 'agent_get_hint_bbox':
                this.handleAgentGetHintBBox(frame as AgentGetHintBBoxFrame);
                break;
            case 'agent_eval':
                void this.handleAgentEval(frame as AgentEvalFrame);
                break;
            case 'profile_pull_from_disk':
                void this.handleProfilePullFromDisk(frame);
                break;
            case 'profile_push_to_disk':
                void this.handleProfilePushToDisk(frame);
                break;
            case 'profile_get_prompt':
                void this.handleProfileGetPrompt(frame as ProfileGetPromptFrame);
                break;
            case 'profile_get_all_prompts':
                void this.handleProfileGetAllPrompts(frame as ProfileGetAllPromptsFrame);
                break;
            case 'profile_set_prompt':
                void this.handleProfileSetPrompt(frame as ProfileSetPromptFrame);
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

    private handleFileAgentGetProfile(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        const activeId = this.fileAgentSettings.selectedProfileId();
        const profile = activeId ? this.llmConfig.profiles().find(p => p.id === activeId) : null;
        if (!profile) {
            this.send({ type: 'file_agent_get_profile_response', requestId, id: null });
            return;
        }
        this.send({ type: 'file_agent_get_profile_response', requestId, ...this.llmProfileMeta(profile) });
    }

    private handleFileAgentSetProfile(frame: FileAgentSetProfileFrame): void {
        const { requestId, id, confirmPaid } = frame;
        if (!requestId) return;
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
        this.fileAgentSettings.selectProfile(id);
        this.send({ type: 'file_agent_set_profile_response', requestId, ...meta });
    }

    private handleAgentOpenFileViewer(frame: AgentOpenFileViewerFrame): void {
        const { requestId, initialFile } = frame;
        if (!requestId) return;
        const loaded = this.state.loadedFiles();
        if (loaded.size === 0) {
            this.send({ type: 'action_error', requestId, error: 'no_loaded_files' });
            return;
        }
        const fileToOpen = (initialFile && loaded.has(initialFile))
            ? initialFile
            : loaded.keys().next().value as string;
        // Delegate the dialog open through FILE_VIEWER_OPENER so this Core
        // service doesn't depend on the FileViewer Feature component
        // directly. The opener refuses a second concurrent dialog — stacking
        // mis-mounts Monaco and shows blank on the later instances.
        const result = this.fileViewerOpener.open({
            files: loaded,
            initialFile: fileToOpen,
            openAgentPanelOnInit: true,
        });
        if (result.alreadyOpen) {
            this.send({ type: 'action_error', requestId, error: 'already_open' });
            return;
        }
        this.send({ type: 'agent_open_file_viewer_response', requestId, initialFile: fileToOpen });
    }

    private handleAgentOpenChatAgentPanel(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        this.openChatAgentPanelTick.update(n => n + 1);
        this.send({ type: 'agent_open_chat_agent_panel_response', requestId, ok: true });
    }

    private handleAgentGetHints(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        const report = this.hintRegistry.getMountedReport();
        this.send({ type: 'agent_get_hints_response', requestId, ok: true, ...report });
    }

    private handleAgentOpenHintDebug(frame: BridgeFrame): void {
        const { requestId } = frame;
        if (!requestId) return;
        // Modeless (no backdrop, anchored top-right) so the target's flash is
        // visible while the panel is open. The panel watches the registry's
        // mount report so clicking through cascade chains updates the table.
        const isAlreadyOpen = this.matDialog.openDialogs.some(d => d.componentInstance instanceof AgentHintDebugDialogComponent);
        if (isAlreadyOpen) {
            this.send({ type: 'agent_open_hint_debug_response', requestId, ok: true, alreadyOpen: true });
            return;
        }
        this.matDialog.open(AgentHintDebugDialogComponent, {
            hasBackdrop: false,
            position: { right: '20px', top: '60px' },
            panelClass: 'agent-hint-debug-panel',
            // autoFocus messes with the focus action testing.
            autoFocus: false,
            restoreFocus: false,
        });
        this.send({ type: 'agent_open_hint_debug_response', requestId, ok: true, alreadyOpen: false });
    }

    private handleAgentTriggerHint(frame: AgentTriggerHintFrame): void {
        const { requestId, path, action } = frame;
        if (!requestId) return;
        if (typeof path !== 'string' || !path) {
            this.send({ type: 'action_error', requestId, error: 'invalid_path' });
            return;
        }
        const safeAction = (action === 'focus' || action === 'activate') ? action : 'highlight';
        const result = this.hintRegistry.openTarget(path, safeAction);
        this.send({ type: 'agent_trigger_hint_response', requestId, path, action: safeAction, ...result });
    }

    private handleAgentGetHintBBox(frame: AgentGetHintBBoxFrame): void {
        const { requestId, path } = frame;
        if (!requestId) return;
        if (typeof path !== 'string' || !path) {
            this.send({ type: 'action_error', requestId, error: 'invalid_path' });
            return;
        }
        const resolved = this.hintRegistry.findByPath(path);
        if (!resolved) {
            this.send({ type: 'action_error', requestId, error: 'unknown_path' });
            return;
        }
        if (!resolved.elementRef) {
            this.send({
                type: 'agent_get_hint_bbox_response',
                requestId,
                path,
                mounted: false,
                visible: false,
                bbox: null,
            });
            return;
        }
        const el = resolved.elementRef.nativeElement as HTMLElement;
        const rect = el.getBoundingClientRect();
        const visible = el.offsetParent !== null || (rect.width > 0 && rect.height > 0);
        const win = this.win as Window;
        this.send({
            type: 'agent_get_hint_bbox_response',
            requestId,
            path,
            mounted: true,
            visible,
            bbox: {
                top: rect.top, left: rect.left, width: rect.width, height: rect.height,
                bottom: rect.bottom, right: rect.right,
            },
            viewport: { width: win.innerWidth, height: win.innerHeight },
            activatable: !!resolved.entry.activatable,
            hasOnActivate: !!resolved.onActivate,
        });
    }

    // Async JS eval. Compiled via AsyncFunction so callers can `await`
    // inside the body (animations, fetches, etc). Bare expressions get
    // wrapped as `return (expr)`; bodies containing `return` paste as-is.
    // Gated by the `evalEnabled` toggle (default off) — without it any
    // bridge consumer with WS access could exec arbitrary JS in-page.
    private async handleAgentEval(frame: AgentEvalFrame): Promise<void> {
        const { requestId, expr } = frame;
        if (!requestId) return;
        if (!this.evalEnabled()) {
            this.send({ type: 'action_error', requestId, error: 'eval_disabled' });
            return;
        }
        if (typeof expr !== 'string' || !expr) {
            this.send({ type: 'action_error', requestId, error: 'invalid_expr' });
            return;
        }
        try {
            const body = expr.includes('return') ? expr : `return (${expr});`;
            const AsyncFn = (async function () { /* ctor probe */ }).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
            const fn = new AsyncFn('window', 'document', body);
            const raw = await fn(this.win, (this.win as Window).document);
            const value = this.safeSerialize(raw);
            this.send({ type: 'agent_eval_response', requestId, ok: true, value });
        } catch (e) {
            const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            this.send({ type: 'agent_eval_response', requestId, ok: false, error: detail });
        }
    }

    private safeSerialize(value: unknown, depth = 0): unknown {
        if (depth > 6) return '<<depth>>';
        if (value === null || value === undefined) return value;
        const t = typeof value;
        if (t === 'string' || t === 'number' || t === 'boolean') return value;
        if (t === 'function') return `<<fn:${(value as { name?: string }).name ?? 'anon'}>>`;
        // Caller did `return someUnawaited` inside the eval body — surface
        // that rather than silently serializing the empty Promise object.
        if (value instanceof Promise) return '<<unresolved Promise — use `return await ...`>>';
        if (value instanceof Element) {
            return {
                __dom: true,
                tag: value.tagName.toLowerCase(),
                id: value.id || null,
                classes: value.className || null,
            };
        }
        if (Array.isArray(value)) return value.map(v => this.safeSerialize(v, depth + 1));
        if (t === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as object)) {
                try { out[k] = this.safeSerialize(v, depth + 1); } catch { out[k] = '<<unreadable>>'; }
            }
            return out;
        }
        return String(value);
    }

    private handleAgentFillChatPanelPrompt(frame: AgentFillChatPanelPromptFrame): void {
        const { requestId, prompt, autoSend } = frame;
        if (!requestId) return;
        if (typeof prompt !== 'string') {
            this.send({ type: 'action_error', requestId, error: 'invalid_prompt' });
            return;
        }
        // Open the panel too — caller doesn't have to pair with a separate open call.
        this.openChatAgentPanelTick.update(n => n + 1);
        this.chatPanelPromptFill.update(v => ({
            prompt,
            autoSend: Boolean(autoSend),
            tick: (v?.tick ?? 0) + 1,
        }));
        this.send({ type: 'agent_fill_chat_panel_prompt_response', requestId, ok: true });
    }

    private async handleAgentAsk(frame: AgentAskFrame): Promise<void> {
        const { requestId, prompt, mode, clearHistory } = frame;
        if (!requestId) return;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            this.send({ type: 'action_error', requestId, error: 'invalid_prompt' });
            return;
        }
        const agent = this.getBridgeFileAgent();
        if (agent.isAgentRunning()) {
            this.send({ type: 'action_error', requestId, error: 'agent_busy' });
            return;
        }
        if (clearHistory !== false) agent.clearHistory();

        // Ensure the tool-support probe has settled before runAgent picks
        // a mode. The FileAgentService constructor kicks the probe via an
        // effect, but it's fire-and-forget — on a cold first agent_ask
        // (chat panel never opened, no sibling instance probed yet) the
        // probeResults cache is empty and resolveToolCallMode would fall
        // back to the provider's static capability (which for llama.cpp
        // defaults to JSON until proven). Awaiting here is idempotent:
        // kickToolSupportProbe short-circuits if a verdict is already cached.
        const profileId = agent.selectedProfileId();
        if (profileId) {
            try { await agent.capability.kickToolSupportProbe(profileId); } catch { /* swallow — probe also swallows */ }
        }

        // Snapshot the engine's KB for an isolated run — write tools mutate
        // this Map, never the live state.loadedFiles. The caller gets a
        // diff via the response so they can see what the agent WOULD have
        // written, without trashing an active playthrough.
        const files = new Map(this.state.loadedFiles());
        const replacements: { filename: string; content: string }[] = [];
        const readOnly = mode !== 'fileViewer';
        const context = {
            files,
            onFileReplaced: (filename: string, content: string) => {
                files.set(filename, content);
                replacements.push({ filename, content });
            },
            chatMessages: this.state.messages(),
            uiLanguage: this.i18nService.currentLang(),
            narrativeLanguage: this.appConfig.outputLanguage(),
            readOnly
        };

        try {
            await agent.runAgent(prompt, context);
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            this.send({ type: 'action_error', requestId, error: 'agent_failed', detail });
            return;
        }

        const logs = agent.agentLogs().map(e => ({
            role: e.role,
            type: e.type,
            text: e.text,
            ...(e.thought !== undefined ? { thought: e.thought } : {}),
            ...(e.isToolCall ? { isToolCall: true } : {}),
            ...(e.isToolResult ? { isToolResult: true } : {}),
            ...(e.toolName ? { toolName: e.toolName } : {}),
            ...(e.reason ? { reason: e.reason } : {}),
        }));
        // Final agent answer = the last model entry that is NOT a tool call /
        // tool result. submitResponse overwrites its streaming entry with
        // the final text + isToolCall=false, so it lands here.
        const finalEntry = [...agent.agentLogs()]
            .reverse()
            .find(e => e.role === 'model' && !e.isToolCall && !e.isToolResult);
        const finalResponse = finalEntry?.text ?? '';
        const replacementsSummary = replacements.map(r => ({
            filename: r.filename,
            size: r.content.length,
        }));
        this.send({
            type: 'agent_ask_response',
            requestId,
            mode: readOnly ? 'sidebar' : 'fileViewer',
            finalResponse,
            logs,
            replacements: replacementsSummary,
        });
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

    private async handleProfilePullFromDisk(frame: BridgeFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        try {
            const result = await this.diskProfileSync.pullActiveFromDisk();
            this.send({
                type: 'profile_pull_from_disk_response',
                requestId,
                updatedTypes: result.updatedTypes,
                metaUpdated: result.metaUpdated,
            });
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            const error = this.classifyDiskSyncError(detail);
            this.send({ type: 'action_error', requestId, error, detail });
        }
    }

    private async handleProfilePushToDisk(frame: BridgeFrame): Promise<void> {
        const { requestId } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        try {
            await this.diskProfileSync.pushActiveToDisk();
            this.send({ type: 'profile_push_to_disk_response', requestId, ok: true });
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            const error = this.classifyDiskSyncError(detail);
            this.send({ type: 'action_error', requestId, error, detail });
        }
    }

    private classifyDiskSyncError(detail: string): string {
        if (/only supported for user profiles/i.test(detail)) return 'builtin_profile';
        if (/is not registered/i.test(detail))                return 'unknown_profile';
        if (/does not exist yet/i.test(detail))               return 'folder_not_found';
        // FolderHandlePermissionDeniedError.message is a localization key,
        // not a sentence — match the key fragments. The bare-English
        // fallbacks (permission / aborted) cover non-localized throws.
        if (/errAccessDenied|errAccessNotGranted|errFsaUnavailable|permission|aborted/i.test(detail)) return 'fsa_permission';
        if (/no folder bound/i.test(detail))                  return 'folder_not_bound';
        return 'disk_sync_failed';
    }

    private async readResolvedPromptWithOverride(type: PromptType, profileId: string): Promise<{ content: string; hasOverride: boolean }> {
        const content = await this.injection.getResolvedProfilePrompt(type, profileId);
        const overrideRow = await this.prompts.getProfilePrompt(type, profileId);
        return { content, hasOverride: !!overrideRow };
    }

    private isValidPromptType(t: unknown): t is PromptType {
        return typeof t === 'string' && (ALL_PROMPT_TYPES as readonly string[]).includes(t);
    }

    private async handleProfileGetPrompt(frame: ProfileGetPromptFrame): Promise<void> {
        const { requestId, type, profileId } = frame;
        if (!requestId) return;
        if (!this.isValidPromptType(type)) {
            this.send({ type: 'action_error', requestId, error: 'invalid_type' });
            return;
        }
        const id = profileId ?? this.state.activePromptProfile();
        if (!this.registry.get(id)) {
            this.send({ type: 'action_error', requestId, error: 'unknown_profile' });
            return;
        }
        const { content, hasOverride } = await this.readResolvedPromptWithOverride(type, id);
        this.send({
            type: 'profile_get_prompt_response',
            requestId,
            promptType: type,
            profileId: id,
            content,
            hasOverride,
        });
    }

    private async handleProfileGetAllPrompts(frame: ProfileGetAllPromptsFrame): Promise<void> {
        const { requestId, profileId } = frame;
        if (!requestId) return;
        const id = profileId ?? this.state.activePromptProfile();
        if (!this.registry.get(id)) {
            this.send({ type: 'action_error', requestId, error: 'unknown_profile' });
            return;
        }
        const prompts: Record<string, { content: string; hasOverride: boolean }> = {};
        for (const t of ALL_PROMPT_TYPES) {
            prompts[t] = await this.readResolvedPromptWithOverride(t, id);
        }
        this.send({
            type: 'profile_get_all_prompts_response',
            requestId,
            profileId: id,
            prompts,
        });
    }

    private async handleProfileSetPrompt(frame: ProfileSetPromptFrame): Promise<void> {
        const { requestId, type, content } = frame;
        if (!requestId) return;
        if (this.state.isBusy()) {
            this.send({ type: 'action_error', requestId, error: 'busy' });
            return;
        }
        if (!this.isValidPromptType(type)) {
            this.send({ type: 'action_error', requestId, error: 'invalid_type' });
            return;
        }
        if (typeof content !== 'string') {
            this.send({ type: 'action_error', requestId, error: 'invalid_content' });
            return;
        }
        try {
            // saveToService: targets active profile, throws on built-in,
            // updates the `prompt_user_modified` KV flag, and refreshes the
            // signal content — no separate forceReload needed.
            await this.injection.saveToService(type, content);
            this.send({
                type: 'profile_set_prompt_response',
                requestId,
                promptType: type,
                profileId: this.state.activePromptProfile(),
                length: content.length,
            });
        } catch (e) {
            const detail = e instanceof Error ? e.message : 'unknown';
            const error = /built-in/i.test(detail) ? 'builtin_profile' : 'set_prompt_failed';
            this.send({ type: 'action_error', requestId, error, detail });
        }
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
