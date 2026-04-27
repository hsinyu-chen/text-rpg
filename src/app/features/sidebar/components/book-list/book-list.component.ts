import { Component, inject, signal, output, computed, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { SessionService } from '../../../../core/services/session.service';
import { StorageService } from '../../../../core/services/storage.service';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { CostService } from '../../../../core/services/cost.service';
import { LLMProviderRegistryService } from '../../../../core/services/llm-provider-registry.service';
import { Book, Collection, ROOT_COLLECTION_ID } from '../../../../core/models/types';
import { DialogService } from '../../../../core/services/dialog.service';
import { LoadingService } from '../../../../core/services/loading.service';
import { CollectionService } from '../../../../core/services/collection.service';
import { SyncService } from '../../../../core/services/sync/sync.service';
import { SaveNameDialogComponent, SaveNameDialogData } from '../../../../shared/components/save-name-dialog/save-name-dialog.component';
import { MoveBookDialogComponent, MoveBookDialogData } from '../../../../shared/components/move-book-dialog/move-book-dialog.component';
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
    template: `
    <div class="book-list-container">
      <div class="header">
        <h3>Adventure Books</h3>
        <button mat-icon-button (click)="closePanel.emit()">
            <mat-icon>close</mat-icon>
        </button>
      </div>

      <!-- 7-Day Cost Summary -->
      <div class="cost-summary">
        <div class="cost-header">
            <mat-icon>analytics</mat-icon>
            <span>7-Day Summary</span>
        </div>
        <div class="cost-stats">
            <div class="cost-row">
                <span>Books Active:</span>
                <span class="val">{{ weeklyStats().bookCount }}</span>
            </div>
            <div class="cost-row total">
                <span>Total Cost:</span>
                <span class="val">{{ formatCost(weeklyStats().totalCost) }}</span>
            </div>
        </div>
      </div>

      <div class="book-scroll">
        @for (group of bookGroups(); track group.collection.id) {
            <div class="collection-group">
                <div class="collection-header"
                    [class.active-collection]="group.collection.id === activeCollectionId()"
                    role="button"
                    tabindex="0"
                    (click)="toggleCollection(group.collection.id)"
                    (keydown.enter)="toggleCollection(group.collection.id)"
                    (keydown.space)="$event.preventDefault(); toggleCollection(group.collection.id)">
                    <mat-icon class="caret">
                        {{ isExpanded(group.collection.id) ? 'expand_more' : 'chevron_right' }}
                    </mat-icon>
                    <mat-icon class="folder-icon">
                        {{ group.collection.id === rootId ? 'inbox' : 'folder' }}
                    </mat-icon>
                    <span class="collection-name">{{ group.collection.name }}</span>
                    <span class="collection-count">({{ group.books.length }})</span>
                    <span class="spacer"></span>
                    <button mat-icon-button class="header-btn"
                        (click)="addBookTo(group.collection.id, $event)"
                        matTooltip="New session in this collection">
                        <mat-icon>add</mat-icon>
                    </button>
                    @if (group.collection.id !== rootId) {
                        <button mat-icon-button class="header-btn"
                            (click)="renameCollection(group.collection, $event)"
                            matTooltip="Rename collection">
                            <mat-icon>drive_file_rename_outline</mat-icon>
                        </button>
                        <button mat-icon-button class="header-btn" color="warn"
                            (click)="removeCollection(group.collection, $event)"
                            [matTooltip]="group.books.length > 0 ? 'Move/delete its books first' : 'Delete collection'">
                            <mat-icon>folder_delete</mat-icon>
                        </button>
                    }
                </div>

                @if (isExpanded(group.collection.id)) {
                    <mat-list class="book-sublist">
                        @for (book of group.books; track book.id) {
                            <mat-list-item [class.active-book]="isActive(book.id)" (click)="switchBook(book.id)">
                                <div matListItemTitle class="book-title">
                                    {{ book.name }}
                                </div>

                                <div matListItemLine class="book-meta">
                                    <span>{{ book.lastActiveAt | date:'short' }}</span>
                                    @if (book.stats.kbCacheName) {
                                        <span class="cache-badge" matTooltip="Active Cloud Cache">
                                            <mat-icon class="tiny-icon">cloud_done</mat-icon>
                                        </span>
                                    }
                                </div>

                                <div matListItemMeta>
                                    <button mat-icon-button (click)="moveBook(book, $event)"
                                        matTooltip="Move to another collection">
                                        <mat-icon>drive_file_move</mat-icon>
                                    </button>
                                    <button mat-icon-button (click)="renameBook(book, $event)"
                                        matTooltip="Rename Book">
                                        <mat-icon>edit</mat-icon>
                                    </button>
                                    <button mat-icon-button color="warn" (click)="deleteBook(book, $event)"
                                        [matTooltip]="isActive(book.id) ? 'Delete Active Book (will switch to another)' : 'Delete Book'">
                                        <mat-icon>delete</mat-icon>
                                    </button>
                                </div>
                            </mat-list-item>
                            <mat-divider></mat-divider>
                        }

                        @if (group.books.length === 0) {
                            <div class="empty-collection">No books in this collection</div>
                        }
                    </mat-list>
                }
            </div>
        }

        @if (totalBookCount() === 0) {
            <div class="empty-state">
                <mat-icon>menu_book</mat-icon>
                <p>No books found. Start a new adventure!</p>
            </div>
        }
      </div>

      <div class="footer-actions">
           <button mat-flat-button color="primary" class="new-game-btn" (click)="startNewSession()">
                <mat-icon>add_circle</mat-icon>
                New Session
           </button>

           <button mat-stroked-button class="new-collection-btn" (click)="createCollection()">
                <mat-icon>create_new_folder</mat-icon>
                New Collection
           </button>

            <button mat-stroked-button color="warn" class="nuke-btn" (click)="nukeCaches()">
                <mat-icon>delete_forever</mat-icon>
                Nuke All Caches
            </button>

            <button mat-stroked-button class="sync-btn" (click)="syncAllToCloud()" [disabled]="state.isBusy()">
                <mat-icon>cloud_sync</mat-icon>
                Sync All ({{ syncService.activeBackendId() === 's3' ? 'S3' : 'Drive' }})
            </button>
      </div>
    </div>
  `,
    styles: [`
    .book-list-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 360px;
        background: var(--mat-sidenav-container-background-color);
    }
    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        h3 { margin: 0; }
    }
    .cost-summary {
        padding: 12px 16px;
        background: linear-gradient(135deg, rgba(76, 175, 80, 0.1) 0%, rgba(33, 150, 243, 0.1) 100%);
        border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .cost-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 500;
        margin-bottom: 8px;
        mat-icon { font-size: 18px; width: 18px; height: 18px; color: #4caf50; }
    }
    .cost-stats { display: flex; flex-direction: column; gap: 4px; }
    .cost-row {
        display: flex;
        justify-content: space-between;
        font-size: 0.85em;
        .val { font-weight: 500; }
        &.total {
            margin-top: 4px;
            padding-top: 4px;
            border-top: 1px dashed rgba(255,255,255,0.2);
            font-size: 0.95em;
            .val { color: #4caf50; font-weight: 600; }
        }
    }
    .book-scroll { flex: 1; overflow-y: auto; }

    .collection-group {
        border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .collection-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        cursor: pointer;
        background: rgba(255,255,255,0.03);
        user-select: none;
        border-left: 4px solid transparent;
        &:hover { background: rgba(255,255,255,0.06); }

        &.active-collection {
            background: rgba(var(--app-primary-rgb), 0.18);
            border-left-color: var(--app-primary);

            .folder-icon { opacity: 1; }
            .collection-name { font-weight: 600; }
        }
    }
    .collection-header .caret {
        font-size: 18px; width: 18px; height: 18px;
        opacity: 0.6;
    }
    .collection-header .folder-icon {
        font-size: 18px; width: 18px; height: 18px;
        opacity: 0.7;
    }
    .collection-name {
        font-weight: 500;
        font-size: 0.9em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 1;
        min-width: 0;
    }
    .collection-count {
        font-size: 0.8em;
        opacity: 0.6;
        flex-shrink: 0;
    }
    .spacer { flex: 1; }
    .header-btn {
        width: 28px !important;
        height: 28px !important;
        padding: 0 !important;
        min-width: 0 !important;
        flex-shrink: 0;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        mat-icon { font-size: 16px; width: 16px; height: 16px; margin: 0 !important; }
    }
    .book-sublist {
        padding: 0 !important;
        margin-left: 16px;
        border-left: 2px solid rgba(255, 255, 255, 0.08);

        mat-list-item {
            padding-inline-start: 16px !important;
        }
    }
    .empty-collection {
        padding: 12px 16px 12px 32px;
        font-size: 0.85em;
        opacity: 0.5;
        font-style: italic;
    }

    .active-book {
        background: rgba(var(--app-primary-rgb), 0.14);
        border-left: 4px solid var(--app-primary);
    }
    .book-title {
        font-weight: 500;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: normal;
        line-height: 1.2;
    }
    .book-meta {
        font-size: 0.8em;
        opacity: 0.7;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .cache-badge { color: #4caf50; display: inline-flex; }
    .tiny-icon { font-size: 14px; width: 14px; height: 14px; }

    .footer-actions {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid rgba(255,255,255,0.1);
    }
    .new-game-btn { width: 100%; height: 48px; }
    .new-collection-btn, .nuke-btn { width: 100%; }
    .sync-btn {
        width: 100%;
        color: #4285f4;
        border-color: rgba(66, 133, 244, 0.5);
        &:hover { background: rgba(66, 133, 244, 0.05); }
    }
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
        opacity: 0.5;
        gap: 16px;
        mat-icon { font-size: 48px; width: 48px; height: 48px; }
    }
  `],
})
export class BookListComponent {
    engine = inject(GameEngineService);
    session = inject(SessionService);
    storage = inject(StorageService);
    state = inject(GameStateService);
    costService = inject(CostService);
    providerRegistry = inject(LLMProviderRegistryService);
    dialog = inject(DialogService);
    matDialog = inject(MatDialog);
    loading = inject(LoadingService);
    snackBar = inject(MatSnackBar);
    collectionService = inject(CollectionService);
    syncService = inject(SyncService);

    readonly rootId = ROOT_COLLECTION_ID;

    books = signal<Book[]>([]);
    private expandedIds = signal<Set<string>>(new Set([ROOT_COLLECTION_ID]));

    totalBookCount = computed(() => this.books().length);

    activeCollectionId = computed<string | null>(() => {
        const id = this.session.currentBookId();
        if (!id) return null;
        const book = this.books().find(b => b.id === id);
        return book?.collectionId ?? null;
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
        const next = new Set(this.expandedIds());
        if (next.has(id)) next.delete(id); else next.add(id);
        this.expandedIds.set(next);
    }

    private activeSessionCost = computed(() => {
        const activeProvider = this.providerRegistry.getActive();
        const activeModelId = this.state.config()?.modelId || activeProvider?.getDefaultModelId();
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

    displayCurrency = computed(() => {
        const cfg = this.state.config();
        return (cfg?.enableConversion && cfg?.currency) ? cfg.currency : 'USD';
    });

    displayRate = computed(() => {
        const cfg = this.state.config();
        if (cfg?.enableConversion && cfg?.currency !== 'USD') {
            return cfg.exchangeRate || 30;
        }
        return 1;
    });

    formatCost(cost: number): string {
        const currency = this.displayCurrency();
        const rate = this.displayRate();
        const converted = cost * rate;
        const decimals = currency === 'USD' ? 4 : 2;
        return `${currency} ${converted.toFixed(decimals)}`;
    }

    private lastAutoExpandedFor: string | null = null;

    constructor() {
        this.loadBooks();
        // Auto-expand the collection containing the active book once per
        // book switch. Reads of expandedIds happen inside untracked() so user
        // collapses don't immediately re-trigger this and re-open the panel.
        effect(() => {
            const id = this.session.currentBookId();
            if (!id) return;
            if (id === this.lastAutoExpandedFor) return;
            const book = this.books().find(b => b.id === id);
            if (!book) return; // wait for books to hydrate
            untracked(() => {
                const cid = book.collectionId || ROOT_COLLECTION_ID;
                if (!this.expandedIds().has(cid)) {
                    const next = new Set(this.expandedIds());
                    next.add(cid);
                    this.expandedIds.set(next);
                }
                this.lastAutoExpandedFor = id;
            });
        });
    }

    async loadBooks() {
        await this.collectionService.load();
        const list = await this.storage.getBooks();
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

        this.syncService.trackDeletion('book', book.id);

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
            // Make sure the destination is visible after the move.
            const next = new Set(this.expandedIds());
            next.add(targetId);
            this.expandedIds.set(next);
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
        this.engine.startSession();
        this.closePanel.emit();
    }

    async addBookTo(collectionId: string, event: Event) {
        event.stopPropagation();
        await this.session.startEmptySession(collectionId);
        await this.loadBooks();
        this.engine.startSession();
        this.closePanel.emit();
    }

    async createCollection() {
        const name = await this.promptName('New Collection');
        if (!name) return;
        const c = await this.collectionService.create(name);
        const next = new Set(this.expandedIds());
        next.add(c.id);
        this.expandedIds.set(next);
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
            await this.collectionService.remove(collection.id);
            this.syncService.trackDeletion('collection', collection.id);
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

    async syncAllToCloud() {
        const backendId = this.syncService.activeBackendId();
        if (backendId === 's3' && !this.syncService.isS3Configured()) {
            await this.dialog.alert('S3 sync is selected but not configured. Open Settings to configure it.');
            return;
        }

        this.loading.show(`Synchronizing with ${backendId === 's3' ? 'S3' : 'Drive'}...`);
        try {
            const report = await this.syncService.syncAll();
            await this.loadBooks();
            this.snackBar.open(
                `Sync Complete! Uploaded: ${report.uploaded}, Downloaded: ${report.downloaded}, Deleted: ${report.deleted}`,
                'OK',
                { duration: 3000 }
            );
        } catch (e) {
            console.error('[BookList] Sync failed', e);
            this.snackBar.open('Sync failed: ' + ((e as { message?: string })?.message || 'Unknown error'), 'Close');
        } finally {
            this.loading.hide();
        }
    }

    closePanel = output<void>();
}
