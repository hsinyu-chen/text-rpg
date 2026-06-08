import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { StatChip } from '@app/core/services/stats/stats-chip.util';

/**
 * Presentational chip row for a turn's numeric-stat changes. Owns the chip DOM
 * and styling so the inline chat turn view and the turn-update side panel render
 * an identical row from one place; each host keeps its own surrounding chrome
 * (toggle button / section title) and decides when to show the row.
 */
@Component({
  selector: 'app-stat-chip-list',
  standalone: true,
  imports: [MatTooltipModule],
  templateUrl: './stat-chip-list.component.html',
  styleUrl: './stat-chip-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatChipListComponent {
  chips = input.required<StatChip[]>();
}
