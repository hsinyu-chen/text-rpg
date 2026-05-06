import { Injectable, computed, signal } from '@angular/core';
import { S3Config } from './sync.types';

const LS_S3 = {
    endpoint: 'sync_s3_endpoint',
    region: 'sync_s3_region',
    bucket: 'sync_s3_bucket',
    accessKeyId: 'sync_s3_access_key',
    secretAccessKey: 'sync_s3_secret_key',
    prefix: 'sync_s3_prefix',
    forcePathStyle: 'sync_s3_path_style'
} as const;

/**
 * Owns the persisted S3 connection config. The value is the source of
 * truth that `S3SyncBackend.initAsync` reads when it (re)builds the
 * client; the backend re-builds whenever the config fingerprint changes,
 * so writing here is the public way to trigger a backend re-init.
 *
 * Lives separate from `S3SyncBackend` so the UI can read / write config
 * without touching the backend (or the AWS SDK chunk).
 */
@Injectable({ providedIn: 'root' })
export class S3ConfigService {
    readonly config = signal<S3Config | null>(this.load());

    readonly isConfigured = computed(() => {
        const c = this.config();
        return !!(c && c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
    });

    save(config: S3Config | null): void {
        if (config) {
            localStorage.setItem(LS_S3.endpoint, config.endpoint);
            localStorage.setItem(LS_S3.region, config.region);
            localStorage.setItem(LS_S3.bucket, config.bucket);
            localStorage.setItem(LS_S3.accessKeyId, config.accessKeyId);
            localStorage.setItem(LS_S3.secretAccessKey, config.secretAccessKey);
            if (config.prefix) localStorage.setItem(LS_S3.prefix, config.prefix);
            else localStorage.removeItem(LS_S3.prefix);
            localStorage.setItem(LS_S3.forcePathStyle, String(config.forcePathStyle ?? true));
        } else {
            for (const k of Object.values(LS_S3)) localStorage.removeItem(k);
        }
        this.config.set(config);
    }

    private load(): S3Config | null {
        const endpoint = localStorage.getItem(LS_S3.endpoint);
        const bucket = localStorage.getItem(LS_S3.bucket);
        const accessKeyId = localStorage.getItem(LS_S3.accessKeyId);
        const secretAccessKey = localStorage.getItem(LS_S3.secretAccessKey);
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
        return {
            endpoint,
            region: localStorage.getItem(LS_S3.region) || 'us-east-1',
            bucket,
            accessKeyId,
            secretAccessKey,
            prefix: localStorage.getItem(LS_S3.prefix) || undefined,
            forcePathStyle: localStorage.getItem(LS_S3.forcePathStyle) !== 'false'
        };
    }
}
