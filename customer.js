// customer.js
class Customer {
    constructor(game) {
        this.game = game;
        this.x = 0;
        this.y = 7 * TILE_SIZE; // Start am Eingang
        this.state = 'FIND_SHELF'; 
        this.target = null;
        this.isFinished = false;
        this.speed = 2;
    }

    update() {
        if (this.state === 'FIND_SHELF') {
            this.target = this.findTile('shelf');
            this.state = 'WALKING_TO_SHELF';
        }

        if (this.state === 'WALKING_TO_SHELF') {
            this.moveToTarget(() => {
                this.state = 'FIND_REGISTER';
            });
        }

        if (this.state === 'FIND_REGISTER') {
            this.target = this.findTile('register');
            this.state = 'WALKING_TO_REGISTER';
        }

        if (this.state === 'WALKING_TO_REGISTER') {
            this.moveToTarget(() => {
                this.game.money += 15; // Bezahlung
                this.state = 'LEAVING';
                this.target = {x: 0, y: 7};
            });
        }

        if (this.state === 'LEAVING') {
            this.moveToTarget(() => {
                this.isFinished = true;
            });
        }
    }

    findTile(type) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
            for (let x = 0; x < GRID_WIDTH; x++) {
                if (this.game.grid[y][x]?.type === type) {
                    return { x, y };
                }
            }
        }
        return { x: 5, y: 5 }; // Fallback
    }

    moveToTarget(callback) {
        if (!this.target) return;
        
        const tx = this.target.x * TILE_SIZE;
        const ty = this.target.y * TILE_SIZE;

        if (Math.abs(this.x - tx) > 2) {
            this.x += (this.x < tx) ? this.speed : -this.speed;
        } else if (Math.abs(this.y - ty) > 2) {
            this.y += (this.y < ty) ? this.speed : -this.speed;
        } else {
            callback();
        }
    }

    draw(ctx) {
        ctx.fillStyle = "#f1c40f";
        ctx.beginPath();
        ctx.arc(this.x + TILE_SIZE/2, this.y + TILE_SIZE/2, 10, 0, Math.PI*2);
        ctx.fill();
    }
}
