import { Injectable, computed, inject, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { WINDOW } from '@app/core/tokens/window.token';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { GameStateService } from '@app/core/services/game-state.service';
import { InjectionService } from '@app/core/services/injection.service';
import { LoadingService } from '@app/core/services/loading.service';
import { DialogService } from '@app/core/services/dialog.service';
import { PromptProfileRegistryService } from '@app/core/services/prompt-profile-registry.service';
import { isSystemMainCompatible } from '@app/core/services/profile-compat';
import { DiskProfileSyncService } from '@app/core/services/sync/disk-profile-sync.service';
import { PromptCloudSyncService } from '@app/core/services/sync/prompt-cloud-sync.service';
import { SyncService } from '@app/core/services/sync/sync.service';
import {
  DEFAULT_PROFILE_ID,
  PromptProfile,
  getProfileDisplayName,
} from '@app/core/constants/prompt-profiles';
import { getUIStrings } from '@app/core/constants/engine-protocol';

/** Hooks the dialog provides so the controller can react to its own profile mutations. */
export interface ProfileManagementHost {
  /** Returns true if the editor has any unsaved changes (controller prompts to discard). */
  hasAnyDirty(): boolean;
  /** Reset the editor's per-type dirty bookkeeping after a profile-wide refresh. */
  clearDirty(): void;
  /** Re-read prompt content for every type into the editor models. */
  refreshEditorContent(): void;
}

/**
 * Profile lifecycle + sync orchestration extracted from ChatConfigDialog.
 *
 * Owns: the active-profile signals, switch / clone / rename / delete CRUD,
 * cloud push-pull, disk push-pull-pickFolder, and JSON export-import. The
 * dialog only owns the prompt editor + its dirty/validation bookkeeping.
 *
 * Provided in the dialog's `providers` array (per-instance).
 */
@Injectable()
export class ProfileManagementController {
  private injection = inject(InjectionService);
  private registry = inject(PromptProfileRegistryService);
  private sync = inject(SyncService);
  private promptCloudSync = inject(PromptCloudSyncService);
  private diskSync = inject(DiskProfileSyncService);
  private dialogService = inject(DialogService);
  private snackBar = inject(MatSnackBar);
  private loading = inject(LoadingService);
  private state = inject(GameStateService);
  private appConfig = inject(AppConfigStore);
  private readonly win = inject(WINDOW);

  isSwitchingProfile = signal(false);

  /**
   * Set of profile ids whose `system_main` lacks the v2 version marker.
   * Recomputed on dialog init and after any profile-list mutation; the
   * template renders a ⚠ badge inside `<mat-option>` for these.
   */
  legacyProfileIds = signal<Set<string>>(new Set());

  ui = computed(() => getUIStrings(this.appConfig.outputLanguage()));
  builtInProfiles = computed(() => this.registry.builtInProfiles());
  userProfiles = computed(() => this.registry.userProfiles());
  activeProfileId = computed(() => this.state.activePromptProfile());
  activeProfile = computed(() => this.registry.get(this.activeProfileId()));
  isActiveBuiltIn = computed(() => this.activeProfile()?.isBuiltIn ?? false);

  private host?: ProfileManagementHost;

  bind(host: ProfileManagementHost): void {
    this.host = host;
  }

  getProfileLabel(profile: PromptProfile): string {
    return getProfileDisplayName(profile, this.ui() as unknown as Record<string, string>);
  }

  isLegacyProfile(profileId: string): boolean {
    return this.legacyProfileIds().has(profileId);
  }

  async refreshLegacyProfileIds(): Promise<void> {
    const all = [...this.builtInProfiles(), ...this.userProfiles()];
    const results = await Promise.all(all.map(async (profile) => {
      try {
        const content = await this.injection.getResolvedProfilePrompt('system_main', profile.id);
        return { id: profile.id, compatible: isSystemMainCompatible(content) };
      } catch (err) {
        console.warn(`[ChatConfigDialog] compat check failed for ${profile.id}`, err);
        // Treat fetch failures as compatible — surfacing a false ⚠ on
        // every profile because storage hiccupped is worse than
        // missing one legacy badge until the next refresh.
        return { id: profile.id, compatible: true };
      }
    }));
    this.legacyProfileIds.set(new Set(results.filter((r) => !r.compatible).map((r) => r.id)));
  }

  diskFolderName(): string | null {
    return this.diskSync.boundFolderName();
  }

  async switchProfile(newProfileId: string): Promise<void> {
    if (newProfileId === this.activeProfileId()) return;

    if (await this.shouldAbortOnDirty(this.ui().PROFILE_SWITCH_DISCARD_CONFIRM)) return;

    this.isSwitchingProfile.set(true);
    try {
      await this.injection.switchProfile(newProfileId);
      this.refreshAfterProfileChange();
    } finally {
      this.isSwitchingProfile.set(false);
    }
  }

  async cloneActive(): Promise<void> {
    const active = this.activeProfile();
    if (!active) return;

    const defaultName = `${this.getProfileLabel(active)} (copy)`;
    const name = await this.dialogService.prompt(this.ui().PROFILE_CLONE_PROMPT, {
      defaultValue: defaultName,
      title: this.ui().PROFILE_CLONE,
    });
    if (!name) return;

    if (await this.shouldAbortOnDirty(this.ui().PROFILE_SWITCH_DISCARD_CONFIRM)) return;

    this.isSwitchingProfile.set(true);
    try {
      const newId = await this.injection.cloneProfile(active.id, name);
      await this.injection.switchProfile(newId);
      this.refreshAfterProfileChange();
      await this.refreshLegacyProfileIds();
      this.snackBar.open(this.ui().PROFILE_CLONED, this.ui().CLOSE, { duration: 2000 });
    } catch (err) {
      console.error('[ChatConfig] cloneActive failed', err);
      this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
    } finally {
      this.isSwitchingProfile.set(false);
    }
  }

  async renameActive(): Promise<void> {
    const active = this.activeProfile();
    if (!active || active.isBuiltIn) return;

    const current = active.displayName || '';
    const name = await this.dialogService.prompt(this.ui().PROFILE_RENAME_PROMPT, {
      defaultValue: current,
      title: this.ui().PROFILE_RENAME,
    });
    if (!name || name === current) return;

    try {
      await this.injection.renameProfile(active.id, name);
      this.snackBar.open(this.ui().PROFILE_RENAMED, this.ui().CLOSE, { duration: 2000 });
    } catch (err) {
      console.error('[ChatConfig] renameActive failed', err);
      this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
    }
  }

  /** Switches to a fallback profile first so the app never points at a deleted id. */
  async deleteActive(): Promise<void> {
    const active = this.activeProfile();
    if (!active || active.isBuiltIn) return;

    const confirmMsg = this.ui().PROFILE_DELETE_CONFIRM.replace('{name}', this.getProfileLabel(active));
    const ok = await this.dialogService.confirm(confirmMsg, this.ui().PROFILE_DELETE);
    if (!ok) return;

    if (await this.shouldAbortOnDirty(this.ui().PROFILE_SWITCH_DISCARD_CONFIRM)) return;

    this.isSwitchingProfile.set(true);
    try {
      const fallbackId = active.baseProfileId && this.registry.get(active.baseProfileId)
        ? active.baseProfileId
        : DEFAULT_PROFILE_ID;
      await this.injection.switchProfile(fallbackId);
      await this.injection.deleteProfile(active.id);
      this.refreshAfterProfileChange();
      await this.refreshLegacyProfileIds();
      this.snackBar.open(this.ui().PROFILE_DELETED, this.ui().CLOSE, { duration: 2000 });
    } catch (err) {
      console.error('[ChatConfig] deleteActive failed', err);
      this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
    } finally {
      this.isSwitchingProfile.set(false);
    }
  }

  async pushPromptsToCloud(): Promise<void> {
    this.loading.show(this.ui().PROMPT_SYNC_UPLOADING);
    try {
      const { exported } = await this.sync.uploadPrompts();
      this.snackBar.open(this.ui().PROMPT_SYNC_UPLOADED.replace('{count}', String(exported)), this.ui().CLOSE, { duration: 3000 });
    } catch (err) {
      console.error('[ChatConfig] uploadPrompts failed', err);
      this.snackBar.open(this.ui().PROMPT_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
    } finally {
      this.loading.hide();
    }
  }

  async pullPromptsFromCloud(): Promise<void> {
    const confirmed = await this.dialogService.confirm(
      this.ui().PROMPT_SYNC_DOWNLOAD_CONFIRM,
      this.ui().PROMPT_SYNC_DOWNLOAD_TITLE,
    );
    if (!confirmed) return;

    this.loading.show(this.ui().PROMPT_SYNC_DOWNLOADING);
    try {
      const { imported } = await this.sync.downloadPrompts();
      // forceReload — switchProfile(sameId) would early-return and skip the re-read.
      await this.injection.forceReload();
      this.refreshAfterProfileChange();
      await this.refreshLegacyProfileIds();
      const msg = imported === 0
        ? this.ui().PROMPT_SYNC_NONE_FOUND
        : this.ui().PROMPT_SYNC_DOWNLOADED.replace('{count}', String(imported));
      this.snackBar.open(msg, this.ui().CLOSE, { duration: 3000 });
    } catch (err) {
      console.error('[ChatConfig] downloadPrompts failed', err);
      this.snackBar.open(this.ui().PROMPT_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
    } finally {
      this.loading.hide();
    }
  }

  async exportActiveProfile(): Promise<void> {
    const active = this.activeProfile();
    if (!active) return;
    try {
      const json = await this.promptCloudSync.exportSingleProfile(active.id);
      const safeName = (this.getProfileLabel(active) || active.id).replace(/[^\w-]+/g, '_');
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = this.win.document.createElement('a');
      a.href = url;
      a.download = `prompt-profile-${safeName}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[ChatConfig] exportActiveProfile failed', err);
      this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
    }
  }

  importProfileFromFile(): void {
    const input = this.win.document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const before = new Set(this.registry.userProfiles().map((p) => p.id));
        const { imported } = await this.promptCloudSync.importSingleProfile(text);
        if (imported === 0) {
          this.snackBar.open(this.ui().PROFILE_IMPORT_EMPTY, this.ui().CLOSE, { duration: 3000 });
          return;
        }
        // A fresh id means a new user profile appeared (incl. rename-on-conflict);
        // no fresh id means the import overwrote an existing one in place.
        const after = this.registry.userProfiles();
        const fresh = after.find((p) => !before.has(p.id));
        if (fresh) {
          await this.injection.switchProfile(fresh.id);
        } else {
          await this.injection.forceReload();
        }
        this.refreshAfterProfileChange();
        await this.refreshLegacyProfileIds();
        this.snackBar.open(this.ui().PROFILE_IMPORTED, this.ui().CLOSE, { duration: 3000 });
      } catch (err) {
        console.error('[ChatConfig] importProfileFromFile failed', err);
        this.snackBar.open(this.ui().PROFILE_IMPORT_INVALID, this.ui().CLOSE, { duration: 4000 });
      }
    };
    input.click();
  }

  async pushActiveProfileToDisk(): Promise<void> {
    const active = this.activeProfile();
    if (!active || active.isBuiltIn) return;

    if (!(await this.ensureDiskFolderBound())) return;

    this.loading.show(this.ui().DISK_SYNC_PUSHING);
    try {
      await this.diskSync.pushActiveToDisk();
      this.snackBar.open(this.ui().DISK_SYNC_PUSHED, this.ui().CLOSE, { duration: 3000 });
    } catch (err) {
      console.error('[ChatConfig] pushActiveProfileToDisk failed', err);
      this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
    } finally {
      this.loading.hide();
    }
  }

  async pullActiveProfileFromDisk(): Promise<void> {
    const active = this.activeProfile();
    if (!active || active.isBuiltIn) return;

    if (!(await this.ensureDiskFolderBound())) return;

    if (await this.shouldAbortOnDirty(this.ui().DISK_SYNC_PULL_DISCARD_CONFIRM)) return;

    this.loading.show(this.ui().DISK_SYNC_PULLING);
    try {
      const { updatedTypes } = await this.diskSync.pullActiveFromDisk();
      this.refreshAfterProfileChange();
      await this.refreshLegacyProfileIds();
      const msg = updatedTypes === 0
        ? this.ui().DISK_SYNC_PULL_EMPTY
        : this.ui().DISK_SYNC_PULLED.replace('{count}', String(updatedTypes));
      this.snackBar.open(msg, this.ui().CLOSE, { duration: 3000 });
    } catch (err) {
      console.error('[ChatConfig] pullActiveProfileFromDisk failed', err);
      this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
    } finally {
      this.loading.hide();
    }
  }

  async changeDiskFolder(): Promise<void> {
    try {
      await this.diskSync.pickFolder();
      const name = this.diskFolderName();
      if (name) {
        this.snackBar.open(
          this.ui().DISK_SYNC_FOLDER_BOUND.replace('{name}', name),
          this.ui().CLOSE,
          { duration: 3000 },
        );
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      console.error('[ChatConfig] changeDiskFolder failed', err);
      this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 3000 });
    }
  }

  /**
   * Ensure a disk folder is bound, prompting the FSA picker if not.
   * Returns true if a folder is bound after the call, false on cancel/error.
   */
  private async ensureDiskFolderBound(): Promise<boolean> {
    if (this.diskFolderName()) return true;
    try {
      await this.diskSync.pickFolder();
      return this.diskFolderName() !== null;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return false;
      console.error('[ChatConfig] disk pickFolder failed', err);
      this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 3000 });
      return false;
    }
  }

  /** True if the user has unsaved changes and chose NOT to discard them. */
  private async shouldAbortOnDirty(confirmMsg: string): Promise<boolean> {
    if (!this.host?.hasAnyDirty()) return false;
    const ok = await this.dialogService.confirm(confirmMsg);
    return !ok;
  }

  private refreshAfterProfileChange(): void {
    this.host?.refreshEditorContent();
    this.host?.clearDirty();
  }
}
