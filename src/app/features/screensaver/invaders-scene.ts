import Phaser from 'phaser';

export class InvadersScene extends Phaser.Scene {
    private player!: Phaser.Physics.Arcade.Sprite;
    private aliens!: Phaser.Physics.Arcade.Group;
    private bullets!: Phaser.Physics.Arcade.Group;
    private alienBullets!: Phaser.Physics.Arcade.Group;
    private asteroids!: Phaser.Physics.Arcade.Group;
    private stars: { sprite: Phaser.GameObjects.Rectangle, speed: number }[] = [];

    private lastFired = 0;
    private lastAsteroidSpawn = 0;
    private alienDirection = 1;
    private alienSpeed = 2;
    private alienStepDown = 20;

    private aiLockUntil = 0;
    private aiLockedTargetX: number | null = null;

    // Pixel Art Patterns
    private readonly PATTERNS = {
        player: [
            '00000100000',
            '00001110000',
            '00011111000',
            '01111111110',
            '11111111111',
            '11011111011',
            '11111111111'
        ],
        alien1: [
            ['00100010', '00010100', '00111110', '01101101', '11111111', '10111110', '10100010', '00011000'],
            ['00100010', '10010100', '11111111', '11101111', '11111111', '00111100', '01000010', '10000001']
        ],
        alien2: [
            ['00011000', '01111110', '11111111', '11011011', '11111111', '00100100', '01011010', '10100101'],
            ['00011000', '01111110', '11111111', '11011011', '11111111', '01101100', '10010010', '01001001']
        ],
        asteroid: [
            '00111100',
            '01111110',
            '11111111',
            '11111111',
            '11111111',
            '11111111',
            '01111110',
            '00111100'
        ]
    };

    constructor() {
        super('InvadersScene');
    }

    create() {
        const { width, height } = this.scale;

        this.generateTextures();

        // Background
        this.add.rectangle(0, 0, width, height, 0x000000).setOrigin(0);

        // Stars (Parallax)
        for (let i = 0; i < 100; i++) {
            const star = this.add.rectangle(
                Phaser.Math.Between(0, width),
                Phaser.Math.Between(0, height),
                2, 2, 0xffffff
            );
            star.setAlpha(Phaser.Math.FloatBetween(0.3, 0.8));
            this.stars.push({
                sprite: star,
                speed: Phaser.Math.FloatBetween(1, 4)
            });
        }

        // Player
        this.player = this.physics.add.sprite(width / 2, height - 80, 'player');
        this.player.setScale(6);

        // Aliens
        this.aliens = this.physics.add.group();
        const rows = 5;
        const cols = 10;
        const spacingX = 80;
        const spacingY = 60;
        const offsetX = (width - cols * spacingX) / 2;
        const offsetY = 100;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const type = r < 2 ? 'alien1' : 'alien2';
                const alien = this.aliens.create(
                    offsetX + c * spacingX,
                    offsetY + r * spacingY,
                    type
                ) as Phaser.Physics.Arcade.Sprite;
                alien.setScale(5);
                alien.setData('frame', 0);
                alien.setData('lastSwitch', 0);
            }
        }

        // Bullets & Asteroids
        this.bullets = this.physics.add.group();
        this.alienBullets = this.physics.add.group();
        this.asteroids = this.physics.add.group();

        // Collisions
        this.physics.add.overlap(this.bullets, this.aliens, (bullet, alien) => {
            bullet.destroy();
            alien.destroy();
            if (this.aliens.getLength() === 0) {
                this.resetGame();
            }
        });

        this.physics.add.overlap(this.alienBullets, this.player, () => {
            this.resetGame();
        });

        this.physics.add.overlap(this.asteroids, this.player, () => {
            this.resetGame();
        });

        // Bullet hits asteroid
        this.physics.add.overlap(this.bullets, this.asteroids, (bullet, asteroid) => {
            bullet.destroy();
            asteroid.destroy();
        });
    }

    private generateTextures() {
        const createTex = (key: string, data: string[], color: number) => {
            const h = data.length;
            const w = data[0].length;
            const graphics = this.make.graphics();
            graphics.fillStyle(color, 1);

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (data[y][x] === '1') {
                        graphics.fillRect(x, y, 1, 1);
                    } else if (data[y][x] === '2') {
                        graphics.fillStyle(0xffffff, 1);
                        graphics.fillRect(x, y, 1, 1);
                        graphics.fillStyle(color, 1);
                    }
                }
            }
            graphics.generateTexture(key, w, h);
            graphics.destroy();
        };

        createTex('player', this.PATTERNS.player, 0x00ff00);
        createTex('alien1', this.PATTERNS.alien1[0], 0xff5555);
        createTex('alien1_alt', this.PATTERNS.alien1[1], 0xff5555);
        createTex('alien2', this.PATTERNS.alien2[0], 0x5555ff);
        createTex('alien2_alt', this.PATTERNS.alien2[1], 0x5555ff);
        createTex('asteroid', this.PATTERNS.asteroid, 0x888888);
        createTex('bullet', ['1'], 0xffff00);
        createTex('alien_bullet', ['1'], 0xffffff);
    }

    override update(time: number) {
        const { width, height } = this.scale;

        // Scroll Stars
        this.stars.forEach(s => {
            s.sprite.y += s.speed;
            if (s.sprite.y > height) {
                s.sprite.y = 0;
                s.sprite.x = Phaser.Math.Between(0, width);
            }
        });

        // Spawn Asteroids
        if (time > this.lastAsteroidSpawn + 2000) {
            this.spawnAsteroid();
            this.lastAsteroidSpawn = time;
        }

        // Move Aliens
        let hitEdge = false;
        this.aliens.getChildren().forEach((a) => {
            const alien = a as Phaser.Physics.Arcade.Sprite;
            alien.x += this.alienDirection * this.alienSpeed;
            if (alien.x > width - 40 || alien.x < 40) {
                hitEdge = true;
            }
            if (alien.y > height - 100) {
                this.resetGame();
            }

            // Animate Alien
            if (time > alien.getData('lastSwitch') + 500) {
                const frame = alien.getData('frame') === 0 ? 1 : 0;
                const baseKey = alien.texture.key.replace('_alt', '');
                alien.setTexture(frame === 0 ? baseKey : baseKey + '_alt');
                alien.setData('frame', frame);
                alien.setData('lastSwitch', time);
            }
        });

        if (hitEdge) {
            this.alienDirection *= -1;
            this.aliens.getChildren().forEach((a) => {
                (a as Phaser.Physics.Arcade.Sprite).y += this.alienStepDown;
            });
        }

        // Auto-Pilot AI
        this.runAI(time);
    }

    private runAI(time: number) {
        if (this.aliens.getLength() === 0) {
            this.player.setVelocityX(0);
            return;
        }

        const { width, height } = this.scale;
        let targetX = this.player.x;
        let isDodging = false;

        // 1. Check if AI is locked in a decision (to prevent shivering)
        if (time < this.aiLockUntil && this.aiLockedTargetX !== null) {
            targetX = this.aiLockedTargetX;
            isDodging = true;
        } else {
            // 2. Evaluate new target
            const safetyMargin = 20;
            const dangerousAsteroids = this.asteroids.getChildren().filter(a => {
                const asteroid = a as Phaser.Physics.Arcade.Sprite;
                return Math.abs(asteroid.x - this.player.x) < safetyMargin && asteroid.y > height / 4;
            }) as Phaser.Physics.Arcade.Sprite[];

            if (dangerousAsteroids.length > 0) {
                isDodging = true;
                const mostThreatening = dangerousAsteroids.sort((a, b) => b.y - a.y)[0];

                if (mostThreatening.x < width / 2) {
                    targetX = mostThreatening.x + safetyMargin + 30;
                } else {
                    targetX = mostThreatening.x - safetyMargin - 30;
                }

                this.aiLockUntil = time + 500;
                this.aiLockedTargetX = targetX;
            } else {
                // 3. Track nearest alien
                this.aiLockedTargetX = null;
                const nearestAlien = this.aliens.getChildren().sort((a: Phaser.GameObjects.GameObject, b: Phaser.GameObjects.GameObject) =>
                    Phaser.Math.Distance.Between(this.player.x, this.player.y, (a as Phaser.Physics.Arcade.Sprite).x, (a as Phaser.Physics.Arcade.Sprite).y) -
                    Phaser.Math.Distance.Between(this.player.x, this.player.y, (b as Phaser.Physics.Arcade.Sprite).x, (b as Phaser.Physics.Arcade.Sprite).y)
                )[0] as Phaser.Physics.Arcade.Sprite;

                if (nearestAlien) {
                    targetX = nearestAlien.x;
                }
            }
        }

        targetX = Phaser.Math.Clamp(targetX, 60, width - 60);

        // 4. Physics-based movement (No Shivering)
        const dx = targetX - this.player.x;
        if (Math.abs(dx) > 10) {
            this.player.setVelocityX(Math.sign(dx) * 450);
        } else if (Math.abs(dx) > 2) {
            this.player.setVelocityX(Math.sign(dx) * 150);
        } else {
            this.player.setVelocityX(0);
            this.player.x = Math.round(this.player.x);
        }

        // 5. Shooting
        const shootDelay = isDodging ? 800 : 400;
        if (time > this.lastFired) {
            this.fireBullet();
            this.lastFired = time + shootDelay;

            if (Math.random() > 0.8) {
                const randomAlien = Phaser.Utils.Array.GetRandom(this.aliens.getChildren()) as Phaser.Physics.Arcade.Sprite;
                if (randomAlien) this.fireAlienBullet(randomAlien.x, randomAlien.y);
            }
        }
    }

    private spawnAsteroid() {
        const { width } = this.scale;
        const x = Phaser.Math.Between(50, width - 50);
        const asteroid = this.asteroids.create(x, -50, 'asteroid') as Phaser.Physics.Arcade.Sprite;
        asteroid.setScale(Phaser.Math.Between(4, 8));
        asteroid.setVelocityY(Phaser.Math.Between(150, 300));
        asteroid.setAngularVelocity(Phaser.Math.Between(-100, 100));

        // Clean up out of bounds
        asteroid.setCollideWorldBounds(false);
    }

    private fireBullet() {
        const bullet = this.bullets.create(this.player.x, this.player.y - 30, 'bullet') as Phaser.Physics.Arcade.Sprite;
        bullet.setScale(4, 12);
        bullet.setVelocityY(-600);
    }

    private fireAlienBullet(x: number, y: number) {
        const bullet = this.alienBullets.create(x, y + 20, 'alien_bullet') as Phaser.Physics.Arcade.Sprite;
        bullet.setScale(4, 12);
        bullet.setVelocityY(400);
    }

    private resetGame() {
        this.scene.restart();
    }
}
