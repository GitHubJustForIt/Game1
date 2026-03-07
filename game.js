const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const TILE = 32;
const ROWS = 20, COLS = 25;

let money = 1500;
let stock = 50;
let buildMode = null;
let grid = Array(ROWS).fill().map(() => Array(COLS).fill(null));
let entities = []; // Kunden & Mitarbeiter

const COLORS = {
    path: '#334155',
    shelf: '#f97316',
    register: '#0ea5e9',
    warehouse: '#64748b'
};

// Initiales Setup: Lager und Eingang
grid[2][2] = { type: 'warehouse' };
grid[0][12] = { type: 'path' }; // Eingangspunkt

function setMode(m) { 
    buildMode = m; 
    document.querySelectorAll('.build').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
}

canvas.width = COLS * TILE;
canvas.height = ROWS * TILE;

// --- LOGIK ---

function handleInput(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / TILE);
    const y = Math.floor((e.clientY - rect.top) / TILE);

    if (buildMode === 'delete') {
        grid[y][x] = null;
    } else if (buildMode === 'path') {
        if (money >= 5) { grid[y][x] = { type: 'path' }; money -= 5; }
    } else if (buildMode) {
        // Regale/Kassen dürfen NUR auf Pfaden stehen (oder daneben, hier zur Vereinfachung: auf Pfad bauen)
        const cost = buildMode === 'shelf' ? 50 : 150;
        if (money >= cost) {
            grid[y][x] = { type: buildMode, inv: 0 };
            money -= cost;
        }
    }
    updateUI();
}

canvas.addEventListener('mousedown', handleInput);

function orderTruck() {
    if (money >= 200) {
        money -= 200;
        stock += 100;
        updateUI();
        log("LKW geliefert!");
    }
}

function updateUI() {
    document.getElementById('money').innerText = money;
    document.getElementById('stock').innerText = stock;
}

function log(m) { document.getElementById('msg').innerText = m; }

// --- ENTITIES (Kunden & Mitarbeiter) ---

class Entity {
    constructor(type) {
        this.type = type; // 'customer' oder 'worker'
        this.x = 12 * TILE; this.y = 0;
        this.speed = type === 'customer' ? 4 : 3;
        this.target = null;
        this.state = 'idle';
        this.inventory = 0;
    }

    update() {
        if (!this.target) this.findNewTarget();
        else this.move();
    }

    findNewTarget() {
        if (this.type === 'customer') {
            if (this.state === 'idle') {
                this.target = this.getRandomTile('shelf');
                this.state = 'shopping';
            } else if (this.state === 'shopping') {
                this.target = this.getRandomTile('register');
                this.state = 'paying';
            } else if (this.state === 'paying') {
                this.target = { x: 12, y: 0 }; // Ausgang
                this.state = 'leaving';
            } else {
                entities = entities.filter(e => e !== this);
                money += 20; 
            }
        } 
        
        if (this.type === 'worker') {
            if (this.inventory === 0) {
                this.target = this.getRandomTile('warehouse');
                this.state = 'loading';
            } else {
                this.target = this.getRandomTile('shelf');
                this.state = 'restocking';
            }
        }
    }

    move() {
        const tx = this.target.x * TILE;
        const ty = this.target.y * TILE;
        
        if (this.x < tx) this.x += this.speed;
        else if (this.x > tx) this.x -= this.speed;
        
        if (this.y < ty) this.y += this.speed;
        else if (this.y > ty) this.y -= this.speed;

        if (Math.abs(this.x - tx) < 5 && Math.abs(this.y - ty) < 5) {
            this.interact();
            this.target = null;
        }
    }

    interact() {
        if (this.state === 'loading' && stock > 0) {
            stock -= 10; this.inventory = 10;
        } else if (this.state === 'restocking') {
            this.inventory = 0; // Regal aufgefüllt (vereinfacht)
        }
    }

    getRandomTile(type) {
        let matches = [];
        for(let y=0; y<ROWS; y++) 
            for(let x=0; x<COLS; x++) 
                if(grid[y][x]?.type === type) matches.push({x, y});
        return matches.length ? matches[Math.floor(Math.random()*matches.length)] : null;
    }

    draw() {
        ctx.fillStyle = this.type === 'customer' ? '#fbbf24' : '#a855f7';
        ctx.beginPath();
        ctx.arc(this.x + 16, this.y + 16, 10, 0, Math.PI*2);
        ctx.fill();
        // Sprechblase wenn leer
        if(this.state === 'shopping' && this.type === 'customer') {
            ctx.fillStyle = "white"; ctx.fillText("🛒", this.x, this.y);
        }
    }
}

function hireWorker() {
    if (money >= 300) {
        money -= 300;
        entities.push(new Entity('worker'));
        updateUI();
    }
}

// --- GAME LOOP ---

function loop() {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid zeichnen
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const tile = grid[y][x];
            if (tile) {
                ctx.fillStyle = COLORS[tile.type];
                ctx.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
                
                // Waren-Anzeige bei Regalen
                if (tile.type === 'shelf') {
                    ctx.fillStyle = "white";
                    ctx.font = "10px Arial";
                    ctx.fillText("📦", x*TILE+5, y*TILE+20);
                }
            }
        }
    }

    entities.forEach(e => { e.update(); e.draw(); });

    if (Math.random() < 0.02) entities.push(new Entity('customer'));

    requestAnimationFrame(loop);
}

loop();
