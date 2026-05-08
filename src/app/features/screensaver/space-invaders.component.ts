import { Component, ElementRef, inject, afterNextRender, DestroyRef, viewChild } from '@angular/core';
import Phaser from 'phaser';
import { InvadersScene } from './invaders-scene';
import { IdleService } from '@app/core/services/idle.service';
import { WINDOW } from '@app/core/tokens/window.token';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

@Component({
    selector: 'app-space-invaders',
    standalone: true,
    imports: [MatButtonModule, MatIconModule],
    templateUrl: './space-invaders.component.html',
    styleUrl: './space-invaders.component.scss'
})
export class SpaceInvadersComponent {
    private gameContainer = viewChild.required<ElementRef>('gameContainer');
    private game!: Phaser.Game;
    private idleService = inject(IdleService);
    private destroyRef = inject(DestroyRef);
    private readonly win = inject(WINDOW);

    constructor() {
        afterNextRender(() => {
            this.initGame();
        });

        this.destroyRef.onDestroy(() => {
            this.win.removeEventListener('resize', this.onResize);
            if (this.game) {
                this.game.destroy(true);
            }
        });
    }

    private initGame() {
        const config: Phaser.Types.Core.GameConfig = {
            type: Phaser.AUTO,
            parent: this.gameContainer().nativeElement,
            width: this.win.innerWidth,
            height: this.win.innerHeight,
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
        this.win.addEventListener('resize', this.onResize);
    }

    private onResize = () => {
        if (this.game) {
            this.game.scale.resize(this.win.innerWidth, this.win.innerHeight);
        }
    };

    exit() {
        this.idleService.closeScreensaver();
    }
}
