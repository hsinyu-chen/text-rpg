import { Injectable, signal } from '@angular/core';

@Injectable({
    providedIn: 'root'
})
export class LoadingState {
    isLoading = signal(false);
    message = signal<string>('Loading...');
}
