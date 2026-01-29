import { Component, inject, signal, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { SessionService } from '../../../../core/services/session.service';
import { StorageService } from '../../../../core/services/storage.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { CostService } from '../../../../core/services/cost.service';
import { LLMProviderRegistryService } from '../../../../core/services/llm-provider-registry.service';
import { Book } from '../../../../core/models/types';
import { DialogService } from '../../../../core/services/dialog.service';
import { GoogleDriveService } from '../../../../core/services/google-drive.service';
import { LoadingService } from '../../../../core/services/loading.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

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
        <mat-list>
            @for (book of books(); track book.id) {
                <mat-list-item [class.active-book]="isActive(book.id)" (click)="switchBook(book.id)">
                    <mat-icon matListItemIcon class="book-icon">
                        {{ isActive(book.id) ? 'auto_stories' : 'book' }}
                    </mat-icon>
                    
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

            @if (books().length === 0) {
                <div class="empty-state">
                    <mat-icon>menu_book</mat-icon>
                    <p>No books found. Start a new adventure!</p>
                </div>
            }
        </mat-list>
      </div>

      <div class="footer-actions">
           <button mat-flat-button color="primary" class="new-game-btn" (click)="startNewSession()">
                <mat-icon>add_circle</mat-icon>
                New Session
           </button>
           
            <button mat-stroked-button color="warn" class="nuke-btn" (click)="nukeCaches()">
                <mat-icon>delete_forever</mat-icon>
                Nuke All Caches
            </button>

            <button mat-stroked-button class="sync-btn" (click)="syncAllToCloud()" [disabled]="state.isBusy()">
                <mat-icon>cloud_sync</mat-icon>
                Sync All to Cloud
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
    .cost-stats {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
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
    .book-scroll {
        flex: 1;
        overflow-y: auto;
    }
    .active-book {
        background: rgba(var(--mat-primary-rgb), 0.1);
        border-left: 4px solid var(--mat-primary-color);
    }
    .book-title {
        font-weight: 500;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: normal;
        max-width: 220px; /* Ensure title truncates before overlapping buttons */
        line-height: 1.2;
    }
    .book-meta {
        font-size: 0.8em;
        opacity: 0.7;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .cache-badge {
        color: #4caf50;
        display: inline-flex;
    }
    .tiny-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
    }
    .footer-actions {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid rgba(255,255,255,0.1);
    }
    .new-game-btn {
        width: 100%;
        height: 48px;
    }
    .nuke-btn {
        width: 100%;
    }
    .sync-btn {
        width: 100%;
        color: #4285f4;
        border-color: rgba(66, 133, 244, 0.5);
        &:hover {
            background: rgba(66, 133, 244, 0.05);
        }
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
    session = inject(SessionService);
    storage = inject(StorageService);
    state = inject(GameStateService);
    costService = inject(CostService);
    providerRegistry = inject(LLMProviderRegistryService);
    dialog = inject(DialogService);
    matDialog = inject(MatDialog);
    drive = inject(GoogleDriveService);
    loading = inject(LoadingService);
    snackBar = inject(MatSnackBar);

    books = signal<Book[]>([]);

    // Calculate active session cost the same way as sidebar-cost-prediction
    private activeSessionCost = computed(() => {
        const activeProvider = this.providerRegistry.getActive();
        const activeModelId = this.state.config()?.modelId || activeProvider?.getDefaultModelId();
        const model = activeProvider?.getAvailableModels().find(m => m.id === activeModelId);
        if (!model) return 0;

        const messages = this.state.messages();
        const sunkHistory = this.state.sunkUsageHistory();

        // Transaction cost from active messages
        const activeTxn = this.costService.calculateSessionTransactionCost(messages, model);

        // Sunk transaction cost
        let sunkTxn = 0;
        for (const usage of sunkHistory) {
            sunkTxn += this.costService.calculateTurnCost({
                prompt: usage.prompt,
                cached: usage.cached,
                candidates: usage.candidates
            }, model.id);
        }

        // Storage cost
        const activeUsage = this.state.storageUsageAccumulated();
        const historyUsage = this.state.historyStorageUsageAccumulated();
        const storageCost = this.costService.calculateStorageCost(activeUsage + historyUsage, model.id);

        return activeTxn + sunkTxn + storageCost;
    });

    // 7-Day Cost Statistics (computed from books signal + active session real-time cost)
    weeklyStats = computed(() => {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const activeBookId = this.session.currentBookId();
        const recentBooks = this.books().filter(b => b.lastActiveAt >= sevenDaysAgo);

        // For the active book, use real-time calculated cost; for others, use saved cost
        let totalCost = 0;
        for (const book of recentBooks) {
            if (book.id === activeBookId) {
                // Use real-time calculated cost (same as sidebar-cost-prediction)
                totalCost += this.activeSessionCost();
            } else {
                totalCost += book.stats.estimatedCost || 0;
            }
        }

        return {
            bookCount: recentBooks.length,
            totalCost
        };
    });

    // Currency formatting helpers
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

    constructor() {
        this.loadBooks();
    }

    async loadBooks() {
        const list = await this.storage.getBooks();
        console.log('[BookList] Loaded books:', list.length);
        // Sort by last active descending
        this.books.set(list.sort((a, b) => b.lastActiveAt - a.lastActiveAt));
    }

    isActive(id: string): boolean {
        return this.session.currentBookId() === id;
    }

    async switchBook(id: string) {
        if (this.isActive(id)) return;

        // Auto-save current is handled by loadBook -> unloadCurrentSession(true)
        await this.session.loadBook(id);

        // Refresh list to update "last active" timestamps and sync any changes
        await this.loadBooks();
    }

    async deleteBook(book: Book, event: Event) {
        event.stopPropagation();

        const wasActive = this.isActive(book.id);
        const confirmMsg = wasActive
            ? `Delete the ACTIVE book "${book.name}"?\nYou will be switched to another book automatically.`
            : `Are you sure you want to delete "${book.name}"?\nThis cannot be undone.`;

        if (!await this.dialog.confirm(confirmMsg)) return;

        // Track deletion for cloud sync
        this.trackDeletion(book.id);

        // Check for server cache
        if (book.stats.kbCacheName) {
            if (await this.dialog.confirm('This book has an associated Cloud Cache active. Do you want to remove it from the server to avoid costs?')) {
                // TODO: Implement robust remote cache deletion for specific books
            }
        }

        await this.session.deleteBook(book.id);
        await this.loadBooks();

        // If we deleted the active book, switch to the most recent remaining book
        if (wasActive) {
            const remaining = this.books();
            if (remaining.length > 0) {
                await this.session.loadBook(remaining[0].id); // Already sorted by lastActiveAt desc
            }
            // If no books remain, currentBookId is now null (handled by UI)
        }
    }

    async renameBook(book: Book, event: Event) {
        event.stopPropagation();

        const newName = prompt('Enter new book name:', book.name);
        if (newName && newName.trim() && newName !== book.name) {
            await this.session.renameBook(book.id, newName.trim());
            await this.loadBooks();
        }
    }

    async startNewSession() {
        await this.session.startEmptySession();
        await this.loadBooks();
        this.closePanel.emit();
    }

    async nukeCaches() {
        if (await this.dialog.confirm('WARNING: This will delete ALL caches on the server for your API Key. This resolves "Session Expired" issues but resets billing for all books. Continue?')) {
            const count = await this.session.nukeAllCaches();
            await this.dialog.alert(`Cleared ${count} caches.`);
        }
    }

    private trackDeletion(id: string) {
        const key = 'pending_book_deletions';
        const deletions: string[] = JSON.parse(localStorage.getItem(key) || '[]');
        if (!deletions.includes(id)) {
            deletions.push(id);
            localStorage.setItem(key, JSON.stringify(deletions));
        }
    }

    async syncAllToCloud() {
        if (!this.drive.isConfigured) {
            await this.dialog.alert('Cloud sync is not configured. Please check your Client ID setting.');
            return;
        }

        this.loading.show('Synchronizing books with Cloud...');
        try {
            // 1. Authenticate
            await this.drive.login();

            // 2. Ensure "books_v1" folder exists in AppData
            const appDataFiles = await this.drive.listFolders('appDataFolder');
            const booksFolder = appDataFiles.find(f => f.name === 'books_v1');
            let booksFolderId: string;

            if (!booksFolder) {
                const newFolder = await this.drive.createFolder('appDataFolder', 'books_v1');
                booksFolderId = newFolder.id;
            } else {
                booksFolderId = booksFolder.id;
            }

            // 3. List Local & Remote
            const localBooks = await this.storage.getBooks();
            const remoteFiles = await this.drive.listFiles(booksFolderId);

            let uploadCount = 0;
            let downloadCount = 0;
            let deleteCount = 0;

            // 3.5 Process Pending Deletions
            const deletionKey = 'pending_book_deletions';
            const pendingDeletions: string[] = JSON.parse(localStorage.getItem(deletionKey) || '[]');
            const remainingDeletions: string[] = [...pendingDeletions];

            for (const id of pendingDeletions) {
                const remoteIndex = remoteFiles.findIndex(f => f.name === `${id}.json`);
                if (remoteIndex > -1) {
                    const remoteFile = remoteFiles[remoteIndex];
                    try {
                        await this.drive.deleteSaveFromDrive(remoteFile.id);
                        deleteCount++;
                        // Remove from the local array to prevent processing in next loops
                        remoteFiles.splice(remoteIndex, 1);
                    } catch (err) {
                        console.warn(`[BookList] Failed to delete remote book ${id}`, err);
                    }
                }
                const index = remainingDeletions.indexOf(id);
                if (index > -1) remainingDeletions.splice(index, 1);
            }
            localStorage.setItem(deletionKey, JSON.stringify(remainingDeletions));

            // 4. Local to Cloud (Upload/Update)
            for (const local of localBooks) {
                const remoteFile = remoteFiles.find(f => f.name === `${local.id}.json`);
                if (!remoteFile) {
                    // New in Cloud
                    await this.drive.createFile(booksFolderId, `${local.id}.json`, JSON.stringify(local));
                    uploadCount++;
                } else {
                    // Compare timestamps
                    const remoteModified = remoteFile.modifiedTime ? new Date(remoteFile.modifiedTime).getTime() : 0;
                    // Note: Google Drive modifiedTime is when the file was last updated in Drive.
                    // Local book lastActiveAt is our logical "modified time".
                    if (local.lastActiveAt > remoteModified + 5000) { // 5s buffer for clock skew
                        await this.drive.updateFile(remoteFile.id, JSON.stringify(local));
                        uploadCount++;
                    }
                }
            }

            // 5. Cloud to Local (Download/Update)
            for (const remote of remoteFiles) {
                if (!remote.name.endsWith('.json')) continue;
                const bookId = remote.name.replace('.json', '');
                const local = localBooks.find(b => b.id === bookId);

                const remoteModified = remote.modifiedTime ? new Date(remote.modifiedTime).getTime() : 0;

                if (!local || remoteModified > local.lastActiveAt + 5000) {
                    const content = await this.drive.readFile(remote.id);
                    const remoteBook = JSON.parse(content) as Book;
                    await this.storage.saveBook(remoteBook);
                    downloadCount++;
                }
            }

            // 6. Refresh List
            await this.loadBooks();

            this.snackBar.open(`Sync Complete! Uploaded: ${uploadCount}, Downloaded: ${downloadCount}, Deleted: ${deleteCount}`, 'OK', { duration: 3000 });
        } catch (e) {
            console.error('[BookList] Sync failed', e);
            this.snackBar.open('Sync failed: ' + ((e as { message?: string })?.message || 'Unknown error'), 'Close');
        } finally {
            this.loading.hide();
        }
    }

    closePanel = output<void>();
}
