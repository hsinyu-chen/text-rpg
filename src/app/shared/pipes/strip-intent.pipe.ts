import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
    name: 'stripIntent',
    standalone: true
})
export class StripIntentPipe implements PipeTransform {
    transform(value: string | undefined): string {
        if (!value) return '';

        // Remove intent tags (e.g. <行動意圖>, <系統>, <存檔>, <繼續>) from the start of the string
        return value.replace(/^<[^>]+>/, '').trim();
    }
}
