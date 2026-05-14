import { Component, effect, inject, signal, output, computed, linkedSignal } from '@angular/core';
import { DatePipe, DOCUMENT } from '@angular/common';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { SyncDirection } from '@app/core/services/sync/sync.types';
import { SessionService } from '@app/core/services/session.service';
import { BookRepository } from '@app/core/services/storage/book.repository';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { CostService } from '@app/core/services/cost.service';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { Book, Collection, ROOT_COLLECTION_ID } from '@app/core/models/types';
import { DialogService } from '@app/core/services/dialog.service';
import { LoadingService } from '@app/core/services/loading.service';
import { CollectionService } from '@app/core/services/collection.service';
import { SyncService } from '@app/core/services/sync/sync.service';
import { SyncBackendResolver } from '@app/core/services/sync/sync-backend-resolver.service';
import { SyncTombstoneTracker } from '@app/core/services/sync/tombstone-tracker.service';
import { SaveNameDialogComponent, SaveNameDialogData } from '@app/shared/components/save-name-dialog/save-name-dialog.component';
import { MoveBookDialogComponent, MoveBookDialogData } from '@app/shared/components/move-book-dialog/move-book-dialog.component';
import { firstValueFrom } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { AgentBookJumperService, BookJumpRequest } from '@app/core/services/agent-hints/agent-book-jumper.service';
import { spotlightElement } from '@app/core/services/agent-hints/spotlight.util';

interface BookGroup {
    collection: Collection;
    books: Book[];
}

@Component({
    selector: 'app-book-list',
    standalone: true,
    imports: [
        ...CORE_MAT,
        MatListModule,
        MatMenuModule,
        MatDividerModule,
        MatProgressSpinnerModule,
        DatePipe,
        TranslatePipe
    ],
    templateUrl: './book-list.component.html',
    styleUrl: './book-list.component.scss',
})
export class BookListComponent {
    engine = inject(GameEngineService);
    session = inject(SessionService);
    bookRepo = inject(BookRepository);
    state = inject(GameStateService);
    costService = inject(CostService);
    providerRegistry = inject(LLMProviderRegistryService);
    dialog = inject(DialogService);
    matDialog = inject(MatDialog);
    loading = inject(LoadingService);
    snackBar = inject(MatSnackBar);
    collectionService = inject(CollectionService);
    syncService = inject(SyncService);
    syncBackends = inject(SyncBackendResolver);
    tombstoneTracker = inject(SyncTombstoneTracker);
    private i18n = inject(I18nService);
    private bookJumper = inject(AgentBookJumperService);
    private doc = inject(DOCUMENT);
    private lastJumpTick = 0;

    private t(key: string, params?: Record<string, string | number>): string {
        return this.i18n.translate(`sidebar.bookList.${key}`, params);
    }

    readonly rootId = ROOT_COLLECTION_ID;

    books = signal<Book[]>([]);
    private booksLoaded = signal(false);

    totalBookCount = computed(() => this.books().length);

    activeCollectionId = computed<string | null>(() => {
        const id = this.session.currentBookId();
        if (!id) return null;
        const book = this.books().find(b => b.id === id);
        return book?.collectionId ?? null;
    });

    // Source must include bookId, not just collectionId — switching between two
    // books in the same collection has to reset too, otherwise a prior manual
    // collapse would persist across the switch. Both upstream signals do
    // Object.is dedup, so unrelated books() churn (autosave) never reaches this
    // computation; whenever it runs, something we care about actually changed.
    private expandedIds = linkedSignal<{ bookId: string | null; collectionId: string | null }, Set<string>>({
        source: () => ({
            bookId: this.session.currentBookId(),
            collectionId: this.activeCollectionId()
        }),
        computation: (s) => new Set<string>([s.collectionId ?? ROOT_COLLECTION_ID])
    });

    bookGroups = computed<BookGroup[]>(() => {
        const cols = this.collectionService.collections();
        const allBooks = this.books();
        const byCollection = new Map<string, Book[]>();
        for (const b of allBooks) {
            const cid = b.collectionId || ROOT_COLLECTION_ID;
            const arr = byCollection.get(cid) || [];
            arr.push(b);
            byCollection.set(cid, arr);
        }

        // Order: root first, then user-created by createdAt asc
        const root = cols.find(c => c.id === ROOT_COLLECTION_ID);
        const others = cols.filter(c => c.id !== ROOT_COLLECTION_ID).sort((a, b) => a.createdAt - b.createdAt);
        const ordered = root ? [root, ...others] : others;

        return ordered.map(c => ({
            collection: c,
            books: (byCollection.get(c.id) || []).sort((a, b) => b.createdAt - a.createdAt)
        }));
    });

    isExpanded(id: string): boolean {
        return this.expandedIds().has(id);
    }

    toggleCollection(id: string): void {
        // Accordion: if this one is already the (only) open one, collapse it;
        // otherwise open it exclusively and close every other collection.
        const current = this.expandedIds();
        if (current.has(id)) {
            this.expandedIds.set(new Set());
        } else {
            this.expandedIds.set(new Set([id]));
        }
    }

    private activeSessionCost = computed(() => {
        const activeModelId = this.providerRegistry.getActiveModelId();
        const model = this.providerRegistry.getActiveModels().find(m => m.id === activeModelId);
        if (!model) return 0;

        const messages = this.state.messages();
        const sunkHistory = this.state.sunkUsageHistory();

        const activeTxn = this.costService.calculateSessionTransactionCost(messages, model);

        let sunkTxn = 0;
        for (const usage of sunkHistory) {
            sunkTxn += this.costService.calculateTurnCost({
                prompt: usage.prompt,
                cached: usage.cached,
                candidates: usage.candidates
            }, model.id);
        }

        const activeUsage = this.state.storageUsageAccumulated();
        const historyUsage = this.state.historyStorageUsageAccumulated();
        const storageCost = this.costService.calculateStorageCost(activeUsage + historyUsage, model.id);

        return activeTxn + sunkTxn + storageCost;
    });

    weeklyStats = computed(() => {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const activeBookId = this.session.currentBookId();
        const recentBooks = this.books().filter(b => b.lastActiveAt >= sevenDaysAgo);

        let totalCost = 0;
        for (const book of recentBooks) {
            if (book.id === activeBookId) {
                totalCost += this.activeSessionCost();
            } else {
                totalCost += book.stats.estimatedCost || 0;
            }
        }

        return { bookCount: recentBooks.length, totalCost };
    });

    displayCurrency = this.costService.displayCurrency;
    displayRate = this.costService.displayRate;

    formatCost(cost: number): string {
        const currency = this.displayCurrency();
        const rate = this.displayRate();
        const converted = cost * rate;
        const decimals = currency === 'USD' ? 4 : 2;
        return `${currency} ${converted.toFixed(decimals)}`;
    }

    constructor() {
        void this.loadBooks();

        // app://book/<id>[/<action>] or app://collection/<id>[/<action>] link
        // clicked in agent-console → jumper service emits → we resolve the id,
        // expand the row's containing collection if needed, scroll into view,
        // and either spotlight (no action) or click the action button.
        //
        // Gated on booksLoaded so a request that arrived before loadBooks
        // resolved doesn't falsely toast "not found" against an empty list.
        // The effect re-runs when booksLoaded flips, picking the pending
        // request up at that point.
        effect(() => {
            const req = this.bookJumper.request();
            if (!req || req.tick === this.lastJumpTick) return;
            if (!this.booksLoaded()) return;
            this.lastJumpTick = req.tick;
            this.handleAgentJump(req).catch(err => console.error('[BookList] agent jump failed', err));
        });
    }

    private async handleAgentJump(req: BookJumpRequest): Promise<void> {
        if (req.kind === 'collection') {
            await this.jumpToCollection(req.id, req.action);
            return;
        }
        await this.jumpToBook(req.id, req.action);
    }

    private async jumpToBook(bookId: string, action: string | null): Promise<void> {
        const book = this.books().find(b => b.id === bookId);
        if (!book) {
            this.toastNotFound('book', bookId);
            return;
        }
        const colId = book.collectionId || ROOT_COLLECTION_ID;
        const needsExpand = !this.isExpanded(colId);
        if (needsExpand) this.expandedIds.set(new Set([colId]));
        // Wait for the signal write above to flush through change detection
        // and the @for to render the new mat-list-item before we query for
        // the row's data-book-id attr.
        if (needsExpand) await new Promise(r => requestAnimationFrame(() => r(null)));
        const row = this.doc.querySelector<HTMLElement>(`[data-book-id="${CSS.escape(bookId)}"]`);
        if (!row) {
            this.toastNotFound('book', bookId);
            return;
        }
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!action) {
            void this.switchBook(bookId);
            spotlightElement(row);
            return;
        }
        const target = row.querySelector<HTMLElement>(`[data-book-action="${CSS.escape(action)}"]`);
        if (!target) {
            spotlightElement(row);
            return;
        }
        spotlightElement(target);
        // active-cache-badge is a tooltip-only badge with no click handler;
        // calling .click() on it is harmless but redundant. Other actions
        // (move / rename / delete) open dialogs.
        if (action !== 'active-cache-badge') target.click();
    }

    private async jumpToCollection(collectionId: string, action: string | null): Promise<void> {
        const group = this.bookGroups().find(g => g.collection.id === collectionId);
        if (!group) {
            this.toastNotFound('collection', collectionId);
            return;
        }
        // Collection headers are rendered unconditionally for every group
        // (only the inner book-sublist is gated on isExpanded), so the DOM
        // node is already there when the effect runs — no render-wait needed.
        const header = this.doc.querySelector<HTMLElement>(`[data-collection-id="${CSS.escape(collectionId)}"]`);
        if (!header) {
            this.toastNotFound('collection', collectionId);
            return;
        }
        header.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!action) {
            spotlightElement(header);
            return;
        }
        const btn = header.querySelector<HTMLElement>(`[data-collection-action="${CSS.escape(action)}"]`);
        if (!btn) {
            spotlightElement(header);
            return;
        }
        spotlightElement(btn);
        btn.click();
    }

    private toastNotFound(kind: 'book' | 'collection', id: string): void {
        const key = kind === 'book' ? 'agentHint.toast.bookNotFound' : 'agentHint.toast.collectionNotFound';
        this.snackBar.open(
            this.i18n.translate(key, { id }),
            this.i18n.translate('ui.CLOSE'),
            { duration: 3000 },
        );
    }

    async loadBooks() {
        await this.collectionService.load();
        const list = await this.bookRepo.list();
        console.log('[BookList] Loaded books:', list.length);
        this.books.set(list);
        this.booksLoaded.set(true);
    }

    isActive(id: string): boolean {
        return this.session.currentBookId() === id;
    }

    async switchBook(id: string) {
        if (this.isActive(id)) return;
        await this.session.loadBook(id);
        await this.loadBooks();
    }

    async deleteBook(book: Book, event: Event) {
        event.stopPropagation();

        const wasActive = this.isActive(book.id);
        const confirmMsg = this.t(
            wasActive ? 'deleteActiveBookConfirm' : 'deleteBookConfirm',
            { name: book.name },
        );

        if (!await this.dialog.confirm(confirmMsg)) return;

        this.tombstoneTracker.track('book', book.id);

        if (book.stats.kbCacheName) {
            if (await this.dialog.confirm(this.t('removeCacheConfirm'))) {
                // TODO: Implement robust remote cache deletion for specific books
            }
        }

        await this.session.deleteBook(book.id);
        await this.loadBooks();

        if (wasActive) {
            const remaining = this.books();
            if (remaining.length > 0) {
                const sorted = [...remaining].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
                await this.session.loadBook(sorted[0].id);
            }
        }
    }

    async renameBook(book: Book, event: Event) {
        event.stopPropagation();
        const newName = await this.promptName(this.t('renameBookDialogTitle'), book.name);
        if (newName && newName !== book.name) {
            await this.session.renameBook(book.id, newName);
            await this.loadBooks();
        }
    }

    async moveBook(book: Book, event: Event) {
        event.stopPropagation();
        const ref = this.matDialog.open<MoveBookDialogComponent, MoveBookDialogData, string | undefined>(
            MoveBookDialogComponent,
            {
                data: {
                    bookName: book.name,
                    currentCollectionId: book.collectionId,
                    collections: this.collectionService.collections()
                }
            }
        );
        const targetId = await firstValueFrom(ref.afterClosed());
        if (!targetId) return;
        try {
            await this.collectionService.moveBook(book.id, targetId);
            await this.loadBooks();
            // Accordion: surface the destination exclusively after the move.
            this.expandedIds.set(new Set([targetId]));
        } catch (e) {
            await this.dialog.alert((e as Error).message);
        }
    }

    private async promptName(title: string, initialName = ''): Promise<string | null> {
        const ref = this.matDialog.open(SaveNameDialogComponent, {
            data: { title, initialName, placeholder: this.t('promptNamePlaceholder') } as SaveNameDialogData,
            width: '400px'
        });
        const result = await firstValueFrom(ref.afterClosed());
        if (typeof result !== 'string') return null;
        const trimmed = result.trim();
        return trimmed ? trimmed : null;
    }

    async startNewSession() {
        await this.session.startEmptySession();
        await this.loadBooks();
        await this.engine.startSession();
        this.closePanel.emit();
    }

    async addBookTo(collectionId: string, event: Event) {
        event.stopPropagation();
        await this.session.startEmptySession(collectionId);
        await this.loadBooks();
        await this.engine.startSession();
        this.closePanel.emit();
    }

    async createCollection() {
        const name = await this.promptName(this.t('newCollectionDialogTitle'));
        if (!name) return;
        const c = await this.collectionService.create(name);
        this.expandedIds.set(new Set([c.id]));
    }

    async renameCollection(collection: Collection, event: Event) {
        event.stopPropagation();
        const newName = await this.promptName(this.t('renameCollectionDialogTitle'), collection.name);
        if (!newName || newName === collection.name) return;
        try {
            await this.collectionService.rename(collection.id, newName);
        } catch (e) {
            await this.dialog.alert((e as Error).message);
        }
    }

    async removeCollection(collection: Collection, event: Event) {
        event.stopPropagation();
        try {
            if (!await this.dialog.confirm(this.t('deleteCollectionConfirm', { name: collection.name }))) return;
            this.tombstoneTracker.track('collection', collection.id);
            await this.collectionService.remove(collection.id);
        } catch (e) {
            await this.dialog.alert((e as Error).message);
        }
    }

    async nukeCaches() {
        if (await this.dialog.confirm(this.t('nukeCachesConfirm'))) {
            const count = await this.session.nukeAllCaches();
            await this.loadBooks();
            await this.dialog.alert(this.t('nukeCachesSuccess', { count }));
        }
    }

    async openAdvancedSyncTools() {
        const backendId = this.syncBackends.activeBackendId();
        if (!this.syncBackends.isReady(backendId)) {
            await this.dialog.alert(this.t('backendNotReady'));
            return;
        }
        const { AdvancedSyncToolsDialogComponent } = await import(
            '@app/shared/components/advanced-sync-tools-dialog/advanced-sync-tools-dialog.component'
        );
        const ref = this.matDialog.open(AdvancedSyncToolsDialogComponent, {
            width: '720px',
            maxWidth: '95vw',
            maxHeight: '90vh',
            autoFocus: false
        });
        await firstValueFrom(ref.afterClosed());
        // Reload book list in case the dialog applied a force-pull or restore.
        await this.loadBooks();
    }

    syncAllToCloud() {
        return this.runDirectionalSync('two-way');
    }

    pullFromCloud() {
        return this.runDirectionalSync('pull-only');
    }

    pushToCloud() {
        return this.runDirectionalSync('push-only');
    }

    private async runDirectionalSync(direction: SyncDirection) {
        const backendId = this.syncBackends.activeBackendId();
        if (!this.syncBackends.isReady(backendId)) {
            await this.dialog.alert(this.t('backendNotReady'));
            return;
        }

        const backendLabel = backendId === 's3' ? 'S3' : 'Drive';
        this.loading.show(this.t('syncingWith', { backend: backendLabel }));
        try {
            const report = await this.syncService.syncAll(direction);
            await this.loadBooks();
            const summary = this.t('syncSummaryFormat', {
                uploaded: report.uploaded,
                downloaded: report.downloaded,
                deleted: report.deleted,
            });
            if (report.errors.length > 0) {
                console.error('[BookList] Sync finished with errors:', report.errors);
                const sample = report.errors[0];
                this.snackBar.open(
                    this.t('syncErrorSample', {
                        count: report.errors.length,
                        op: sample.op,
                        resource: sample.resource,
                        id: sample.id.slice(0, 8),
                        message: sample.message,
                        summary,
                    }),
                    this.i18n.translate('ui.CLOSE'),
                    { panelClass: ['snackbar-error'] }
                );
            } else {
                this.snackBar.open(this.t('syncCompleteSummary', { summary }), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
            }
        } catch (e) {
            console.error('[BookList] Sync failed', e);
            this.snackBar.open(
                this.t('syncFailedSummary', { error: (e as { message?: string })?.message || 'Unknown error' }),
                this.i18n.translate('ui.CLOSE'),
            );
        } finally {
            this.loading.hide();
        }
    }

    closePanel = output<void>();
}
