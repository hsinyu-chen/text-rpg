import { Pipe, PipeTransform } from '@angular/core';

/**
 * Strips the <possible save point> tag from content.
 * Used to hide the tag from rendered message content.
 */
@Pipe({
    name: 'stripSavePoint',
    standalone: true
})
export class StripSavePointPipe implements PipeTransform {
    transform(value: string | null | undefined): string {
        if (!value) return '';
        return value.replace(/<possible save point>/gi, '').trim();
    }
}
