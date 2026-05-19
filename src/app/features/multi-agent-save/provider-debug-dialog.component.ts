import { Component, computed, inject, resource } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { CORE_MAT, DIALOG_MAT, NAV_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe } from '@app/core/i18n';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { CHARACTER_PROVIDER, FACTION_PROVIDER, SCENE_EVENT_PROVIDER } from '@app/core/services/multi-agent-save/multi-agent-save.tokens';
import { SCENE_EVENT_LOG_FIELDS } from '@app/core/services/multi-agent-save/multi-agent-save.types';

/**
 * Inspector for the multi-agent save data providers (Phase 0: Character,
 * Faction, and Scene Events). Read-only — opens from Settings, shows what
 * each provider extracts from the currently loaded Book + chat state, so
 * a regression in extraction can be diagnosed without firing a real save
 * run.
 *
 * Provider outputs go through `resource()` because the interfaces are
 * Awaitable (Phase 4 swap to LLM-extracting variants is on the roadmap).
 * Re-runs automatically when any source signal changes — no manual refresh
 * needed when KB edits or saveContextMode toggles.
 */
@Component({
  selector: 'app-provider-debug-dialog',
  standalone: true,
  imports: [
    ...CORE_MAT,
    ...DIALOG_MAT,
    ...NAV_MAT,
    MatExpansionModule,
    TranslatePipe,
  ],
  templateUrl: './provider-debug-dialog.component.html',
  styleUrl: './provider-debug-dialog.component.scss',
})
export class ProviderDebugDialogComponent {
  private dialogRef = inject(MatDialogRef<ProviderDebugDialogComponent>);
  private state = inject(GameStateService);
  private appConfig = inject(AppConfigStore);
  private characterProvider = inject(CHARACTER_PROVIDER);
  private factionProvider = inject(FACTION_PROVIDER);
  private sceneEventProvider = inject(SCENE_EVENT_PROVIDER);

  readonly saveContextMode = this.state.saveContextMode;
  readonly smartContextTurns = this.appConfig.smartContextTurns;

  /** Exposed for the template's typed `@for` over each SceneEvent's log arrays. */
  readonly logFields = SCENE_EVENT_LOG_FIELDS;

  readonly charactersResource = resource({
    params: () => ({ files: this.state.loadedFiles() }),
    loader: async ({ params }) => this.characterProvider.listCharacters(params.files),
  });

  readonly factionsResource = resource({
    params: () => ({ files: this.state.loadedFiles() }),
    loader: async ({ params }) => this.factionProvider.listFactions(params.files),
  });

  readonly eventsResource = resource({
    params: () => ({
      messages: this.state.messages(),
      saveContextMode: this.saveContextMode(),
      smartContextTurns: this.smartContextTurns(),
    }),
    loader: async ({ params }) => this.sceneEventProvider.listEvents(params.messages, {
      saveContextMode: params.saveContextMode,
      smartContextTurns: params.smartContextTurns,
    }),
  });

  readonly characters = computed(() => this.charactersResource.value() ?? []);
  readonly factions = computed(() => this.factionsResource.value() ?? []);
  readonly events = computed(() => this.eventsResource.value() ?? []);

  /** Characters grouped by their L1 ancestor heading for display. */
  readonly characterGroups = computed(() => this.groupByL1(this.characters()));
  readonly factionGroups = computed(() => this.groupByL1(this.factions()));

  private groupByL1<T extends { group: string }>(entries: readonly T[]): { group: string; entries: T[] }[] {
    const byGroup = new Map<string, T[]>();
    for (const e of entries) {
      const existing = byGroup.get(e.group);
      if (existing) existing.push(e);
      else byGroup.set(e.group, [e]);
    }
    return Array.from(byGroup, ([group, items]) => ({ group, entries: items }));
  }

  close(): void {
    this.dialogRef.close();
  }
}
