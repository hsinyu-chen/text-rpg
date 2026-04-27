import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SyncService } from '../sync.service';
import { RemoteEntry, SyncResource } from '../sync.types';

type ViewerTab = 'book' | 'collection' | 'settings';

interface DisplayEntry extends RemoteEntry {
    /** Lazily populated from the JSON body's `name` field once fetched. */
    name?: string;
}

@Component({
    selector: 'app-s3-file-viewer-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatIconModule,
        MatTabsModule,
        MatProgressSpinnerModule,
        MatFormFieldModule,
        MatInputModule
    ],
    templateUrl: './s3-file-viewer-dialog.component.html',
    styleUrl: './s3-file-viewer-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class S3FileViewerDialogComponent implements OnInit {
    private sync = inject(SyncService);
    private snackBar = inject(MatSnackBar);
    dialogRef = inject(MatDialogRef<S3FileViewerDialogComponent>);

    activeTab = signal<ViewerTab>('book');
    bookEntries = signal<DisplayEntry[]>([]);
    collectionEntries = signal<DisplayEntry[]>([]);
    settingsContent = signal<string | null>(null);
    settingsModifiedAt = signal<number | null>(null);
    listLoading = signal(false);
    detailLoading = signal(false);
    selectedId = signal<string | null>(null);
    detailRaw = signal<string | null>(null);
    detailError = signal<string | null>(null);
    filter = signal('');

    currentEntries = computed<DisplayEntry[]>(() => {
        const tab = this.activeTab();
        const list = tab === 'book' ? this.bookEntries() : this.collectionEntries();
        const q = this.filter().trim().toLowerCase();
        if (!q) return list;
        return list.filter(e => e.id.toLowerCase().includes(q) || (e.name?.toLowerCase().includes(q) ?? false));
    });

    detailPretty = computed(() => {
        const raw = this.detailRaw();
        if (!raw) return null;
        try {
            return JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
            return raw; // not JSON for some reason; show as-is
        }
    });

    async ngOnInit(): Promise<void> {
        await this.loadList('book');
    }

    async onTabChange(index: number): Promise<void> {
        const tab: ViewerTab = index === 0 ? 'book' : index === 1 ? 'collection' : 'settings';
        this.activeTab.set(tab);
        this.selectedId.set(null);
        this.detailRaw.set(null);
        this.detailError.set(null);
        this.filter.set('');
        if (tab === 'settings') {
            await this.loadSettings();
        } else if (tab === 'book' && this.bookEntries().length === 0) {
            await this.loadList('book');
        } else if (tab === 'collection' && this.collectionEntries().length === 0) {
            await this.loadList('collection');
        }
    }

    private async loadList(resource: SyncResource): Promise<void> {
        this.listLoading.set(true);
        try {
            const backend = await this.sync.getS3Backend();
            const entries = await backend.list(resource);
            entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
            if (resource === 'book') this.bookEntries.set(entries);
            else this.collectionEntries.set(entries);
            // Fire-and-forget: hydrate display names. Each fetch is one GET so
            // we cap parallelism to be polite to the backend.
            void this.hydrateNames(resource, entries);
        } catch (e) {
            this.snackBar.open('Failed to list: ' + ((e as { message?: string })?.message || 'Unknown'), 'Close', { duration: 5000 });
        } finally {
            this.listLoading.set(false);
        }
    }

    private async hydrateNames(resource: SyncResource, entries: RemoteEntry[]): Promise<void> {
        const backend = await this.sync.getS3Backend();
        const limit = 4;
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, entries.length) }, async () => {
            while (cursor < entries.length) {
                const i = cursor++;
                const e = entries[i];
                try {
                    const json = await backend.read(resource, e.id);
                    const parsed = JSON.parse(json) as { name?: string };
                    if (parsed?.name) {
                        // Atomic update: workers run in parallel, so a
                        // read-then-set pattern would race and lose updates.
                        // signal.update receives the latest value each call.
                        const target = resource === 'book' ? this.bookEntries : this.collectionEntries;
                        const name = parsed.name;
                        target.update(list => {
                            const idx = list.findIndex(x => x.id === e.id);
                            if (idx === -1) return list;
                            const next = list.slice();
                            next[idx] = { ...next[idx], name };
                            return next;
                        });
                    }
                } catch {
                    // ignore per-entry name fetch failures; the row is still selectable
                }
            }
        });
        await Promise.all(workers);
    }

    async loadDetail(entry: DisplayEntry): Promise<void> {
        const tab = this.activeTab();
        if (tab === 'settings') return;
        this.selectedId.set(entry.id);
        this.detailRaw.set(null);
        this.detailError.set(null);
        this.detailLoading.set(true);
        try {
            const backend = await this.sync.getS3Backend();
            const raw = await backend.read(tab, entry.id);
            this.detailRaw.set(raw);
        } catch (e) {
            this.detailError.set((e as { message?: string })?.message || 'Read failed');
        } finally {
            this.detailLoading.set(false);
        }
    }

    private async loadSettings(): Promise<void> {
        this.detailLoading.set(true);
        this.detailError.set(null);
        try {
            const backend = await this.sync.getS3Backend();
            const content = await backend.readSettings();
            this.settingsContent.set(content);
        } catch (e) {
            this.detailError.set((e as { message?: string })?.message || 'Read failed');
        } finally {
            this.detailLoading.set(false);
        }
    }

    async refresh(): Promise<void> {
        const tab = this.activeTab();
        if (tab === 'settings') {
            await this.loadSettings();
        } else {
            // Force re-list by clearing the cache for this resource.
            if (tab === 'book') this.bookEntries.set([]);
            else this.collectionEntries.set([]);
            this.selectedId.set(null);
            this.detailRaw.set(null);
            await this.loadList(tab);
        }
    }

    copyDetail(): void {
        const text = this.activeTab() === 'settings' ? (this.settingsContent() ?? '') : (this.detailPretty() ?? '');
        if (!text) return;
        navigator.clipboard?.writeText(text)
            .then(() => this.snackBar.open('Copied.', 'OK', { duration: 1500 }))
            .catch(() => this.snackBar.open('Copy failed.', 'Close', { duration: 3000 }));
    }

    formatBytes(n: number | undefined): string {
        if (n === undefined) return '—';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    formatDate(ms: number | null | undefined): string {
        if (!ms) return '—';
        const d = new Date(ms);
        return d.toLocaleString();
    }

    shortId(id: string): string {
        return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
    }

    close(): void {
        this.dialogRef.close();
    }
}
