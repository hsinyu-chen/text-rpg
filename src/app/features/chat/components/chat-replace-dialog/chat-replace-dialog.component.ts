import { Component, inject, signal, computed, resource } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { GameStateService } from '../../../../core/services/game-state.service';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { ChatHistoryService } from '../../../../core/services/chat-history.service';
import { GAME_INTENTS, GameIntent } from '../../../../core/constants/game-intents';
import { getIntentLabels } from '../../../../core/constants/engine-protocol';
import { ChatMessage } from '../../../../core/models/types';
import { LanguageService } from '../../../../core/services/language.service';

export type SearchField = 'all' | 'story' | 'summary' | 'logs';

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
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatIconModule,
        MatInputModule,
        MatFormFieldModule,
        MatSelectModule,
        MatTooltipModule,
        MatProgressSpinnerModule,
        MatSnackBarModule
    ],
    templateUrl: './chat-replace-dialog.component.html',
    styleUrl: './chat-replace-dialog.component.scss'
})
export class ChatReplaceDialogComponent {
    state = inject(GameStateService);
    engine = inject(GameEngineService);
    history = inject(ChatHistoryService);
    lang = inject(LanguageService);
    dialogRef = inject(MatDialogRef<ChatReplaceDialogComponent>);
    private snackBar = inject(MatSnackBar);

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

    // Intents list (Localized)
    intents = computed(() => {
        const labels = getIntentLabels(this.state.config()?.outputLanguage);
        return [
            { value: 'all', label: this.lang.t('ALL') },
            { value: GAME_INTENTS.ACTION, label: labels.ACTION },
            { value: GAME_INTENTS.CONTINUE, label: labels.CONTINUE },
            { value: GAME_INTENTS.FAST_FORWARD, label: labels.FAST_FORWARD },
            { value: GAME_INTENTS.SYSTEM, label: labels.SYSTEM },
            { value: GAME_INTENTS.SAVE, label: labels.SAVE }
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
            return 'Invalid Regex';
        }
    }

    private _escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    replaceAll() {
        const matches = this.searchResource.value();
        if (!matches || matches.length === 0) return;

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

        this.history.updateMessages(() => updatedMessages);
        this.snackBar.open(this.lang.t('REPLACE_COUNT', { count: matches.length.toString() }), 'OK', { duration: 3000 });
        this.searchResource.reload();
    }

    close() {
        this.dialogRef.close();
    }
}
