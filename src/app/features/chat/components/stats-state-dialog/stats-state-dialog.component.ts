import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { CORE_MAT, DIALOG_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe } from '@app/core/i18n';
import { StatsCurrentState } from '@app/core/services/stats/stats-view.service';
import { isValidCssColor } from '@app/core/utils/color.util';

interface MapEntry {
  sub: string;
  value: number;
}

/** One row of the current-stats table: a scalar value OR a map's subkey list. */
interface StatRow {
  key: string;
  desc: string;
  color?: string;
  range: string;
  scalarValue: number | null;
  mapEntries: MapEntry[] | null;
}

@Component({
  selector: 'app-stats-state-dialog',
  standalone: true,
  imports: [...CORE_MAT, ...DIALOG_MAT, TranslatePipe],
  templateUrl: './stats-state-dialog.component.html',
  styleUrl: './stats-state-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatsStateDialogComponent {
  private readonly data = inject<StatsCurrentState>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<StatsStateDialogComponent>);

  /** Built once from the snapshot passed in — the dialog shows a point-in-time view. */
  readonly rows: StatRow[] = this.buildRows();

  private buildRows(): StatRow[] {
    const { parsed, values, bounds } = this.data;
    return Object.entries(parsed.stats).map(([key, def]) => {
      const overlay = bounds[key];
      const min = overlay && overlay.min !== undefined ? overlay.min : def.min;
      const max = overlay && overlay.max !== undefined ? overlay.max : def.max;
      const raw = values[key];
      const isMap = def.type === 'map';
      return {
        key,
        desc: def.desc ?? '',
        color: isValidCssColor(def.color) ? def.color : undefined,
        range: this.formatRange(min, max),
        scalarValue: isMap ? null : typeof raw === 'number' ? raw : 0,
        mapEntries: isMap ? this.mapEntries(raw) : null,
      };
    });
  }

  private mapEntries(raw: unknown): MapEntry[] {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.entries(raw as Record<string, number>).map(([sub, value]) => ({ sub, value }));
    }
    return [];
  }

  private formatRange(min?: number, max?: number): string {
    if (typeof min === 'number' && typeof max === 'number') return `${min}–${max}`;
    if (typeof min === 'number') return `≥${min}`;
    if (typeof max === 'number') return `≤${max}`;
    return '';
  }

  close(): void {
    this.dialogRef.close();
  }
}
