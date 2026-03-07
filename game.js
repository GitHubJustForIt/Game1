// game.js
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const TILE_SIZE = 40;
const GRID_WIDTH = 20;
const GRID_HEIGHT = 15;

class Game {
    constructor() {
        this.money = 1000;
        this.grid = Array(GRID_HEIGHT).fill().map(() => Array(GRID_WIDTH).fill(null));
        this.buildMode = null;
        this.customers = [];
        this.monthTimer = 0;
        this.totalSeconds = 0;

        this.init();
    }

    init() {
        canvas.width = GRID_WIDTH * TILE_SIZE;
        canvas.height = GRID_HEIGHT * TILE_SIZE;

        // Start-Eingang
        this.grid[7][0] = { type: 'entrance' };

        // Mouse Events
        canvas.addEventListener('mousedown', (e) => this.handleClicks(e));
        
        // Loop starten
        setInterval(() => this.updateTick(), 1000);
        this.render();
        this.loadGame();
    }

    setBuildMode(mode) {
        this.buildMode = mode;
        document.getElementById('status-msg').innerText = "Modus: " + mode;
    }

    handleClicks(e) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) / TILE_SIZE);
        const y = Math.floor((e.clientY - rect.top) / TILE_SIZE);

        if (this.buildMode === 'delete') {
            this.grid[y][x] = null;
        } else if (this.buildMode) {
            const costs = { shelf: 50, register: 150 };
            if (this.money >= costs[this.buildMode]) {
                this.money -= costs[this.buildMode];
                this.grid[y][x] = { type: this.buildMode, inventory: 10 };
                this.updateUI();
            }
        }
    }

    updateTick() {
        this.totalSeconds++;
        this.monthTimer++;

        // Monatssytem (2 Minuten = 120 Sek)
        if (this.monthTimer >= 120) {
            this.processEndOfMonth();
            this.monthTimer = 0;
        }

        // Kunden spawnen (Chance pro Sekunde)
        if (Math.random() > 0.7) {
            this.customers.push(new Customer(this));
        }

        this.customers.forEach((c, index) => {
            c.update();
            if (c.isFinished) this.customers.splice(index, 1);
        });

        this.updateUI();
    }

    processEndOfMonth() {
        const rent = 200;
        this.money -= rent;
        alert("Monatsende! Miete abgezogen: 200$");
        if (this.money < 0) alert("GAME OVER!");
    }

    updateUI() {
        document.getElementById('money-display').innerText = this.money;
        document.getElementById('day-display').innerText = Math.floor(this.totalSeconds / 10) + 1;
    }

    render() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Grid zeichnen
        for (let y = 0; y < GRID_HEIGHT; y++) {
            for (let x = 0; x < GRID_WIDTH; x++) {
                ctx.strokeStyle = "#333";
                ctx.strokeRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);

                const tile = this.grid[y][x];
                if (tile) {
                    if (tile.type === 'entrance') ctx.fillStyle = "#2ecc71";
                    if (tile.type === 'shelf') ctx.fillStyle = "#d35400";
                    if (tile.type === 'register') ctx.fillStyle = "#2980b9";
                    ctx.fillRect(x * TILE_SIZE + 2, y * TILE_SIZE + 2, TILE_SIZE - 4, TILE_SIZE - 4);
                }
            }
        }

        // Kunden zeichnen
        this.customers.forEach(c => c.draw(ctx));

        requestAnimationFrame(() => this.render());
    }

    saveGame() {
        const data = { money: this.money, grid: this.grid };
        localStorage.setItem('tycoonSave', JSON.stringify(data));
        document.getElementById('status-msg').innerText = "Gespeichert!";
    }

    loadGame() {
        const saved = localStorage.getItem('tycoonSave');
        if (saved) {
            const data = JSON.parse(saved);
            this.money = data.money;
            this.grid = data.grid;
            this.updateUI();
        }
    }

    resetGame() {
        localStorage.removeItem('tycoonSave');
        location.reload();
    }
}

const game = new Game();
