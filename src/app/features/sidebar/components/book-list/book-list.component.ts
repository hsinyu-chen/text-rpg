import { Component, inject, signal, output, computed, linkedSignal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
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

interface BookGroup {
    collection: Collection;
    books: Book[];
}

@Component({
    selector: 'app-book-list',
    standalone: true,
    imports: [
        CommonModule,
        MatButtonModule,
        MatIconModule,
        MatListModule,
        MatTooltipModule,
        MatDividerModule,
        MatProgressSpinnerModule
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

    readonly rootId = ROOT_COLLECTION_ID;

    books = signal<Book[]>([]);

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
    }

    async loadBooks() {
        await this.collectionService.load();
        const list = await this.bookRepo.list();
        console.log('[BookList] Loaded books:', list.length);
        this.books.set(list);
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
        const confirmMsg = wasActive
            ? `Delete the ACTIVE book "${book.name}"?\nYou will be switched to another book automatically.`
            : `Are you sure you want to delete "${book.name}"?\nThis cannot be undone.`;

        if (!await this.dialog.confirm(confirmMsg)) return;

        this.tombstoneTracker.track('book', book.id);

        if (book.stats.kbCacheName) {
            if (await this.dialog.confirm('This book has an associated Cloud Cache active. Do you want to remove it from the server to avoid costs?')) {
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
        const newName = await this.promptName('Rename Book', book.name);
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
            data: { title, initialName, placeholder: 'Enter name' } as SaveNameDialogData,
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
        const name = await this.promptName('New Collection');
        if (!name) return;
        const c = await this.collectionService.create(name);
        this.expandedIds.set(new Set([c.id]));
    }

    async renameCollection(collection: Collection, event: Event) {
        event.stopPropagation();
        const newName = await this.promptName('Rename Collection', collection.name);
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
            if (!await this.dialog.confirm(`Delete empty collection "${collection.name}"?`)) return;
            this.tombstoneTracker.track('collection', collection.id);
            await this.collectionService.remove(collection.id);
        } catch (e) {
            await this.dialog.alert((e as Error).message);
        }
    }

    async nukeCaches() {
        if (await this.dialog.confirm('WARNING: This will delete ALL caches on the server for your API Key. This resolves "Session Expired" issues but resets billing for all books. Continue?')) {
            const count = await this.session.nukeAllCaches();
            await this.loadBooks();
            await this.dialog.alert(`Cleared ${count} caches.`);
        }
    }

    async openAdvancedSyncTools() {
        const backendId = this.syncBackends.activeBackendId();
        if (!this.syncBackends.isReady(backendId)) {
            await this.dialog.alert('The selected sync backend is not ready. Open Settings to configure it.');
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

    async syncAllToCloud() {
        const backendId = this.syncBackends.activeBackendId();
        if (!this.syncBackends.isReady(backendId)) {
            await this.dialog.alert('The selected sync backend is not ready. Open Settings to configure it.');
            return;
        }

        this.loading.show(`Synchronizing with ${backendId === 's3' ? 'S3' : 'Drive'}...`);
        try {
            const report = await this.syncService.syncAll();
            await this.loadBooks();
            const summary = `Uploaded: ${report.uploaded}, Downloaded: ${report.downloaded}, Deleted: ${report.deleted}`;
            if (report.errors.length > 0) {
                console.error('[BookList] Sync finished with errors:', report.errors);
                const sample = report.errors[0];
                this.snackBar.open(
                    `Sync had ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} — see console. ` +
                    `e.g. ${sample.op} ${sample.resource} ${sample.id.slice(0, 8)}: ${sample.message}. ${summary}`,
                    'Close',
                    { panelClass: ['snackbar-error'] }
                );
            } else {
                this.snackBar.open(`Sync Complete! ${summary}`, 'OK', { duration: 3000 });
            }
        } catch (e) {
            console.error('[BookList] Sync failed', e);
            this.snackBar.open('Sync failed: ' + ((e as { message?: string })?.message || 'Unknown error'), 'Close');
        } finally {
            this.loading.hide();
        }
    }

    closePanel = output<void>();
}
