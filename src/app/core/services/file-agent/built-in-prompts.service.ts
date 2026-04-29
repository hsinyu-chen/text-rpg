import { Injectable, inject, resource } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../language.service';

interface BuiltInPromptIndexEntry {
  id: string;
  icon: string;
  label: Record<string, string>;
  description?: Record<string, string>;
  autoRun?: boolean;
}

interface BuiltInPromptIndex {
  prompts: BuiltInPromptIndexEntry[];
}

export interface BuiltInPrompt {
  id: string;
  icon: string;
  label: string;
  description?: string;
  autoRun: boolean;
}

@Injectable({ providedIn: 'root' })
export class BuiltInPromptsService {
  private http = inject(HttpClient);
  private lang = inject(LanguageService);

  private static readonly BASE_PATH = 'assets/system_files/built_in_prompts';
  private static readonly FALLBACK_FOLDER = 'zh-tw';

  /**
   * Resolved prompt list for the current UI language. Re-runs when the
   * language changes; raw index.json is small enough that re-fetch on
   * language toggle is fine (HTTP cache absorbs the cost).
   */
  index = resource({
    params: () => ({ folder: this.lang.locale().folder }),
    loader: async ({ params }) => {
      const idx = await firstValueFrom(
        this.http.get<BuiltInPromptIndex>(`${BuiltInPromptsService.BASE_PATH}/index.json`)
      );
      return idx.prompts.map<BuiltInPrompt>(p => ({
        id: p.id,
        icon: p.icon,
        label: p.label[params.folder] ?? p.label[BuiltInPromptsService.FALLBACK_FOLDER] ?? p.id,
        description: p.description?.[params.folder] ?? p.description?.[BuiltInPromptsService.FALLBACK_FOLDER],
        autoRun: p.autoRun ?? false
      }));
    }
  });

  /** Lazy-fetch the prompt body — only triggered when the user picks an item. */
  async loadPromptBody(id: string): Promise<string> {
    const folder = this.lang.locale().folder;
    return firstValueFrom(
      this.http.get(`${BuiltInPromptsService.BASE_PATH}/${folder}/${id}.md`, { responseType: 'text' })
    );
  }
}
