import { Injectable, inject } from '@angular/core';
import { GoogleOAuthService } from './google-oauth.service';

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    modifiedTime?: string;
    size?: string;
    md5Checksum?: string;
    appProperties?: Record<string, string>;
}

const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,size,md5Checksum,appProperties';
const FOLDER_FIELDS = 'id,name,mimeType,parents,modifiedTime';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Drive v3 REST surface: list / read / write / copy / delete on files and
 * folders, scoped to `appDataFolder`. Authentication is delegated to
 * `GoogleOAuthService.getValidToken()`; on 401 the `execute` wrapper
 * forces a re-auth and retries once.
 */
@Injectable({ providedIn: 'root' })
export class GoogleDriveService {
    private readonly oauth = inject(GoogleOAuthService);

    /**
     * Executes a Google Drive API operation with automatic token refresh
     * on 401. The operation gets a token already-valid at call time; if
     * the API responds 401 (e.g. token revoked server-side between
     * `getValidToken` and the request landing), force a re-auth and retry
     * once with the new token.
     */
    async execute<T>(operation: (token: string) => Promise<T>): Promise<T> {
        try {
            const token = await this.oauth.getValidToken();
            return await operation(token);
        } catch (error) {
            if (GoogleOAuthService.isUnauthorized(error)) {
                const newToken = await this.oauth.forceReauthAfter401();
                return operation(newToken);
            }
            throw error;
        }
    }

    /**
     * Drive's `files.list` defaults to a page size of 100 and returns
     * `nextPageToken` when the result is truncated. Without explicit
     * pagination, callers silently miss everything past the first 100 —
     * which is correct enough for a small library but breaks restore
     * paths that resolve manifest entries against the listed result. We
     * page through with the maximum (1000) until the server stops
     * returning a `nextPageToken`.
     */
    private async listAllPaginated(
        query: string,
        fieldsForFile: string,
        token: string
    ): Promise<DriveFile[]> {
        const out: DriveFile[] = [];
        let pageToken: string | undefined;
        do {
            const params = new URLSearchParams({
                q: query,
                fields: `nextPageToken, files(${fieldsForFile})`,
                spaces: 'appDataFolder',
                pageSize: '1000'
            });
            if (pageToken) params.set('pageToken', pageToken);
            const res = await fetch(
                `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
                { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
            );
            if (!res.ok) throw { status: res.status, message: res.statusText };
            const data = await res.json() as { files?: DriveFile[]; nextPageToken?: string };
            if (data.files) out.push(...data.files);
            pageToken = data.nextPageToken;
        } while (pageToken);
        return out;
    }

    async listFiles(folderId = 'appDataFolder'): Promise<DriveFile[]> {
        return this.execute(async (token) => {
            return this.listAllPaginated(
                `'${folderId}' in parents and trashed = false`,
                FILE_FIELDS,
                token
            );
        });
    }

    async listFolders(parentId = 'appDataFolder'): Promise<DriveFile[]> {
        return this.execute(async (token) => {
            return this.listAllPaginated(
                `'${parentId}' in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
                FOLDER_FIELDS,
                token
            );
        });
    }

    async createFolder(parentId = 'appDataFolder', name: string): Promise<DriveFile> {
        return this.execute(async (token) => {
            const metadata = {
                name,
                parents: [parentId],
                mimeType: DRIVE_FOLDER_MIME
            };
            const res = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json();
        });
    }

    async readFile(fileId: string): Promise<string> {
        return this.execute(async (token) => {
            const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store'
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.text();
        });
    }

    async createFile(
        parentId = 'appDataFolder',
        name: string,
        content: string,
        appProperties?: Record<string, string>
    ): Promise<DriveFile> {
        return this.execute(async (token) => {
            const metadata: Record<string, unknown> = {
                name,
                parents: [parentId],
                mimeType: 'text/markdown'
            };
            if (appProperties) metadata['appProperties'] = appProperties;

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([content], { type: 'text/plain' }));

            const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: form
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json() as DriveFile;
        });
    }

    /**
     * Updates the body of an existing file. To set or change the file's
     * `appProperties` (e.g. `last-active`), pass the full desired object —
     * Drive merges keys, so existing keys not mentioned are preserved, but
     * passing a key with `null` clears it.
     */
    async updateFile(
        fileId: string,
        content: string,
        appProperties?: Record<string, string>
    ): Promise<DriveFile> {
        return this.execute(async (token) => {
            // Body must be uploaded via uploadType=media OR multipart with metadata.
            // To attach metadata in the same call, use multipart.
            if (appProperties) {
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify({ appProperties })], { type: 'application/json' }));
                form.append('file', new Blob([content], { type: 'text/plain' }));
                const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=${FILE_FIELDS}`;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${token}` },
                    body: form
                });
                if (!res.ok) throw { status: res.status, message: res.statusText };
                return await res.json() as DriveFile;
            }
            const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=${FILE_FIELDS}`;
            const res = await fetch(url, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'text/plain'
                },
                body: content
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json() as DriveFile;
        });
    }

    async deleteFile(fileId: string): Promise<void> {
        return this.execute(async (token) => {
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
        });
    }

    /**
     * Server-side copy of a file into another folder. The `appProperties`
     * are copied implicitly by Drive — that's how snapshot objects keep
     * their original `last-active` / `deleted-at` markers without us
     * having to read+rewrite them.
     */
    async copyFile(fileId: string, newParentId: string, newName?: string): Promise<DriveFile> {
        return this.execute(async (token) => {
            const body: Record<string, unknown> = { parents: [newParentId] };
            if (newName !== undefined) body['name'] = newName;
            const url = `https://www.googleapis.com/drive/v3/files/${fileId}/copy?fields=${FILE_FIELDS}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw { status: res.status, message: res.statusText };
            return await res.json() as DriveFile;
        });
    }

    /**
     * Deletes a folder and everything under it. Drive's DELETE on a folder
     * trashes the folder and its descendants in one call when permission
     * allows — but appDataFolder semantics don't reliably clean children,
     * so we walk explicitly.
     *
     * Children are deleted first (post-order) so an interrupted call
     * leaves the folder existing-but-emptier rather than a dangling
     * reference. Single-threaded for simplicity; snapshot delete is rare
     * and the tree is shallow (folder → 4 subfolders → leaf files).
     */
    async deleteFolderRecursive(folderId: string): Promise<void> {
        const subfolders = await this.listFolders(folderId);
        for (const sub of subfolders) {
            await this.deleteFolderRecursive(sub.id);
        }
        const files = await this.listFiles(folderId);
        for (const f of files) {
            // listFiles returns files AND folders; skip folders since we
            // already recursed into them above (and listFolders would have
            // included them).
            if (f.mimeType === DRIVE_FOLDER_MIME) continue;
            await this.deleteFile(f.id);
        }
        await this.deleteFile(folderId);
    }
}
