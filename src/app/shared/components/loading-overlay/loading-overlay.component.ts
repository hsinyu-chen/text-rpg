import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { LoadingState } from '../../../core/services/loading.state';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  imports: [CommonModule, MatProgressSpinnerModule],
  template: `
    <div class="page-loading-overlay">
      <mat-spinner diameter="50"></mat-spinner>
      <div class="loading-text">
          <h3>{{ state.message() }}</h3>
      </div>
    </div>
  `,
  styles: [`
    .page-loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background-color: rgba(0, 0, 0, 0.85);
        z-index: 100000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 24px;
        backdrop-filter: blur(4px);
    }

    .loading-text {
        text-align: center;
        color: #e0e0e0;
    }

    .loading-text h3 {
        margin: 0;
        font-size: 1.2rem;
        font-weight: 500;
        color: #fff;
        margin-bottom: 8px;
    }
  `]
})
export class LoadingOverlayComponent {
  state = inject(LoadingState);
}
