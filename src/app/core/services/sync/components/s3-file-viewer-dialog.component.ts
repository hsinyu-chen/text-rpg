import { ChangeDetectionStrategy, Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
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
import { ScrollingModule } from '@angular/cdk/scrolling';
import { SyncService } from '../sync.service';
import { RemoteEntry, SyncResource } from '../sync.types';

type ViewerTab = 'book' | 'collection' | 'settings' | 'prompts';

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
        MatInputModule,
        ScrollingModule
    ],
    templateUrl: './s3-file-viewer-dialog.component.html',
    styleUrl: './s3-file-viewer-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class S3FileViewerDialogComponent {
    private sync = inject(SyncService);
    private snackBar = inject(MatSnackBar);
    private clipboard = inject(Clipboard);
    dialogRef = inject(MatDialogRef<S3FileViewerDialogComponent>);

    constructor() {
        afterNextRender(() => { void this.loadList('book'); });
    }

    activeTab = signal<ViewerTab>('book');
    bookEntries = signal<DisplayEntry[]>([]);
    collectionEntries = signal<DisplayEntry[]>([]);
    settingsContent = signal<string | null>(null);
    settingsModifiedAt = signal<number | null>(null);
    promptsContent = signal<string | null>(null);

    /** True for tabs that show a single JSON file rather than a list. */
    isSingleFileTab = computed(() => this.activeTab() === 'settings' || this.activeTab() === 'prompts');
    singleFileContent = computed(() =>
        this.activeTab() === 'settings' ? this.settingsContent()
        : this.activeTab() === 'prompts' ? this.promptsContent()
        : null
    );
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

    async onTabChange(index: number): Promise<void> {
        const tab: ViewerTab = index === 0 ? 'book'
            : index === 1 ? 'collection'
            : index === 2 ? 'settings'
            : 'prompts';
        this.activeTab.set(tab);
        this.selectedId.set(null);
        this.detailRaw.set(null);
        this.detailError.set(null);
        this.filter.set('');
        if (tab === 'settings') {
            await this.loadSettings();
        } else if (tab === 'prompts') {
            await this.loadPrompts();
        } else if (tab === 'book' && this.bookEntries().length === 0) {
            await this.loadList('book');
        } else if (tab === 'collection' && this.collectionEntries().length === 0) {
            await this.loadList('collection');
        }
    }

    // Lazy name hydration. We don't fetch every body upfront — that's a
    // ton of bandwidth on a list page that may never render those rows.
    // Instead the virtual scroll viewport tells us when its visible window
    // changes (`onScrolledIndexChange`); we enqueue the visible range plus
    // a small buffer and a fixed pool of 4 workers drains the queue.
    //
    // `done` tracks ids we've already attempted; an id never gets re-fetched
    // even if the row scrolls back into view. Reset on (re)load and refresh.
    private hydrationDone = new Map<SyncResource, Set<string>>();
    private hydrationQueue = new Map<SyncResource, Set<string>>();
    private hydrationActiveCount = 0;
    private static readonly HYDRATION_CONCURRENCY = 4;
    private static readonly HYDRATION_VIEWPORT_AHEAD = 24;
    private static readonly HYDRATION_VIEWPORT_BUFFER = 8;

    private async loadList(resource: SyncResource): Promise<void> {
        this.listLoading.set(true);
        try {
            const backend = await this.sync.getS3Backend();
            const entries = await backend.list(resource);
            entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
            if (resource === 'book') this.bookEntries.set(entries);
            else this.collectionEntries.set(entries);
            // Reset hydration state for this resource and prime the first
            // viewport's worth of entries so the user sees names without
            // having to scroll first.
            this.hydrationDone.set(resource, new Set());
            this.hydrationQueue.set(resource, new Set());
            const initialIds = entries.slice(0, S3FileViewerDialogComponent.HYDRATION_VIEWPORT_AHEAD).map(e => e.id);
            this.enqueueHydration(resource, initialIds);
        } catch (e) {
            this.snackBar.open('Failed to list: ' + ((e as { message?: string })?.message || 'Unknown'), 'Close', { duration: 5000 });
        } finally {
            this.listLoading.set(false);
        }
    }

    onScrolledIndexChange(start: number): void {
        const tab = this.activeTab();
        if (tab !== 'book' && tab !== 'collection') return;
        const list = tab === 'book' ? this.bookEntries() : this.collectionEntries();
        const buf = S3FileViewerDialogComponent.HYDRATION_VIEWPORT_BUFFER;
        const ahead = S3FileViewerDialogComponent.HYDRATION_VIEWPORT_AHEAD;
        const lo = Math.max(0, start - buf);
        const hi = Math.min(list.length, start + ahead + buf);
        const ids = list.slice(lo, hi).map(e => e.id);
        this.enqueueHydration(tab, ids);
    }

    private enqueueHydration(resource: SyncResource, ids: string[]): void {
        const done = this.hydrationDone.get(resource) ?? new Set<string>();
        const queue = this.hydrationQueue.get(resource) ?? new Set<string>();
        this.hydrationDone.set(resource, done);
        this.hydrationQueue.set(resource, queue);
        for (const id of ids) {
            if (done.has(id) || queue.has(id)) continue;
            queue.add(id);
        }
        this.kickHydrationWorkers(resource);
    }

    private kickHydrationWorkers(resource: SyncResource): void {
        while (this.hydrationActiveCount < S3FileViewerDialogComponent.HYDRATION_CONCURRENCY) {
            const queue = this.hydrationQueue.get(resource);
            if (!queue || queue.size === 0) return;
            const id = queue.values().next().value as string;
            queue.delete(id);
            const done = this.hydrationDone.get(resource);
            done?.add(id);
            this.hydrationActiveCount++;
            void this.fetchOneName(resource, id).finally(() => {
                this.hydrationActiveCount--;
                this.kickHydrationWorkers(resource);
            });
        }
    }

    private async fetchOneName(resource: SyncResource, id: string): Promise<void> {
        try {
            const backend = await this.sync.getS3Backend();
            const json = await backend.read(resource, id);
            const parsed = JSON.parse(json) as { name?: string };
            if (!parsed?.name) return;
            const target = resource === 'book' ? this.bookEntries : this.collectionEntries;
            const name = parsed.name;
            target.update(list => {
                const idx = list.findIndex(x => x.id === id);
                if (idx === -1) return list;
                const next = list.slice();
                next[idx] = { ...next[idx], name };
                return next;
            });
        } catch {
            // ignore per-entry name fetch failures; the row is still selectable
        }
    }

    async loadDetail(entry: DisplayEntry): Promise<void> {
        const tab = this.activeTab();
        if (tab !== 'book' && tab !== 'collection') return;
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

    private async loadPrompts(): Promise<void> {
        this.detailLoading.set(true);
        this.detailError.set(null);
        try {
            const backend = await this.sync.getS3Backend();
            const content = await backend.readPrompts();
            this.promptsContent.set(content);
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
        } else if (tab === 'prompts') {
            await this.loadPrompts();
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
        const text = this.isSingleFileTab() ? (this.singleFileContent() ?? '') : (this.detailPretty() ?? '');
        if (!text) return;
        if (this.clipboard.copy(text)) {
            this.snackBar.open('Copied.', 'OK', { duration: 1500 });
        } else {
            this.snackBar.open('Copy failed.', 'Close', { duration: 3000 });
        }
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

    trackById(_index: number, e: DisplayEntry): string {
        return e.id;
    }

    close(): void {
        this.dialogRef.close();
    }
}
