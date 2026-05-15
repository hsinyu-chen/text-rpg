import { Component, inject, signal, computed, resource } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CORE_MAT, DIALOG_MAT, FORM_MAT } from '@app/shared/material/material-groups';
import { AppAgentHintDirective } from '@app/core/services/agent-hints/agent-hints.directive';
import { GameStateService } from '@app/core/services/game-state.service';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { ChatHistoryService } from '@app/core/services/chat-history.service';
import { GAME_INTENTS, GameIntent } from '@app/core/constants/game-intents';
import { ChatMessage } from '@app/core/models/types';
import { LanguageService } from '@app/core/services/language.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import type { ChatReplaceOutcome, ChatReplaceProposal } from '@app/core/services/file-agent/file-agent.types';

export type SearchField = 'all' | 'story' | 'summary' | 'logs';

/** Data shape when the dialog is opened by the file-agent's
 *  `proposeChatReplace` tool. Omit (or pass `null`) when the user opens
 *  the dialog manually from the chat-input toolbar — the dialog then
 *  starts empty and `close()` returns `undefined` as before. */
export interface ChatReplaceDialogData {
  prefill?: ChatReplaceProposal;
}

export interface ChatMatch {
    messageId: string;
    messageIndex: number;
    fieldName: string; // 'content', 'summary', 'inventory_log', 'quest_log', 'world_log'
    logIndex?: number;
    matchIndex: number;
    matchLength: number;
    originalContent: string;
}

@Component({
    selector: 'app-chat-replace-dialog',
    standalone: true,
    imports: [
        ...CORE_MAT,
        ...DIALOG_MAT,
        ...FORM_MAT,
        MatProgressSpinnerModule,
        FormsModule,
        TranslatePipe,
        AppAgentHintDirective,
    ],
    templateUrl: './chat-replace-dialog.component.html',
    styleUrl: './chat-replace-dialog.component.scss'
})
export class ChatReplaceDialogComponent {
    state = inject(GameStateService);
    engine = inject(GameEngineService);
    history = inject(ChatHistoryService);
    lang = inject(LanguageService);
    private i18n = inject(I18nService);
    dialogRef = inject<MatDialogRef<ChatReplaceDialogComponent, ChatReplaceOutcome | undefined>>(MatDialogRef);
    private snackBar = inject(MatSnackBar);
    /** Optional — present only when opened by the file-agent's
     *  `proposeChatReplace` tool. When absent, the dialog runs in its
     *  original user-driven mode and `close()` returns nothing. */
    private dialogData = inject<ChatReplaceDialogData | null>(MAT_DIALOG_DATA, { optional: true });

    /** When the dialog was opened with a prefilled proposal (file-agent
     *  flow), Apply / Cancel close the dialog with a `ChatReplaceOutcome`
     *  reporting what actually happened — so the agent learns whether
     *  the user accepted, tweaked, or rejected its suggestion. */
    readonly isProposeMode = !!this.dialogData?.prefill;

    // Search & Replace queries
    searchQuery = signal('');
    replaceQuery = signal('');

    // Filters
    intentFilter = signal<GameIntent | 'all'>('all');
    roleFilter = signal<'all' | 'user' | 'model'>('all');
    fieldFilter = signal<SearchField>('all');

    // Options
    isCaseSensitive = signal(false);
    isRegex = signal(false);
    isWholeWord = signal(false);

    constructor() {
        const prefill = this.dialogData?.prefill;
        if (prefill) {
            this.searchQuery.set(prefill.search);
            this.replaceQuery.set(prefill.replace);
            this.isCaseSensitive.set(!!prefill.caseSensitive);
            this.isWholeWord.set(!!prefill.wholeWord);
            this.isRegex.set(!!prefill.regex);
            this.intentFilter.set(prefill.intentFilter ?? 'all');
            this.roleFilter.set(prefill.roleFilter ?? 'all');
            this.fieldFilter.set(prefill.fieldFilter ?? 'all');
        }
    }

    /** True iff any field has been edited away from the file-agent's
     *  original proposal. Surfaced on the Outcome so the agent can
     *  acknowledge that the user tweaked its suggestion. */
    private divergedFromProposal(): boolean {
        const p = this.dialogData?.prefill;
        if (!p) return false;
        return (
            this.searchQuery() !== p.search ||
            this.replaceQuery() !== p.replace ||
            this.isCaseSensitive() !== !!p.caseSensitive ||
            this.isWholeWord() !== !!p.wholeWord ||
            this.isRegex() !== !!p.regex ||
            this.intentFilter() !== (p.intentFilter ?? 'all') ||
            this.roleFilter() !== (p.roleFilter ?? 'all') ||
            this.fieldFilter() !== (p.fieldFilter ?? 'all')
        );
    }

    // Intents list (Localized via interfaceLanguage)
    intents = computed(() => {
        return [
            { value: 'all', label: this.lang.t('ALL') },
            { value: GAME_INTENTS.ACTION, label: this.i18n.translate(`intent.labels.${GAME_INTENTS.ACTION}`) },
            { value: GAME_INTENTS.CONTINUE, label: this.i18n.translate(`intent.labels.${GAME_INTENTS.CONTINUE}`) },
            { value: GAME_INTENTS.FAST_FORWARD, label: this.i18n.translate(`intent.labels.${GAME_INTENTS.FAST_FORWARD}`) },
            { value: GAME_INTENTS.SYSTEM, label: this.i18n.translate(`intent.labels.${GAME_INTENTS.SYSTEM}`) },
            { value: GAME_INTENTS.SAVE, label: this.i18n.translate(`intent.labels.${GAME_INTENTS.SAVE}`) }
        ];
    });

    roles = computed(() => [
        { value: 'all', label: this.lang.t('ALL') },
        { value: 'user', label: this.lang.t('ROLE_USER') },
        { value: 'model', label: this.lang.t('ROLE_MODEL') }
    ]);

    fields = computed(() => [
        { value: 'all', label: this.lang.t('ALL') },
        { value: 'story', label: this.lang.t('FIELD_STORY') },
        { value: 'summary', label: this.lang.t('FIELD_SUMMARY') },
        { value: 'logs', label: this.lang.t('FIELD_LOGS') }
    ]);

    // Search Resource
    searchResource = resource({
        params: () => ({
            query: this.searchQuery(),
            intent: this.intentFilter(),
            role: this.roleFilter(),
            field: this.fieldFilter(),
            caseSensitive: this.isCaseSensitive(),
            regex: this.isRegex(),
            wholeWord: this.isWholeWord(),
            messages: this.state.messages()
        }),
        loader: async ({ params }) => {
            const query = params.query.trim();
            if (!query) return [];

            return new Promise<ChatMatch[]>((resolve) => {
                setTimeout(() => {
                    const results: ChatMatch[] = [];
                    let searchPattern: RegExp;

                    try {
                        if (params.regex) {
                            searchPattern = new RegExp(query, params.caseSensitive ? 'g' : 'gi');
                        } else {
                            let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            if (params.wholeWord) escaped = `\\b${escaped}\\b`;
                            searchPattern = new RegExp(escaped, params.caseSensitive ? 'g' : 'gi');
                        }

                        params.messages.forEach((msg, idx) => {
                            // Filter by Role
                            if (params.role !== 'all' && msg.role !== params.role) return;

                            // Filter by Intent
                            if (params.intent !== 'all' && msg.intent !== params.intent) return;

                            // Search in fields based on fieldFilter
                            this._searchInMessage(msg, idx, params.field, searchPattern, results);
                        });

                        resolve(results);
                    } catch (err) {
                        console.error('Search error:', err);
                        resolve([]);
                    }
                }, 0);
            });
        }
    });

    private _searchInMessage(msg: ChatMessage, idx: number, field: SearchField, pattern: RegExp, results: ChatMatch[]) {
        const check = (content: string | undefined, fieldName: string, logIndex?: number) => {
            if (!content) return;
            let match: RegExpExecArray | null;
            pattern.lastIndex = 0;
            while ((match = pattern.exec(content)) !== null) {
                results.push({
                    messageId: msg.id,
                    messageIndex: idx,
                    fieldName,
                    logIndex,
                    matchIndex: match.index,
                    matchLength: match[0].length,
                    originalContent: content
                });
            }
        };

        if (field === 'all' || field === 'story') {
            check(msg.content, 'content');
        }
        if (field === 'all' || field === 'summary') {
            check(msg.summary, 'summary');
        }
        if (field === 'all' || field === 'logs') {
            msg.inventory_log?.forEach((item, i) => check(item, 'inventory_log', i));
            msg.quest_log?.forEach((item, i) => check(item, 'quest_log', i));
            msg.world_log?.forEach((item, i) => check(item, 'world_log', i));
        }
    }

    // Grouping for UI
    groupedResults = computed(() => {
        const results = this.searchResource.value() ?? [];
        const groups = new Map<number, ChatMatch[]>();
        results.forEach(r => {
            if (!groups.has(r.messageIndex)) groups.set(r.messageIndex, []);
            groups.get(r.messageIndex)!.push(r);
        });
        return Array.from(groups.entries()).sort((a, b) => b[0] - a[0]); // Newest first
    });

    getMessagePreview(idx: number): string {
        const msg = this.state.messages()[idx];
        if (!msg) return '';
        const content = msg.content || '';
        return content.substring(0, 50) + (content.length > 50 ? '...' : '');
    }

    getCombinedDiffPreview(match: ChatMatch): string {
        const query = this.searchQuery();
        const replaceWith = this.replaceQuery();

        let searchPattern: RegExp;
        try {
            if (this.isRegex()) {
                searchPattern = new RegExp(query, this.isCaseSensitive() ? '' : 'i');
            } else {
                let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (this.isWholeWord()) escaped = `\\b${escaped}\\b`;
                searchPattern = new RegExp(escaped, this.isCaseSensitive() ? '' : 'i');
            }

            const matchStart = match.matchIndex;
            const matchEnd = matchStart + match.matchLength;
            const content = match.originalContent;

            const prefixLen = 20;
            const suffixLen = 50;
            const start = Math.max(0, matchStart - prefixLen);
            const end = Math.min(content.length, matchEnd + suffixLen);

            const beforeMatch = content.substring(start, matchStart);
            const matchStr = content.substring(matchStart, matchEnd);
            const afterMatch = content.substring(matchEnd, end);

            const substitutedMatch = matchStr.replace(searchPattern, replaceWith);

            return `${start > 0 ? '...' : ''}${this._escapeHtml(beforeMatch)}<span class="diff-removed">${this._escapeHtml(matchStr)}</span><span class="diff-added">${this._escapeHtml(substitutedMatch)}</span>${this._escapeHtml(afterMatch)}${end < content.length ? '...' : ''}`;
        } catch {
            return this.i18n.translate('ui.INVALID_REGEX');
        }
    }

    private _escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async replaceAll() {
        const matches = this.searchResource.value();
        if (!matches || matches.length === 0) return;

        const replaceCount = matches.length;
        const updatedMessages = [...this.state.messages()];
        const query = this.searchQuery();
        const replaceWith = this.replaceQuery();

        let pattern: RegExp;
        if (this.isRegex()) {
            pattern = new RegExp(query, this.isCaseSensitive() ? 'g' : 'gi');
        } else {
            let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (this.isWholeWord()) escaped = `\\b${escaped}\\b`;
            pattern = new RegExp(escaped, this.isCaseSensitive() ? 'g' : 'gi');
        }

        // To avoid multiple replacements messing with indices, we group by message and field
        // But since we use .replace(pattern, replaceWith), it's easier to just apply to the whole field string
        const affectedIndices = new Set<number>();
        matches.forEach(m => affectedIndices.add(m.messageIndex));

        affectedIndices.forEach(idx => {
            const msg = { ...updatedMessages[idx] };
            const field = this.fieldFilter();

            if (field === 'all' || field === 'story') {
                if (msg.content) msg.content = msg.content.replace(pattern, replaceWith);
            }
            if (field === 'all' || field === 'summary') {
                if (msg.summary) msg.summary = msg.summary.replace(pattern, replaceWith);
            }
            if (field === 'all' || field === 'logs') {
                if (msg.inventory_log) msg.inventory_log = msg.inventory_log.map(i => i.replace(pattern, replaceWith));
                if (msg.quest_log) msg.quest_log = msg.quest_log.map(i => i.replace(pattern, replaceWith));
                if (msg.world_log) msg.world_log = msg.world_log.map(i => i.replace(pattern, replaceWith));
            }

            updatedMessages[idx] = msg;
        });

        await this.history.commitMessages(updatedMessages);

        if (this.isProposeMode) {
            // Agent-proposed flow: surface the final applied parameters
            // back to the agent and close. No snackbar — the outcome is
            // the feedback channel, and the dialog goes away anyway.
            this.dialogRef.close({
                applied: {
                    search: this.searchQuery(),
                    replace: this.replaceQuery(),
                    filters: {
                        intent: this.intentFilter(),
                        role: this.roleFilter(),
                        field: this.fieldFilter(),
                    },
                    replaceCount
                },
                cancelled: false,
                divergedFromProposal: this.divergedFromProposal()
            });
            return;
        }

        this.snackBar.open(this.lang.t('REPLACE_COUNT', { count: replaceCount.toString() }), this.i18n.translate('dialog.ok'), { duration: 3000 });
        this.searchResource.reload();
    }

    close() {
        if (this.isProposeMode) {
            this.dialogRef.close({
                applied: null,
                cancelled: true,
                divergedFromProposal: this.divergedFromProposal()
            });
            return;
        }
        this.dialogRef.close();
    }
}
