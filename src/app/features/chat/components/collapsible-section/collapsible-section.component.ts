import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe } from '@app/core/i18n';

export type CollapsibleSectionVariant = 'thought' | 'analysis' | 'update';

/**
 * The collapsible chrome shared by the Thought / Analysis / Turn Update sections
 * of a model message: tinted container, clickable header with toggle arrow +
 * icon + title, an optional streaming status line, and a projected body that
 * shows only while {@link expanded}. `variant` drives the per-section colour and
 * streaming-border animation.
 */
@Component({
    selector: 'app-collapsible-section',
    standalone: true,
    imports: [...CORE_MAT, TranslatePipe],
    templateUrl: './collapsible-section.component.html',
    styleUrl: './collapsible-section.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        'style': 'display: block;'
    }
})
export class CollapsibleSectionComponent {
    variant = input.required<CollapsibleSectionVariant>();
    icon = input.required<string>();
    /** i18n key for the section title. */
    title = input.required<string>();
    expanded = input.required<boolean>();
    streaming = input<boolean>(false);
    /** Header status line; hidden when null/empty. */
    statusText = input<string | null>(null);
    toggled = output<void>();
}
