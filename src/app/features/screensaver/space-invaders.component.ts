import { Component, ElementRef, inject, afterNextRender, DestroyRef, viewChild } from '@angular/core';
import Phaser from 'phaser';
import { InvadersScene } from './invaders-scene';
import { IdleService } from '../../core/services/idle.service';

@Component({
    selector: 'app-space-invaders',
    standalone: true,
    template: `
    <div class="screensaver-container">
      <div #gameContainer class="phaser-container"></div>
      <div class="exit-hotspot" (click)="exit()" (keydown.enter)="exit()" tabindex="0" aria-label="Exit Screensaver"></div>
      <div class="hint">Screensaver Active - Click Top Right to Exit</div>
    </div>
  `,
    styles: [`
    .screensaver-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: black;
      z-index: 9999;
      cursor: none;
    }
    .phaser-container {
      width: 100%;
      height: 100%;
    }
    .exit-hotspot {
      position: absolute;
      top: 0;
      right: 0;
      width: 100px;
      height: 100px;
      background: transparent;
      cursor: pointer;
      z-index: 10000;
    }
    .hint {
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        color: #333;
        font-family: monospace;
        font-size: 12px;
        opacity: 0.3;
        pointer-events: none;
    }
  `]
})
export class SpaceInvadersComponent {
    private gameContainer = viewChild.required<ElementRef>('gameContainer');
    private game!: Phaser.Game;
    private idleService = inject(IdleService);
    private destroyRef = inject(DestroyRef);

    constructor() {
        afterNextRender(() => {
            this.initGame();
        });

        this.destroyRef.onDestroy(() => {
            window.removeEventListener('resize', this.onResize);
            if (this.game) {
                this.game.destroy(true);
            }
        });
    }

    private initGame() {
        const config: Phaser.Types.Core.GameConfig = {
            type: Phaser.AUTO,
            parent: this.gameContainer().nativeElement,
            width: window.innerWidth,
            height: window.innerHeight,
            physics: {
                default: 'arcade',
                arcade: {
                    gravity: { x: 0, y: 0 },
                    debug: false
                }
            },
            scene: InvadersScene,
            backgroundColor: '#000000',
            render: {
                pixelArt: true,
                antialias: false,
                roundPixels: true
            }
        };

        this.game = new Phaser.Game(config);

        // Handle resize
        window.addEventListener('resize', this.onResize);
    }

    private onResize = () => {
        if (this.game) {
            this.game.scale.resize(window.innerWidth, window.innerHeight);
        }
    };

    exit() {
        this.idleService.closeScreensaver();
    }
}
