import { Injectable, computed, inject, signal } from '@angular/core';
import { S3Config } from '../sync.types';
import { KVStore } from '../../kv/kv-store';

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
    private readonly kv = inject(KVStore);

    readonly config = signal<S3Config | null>(this.load());

    readonly isConfigured = computed(() => {
        const c = this.config();
        return !!(c && c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
    });

    save(config: S3Config | null): void {
        if (config) {
            this.kv.set(LS_S3.endpoint, config.endpoint);
            this.kv.set(LS_S3.region, config.region);
            this.kv.set(LS_S3.bucket, config.bucket);
            this.kv.set(LS_S3.accessKeyId, config.accessKeyId);
            this.kv.set(LS_S3.secretAccessKey, config.secretAccessKey);
            if (config.prefix) this.kv.set(LS_S3.prefix, config.prefix);
            else this.kv.remove(LS_S3.prefix);
            this.kv.set(LS_S3.forcePathStyle, String(config.forcePathStyle ?? true));
        } else {
            for (const k of Object.values(LS_S3)) this.kv.remove(k);
        }
        this.config.set(config);
    }

    private load(): S3Config | null {
        const endpoint = this.kv.get(LS_S3.endpoint);
        const bucket = this.kv.get(LS_S3.bucket);
        const accessKeyId = this.kv.get(LS_S3.accessKeyId);
        const secretAccessKey = this.kv.get(LS_S3.secretAccessKey);
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
        return {
            endpoint,
            region: this.kv.get(LS_S3.region) || 'us-east-1',
            bucket,
            accessKeyId,
            secretAccessKey,
            prefix: this.kv.get(LS_S3.prefix) || undefined,
            forcePathStyle: this.kv.get(LS_S3.forcePathStyle) !== 'false'
        };
    }
}
