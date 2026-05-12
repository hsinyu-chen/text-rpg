import { Component, inject } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { LoadingState } from '@app/core/services/loading.state';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  imports: [MatProgressSpinnerModule],
  templateUrl: './loading-overlay.component.html',
  styleUrl: './loading-overlay.component.scss'
})
export class LoadingOverlayComponent {
  state = inject(LoadingState);
}
