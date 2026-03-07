// =============================================================================
// SCRIPT 2 — StoreBuilder.js
// =============================================================================
// Handles the entire 2D grid-based building system.
// - Tile placement / deletion with overlap prevention
// - Object rotation
// - Valid/invalid tile highlighting
// - Pathfinding node graph maintenance (used by CustomerAI A*)
// - Entrance/exit tracking
// - Expansion zones
// =============================================================================

// ── Tile type constants ──────────────────────────────────────────────────────
const TILE = Object.freeze({
  EMPTY      : 0,
  FLOOR      : 1,
  PATH       : 2,   // walkable, guides customers
  WALL       : 3,
  SHELF      : 4,   // holds products; blocks movement
  CHECKOUT   : 5,   // checkout counter; semi-blocking
  ENTRANCE   : 6,   // customer spawn point
  EXIT       : 7,
  STORAGE    : 8,
  DECORATION : 9,
  CAMERA     : 10,
  DIRTY      : 11,  // runtime dirt overlay (not a placed tile)
});

const TILE_META = {
  [TILE.EMPTY]:      { walkable: false, buildable: true,  label: 'Empty',    color: '#1a1a2e', cost: 0    },
  [TILE.FLOOR]:      { walkable: true,  buildable: false, label: 'Floor',    color: '#2d2d44', cost: 10   },
  [TILE.PATH]:       { walkable: true,  buildable: false, label: 'Path',     color: '#3a5a3a', cost: 15   },
  [TILE.WALL]:       { walkable: false, buildable: false, label: 'Wall',     color: '#4a4a4a', cost: 20   },
  [TILE.SHELF]:      { walkable: false, buildable: false, label: 'Shelf',    color: '#8B6914', cost: 150  },
  [TILE.CHECKOUT]:   { walkable: false, buildable: false, label: 'Checkout', color: '#1a6b8a', cost: 300  },
  [TILE.ENTRANCE]:   { walkable: true,  buildable: false, label: 'Entrance', color: '#2a8a2a', cost: 0    },
  [TILE.EXIT]:       { walkable: true,  buildable: false, label: 'Exit',     color: '#8a2a2a', cost: 0    },
  [TILE.STORAGE]:    { walkable: true,  buildable: false, label: 'Storage',  color: '#5a3a1a', cost: 500  },
  [TILE.DECORATION]: { walkable: false, buildable: false, label: 'Decor',    color: '#6a1a6a', cost: 80   },
  [TILE.CAMERA]:     { walkable: false, buildable: false, label: 'Camera',   color: '#1a1a8a', cost: 200  },
};

// ── Object definitions (multi-tile footprints) ────────────────────────────────
const OBJECTS = {
  shelf_small:  { w:1, h:2, tile:TILE.SHELF,    capacity:8,  repBonus:0,   label:'Small Shelf'     },
  shelf_large:  { w:1, h:3, tile:TILE.SHELF,    capacity:16, repBonus:0,   label:'Large Shelf'     },
  checkout:     { w:2, h:1, tile:TILE.CHECKOUT, capacity:0,  repBonus:2,   label:'Checkout Counter'},
  storage_room: { w:3, h:3, tile:TILE.STORAGE,  capacity:0,  repBonus:0,   label:'Storage Room'    },
  plant:        { w:1, h:1, tile:TILE.DECORATION,capacity:0, repBonus:1,   label:'Plant'           },
  banner:       { w:2, h:1, tile:TILE.DECORATION,capacity:0, repBonus:2,   label:'Banner'          },
  camera:       { w:1, h:1, tile:TILE.CAMERA,   capacity:0,  repBonus:0,   label:'Security Camera' },
};

// ── Directions for A* ─────────────────────────────────────────────────────────
const DIRS4 = [{ dx:0,dy:-1 },{ dx:0,dy:1 },{ dx:-1,dy:0 },{ dx:1,dy:0 }];
const DIRS8 = [...DIRS4,
  { dx:-1,dy:-1 },{ dx:1,dy:-1 },{ dx:-1,dy:1 },{ dx:1,dy:1 }];

// =============================================================================

class StoreBuilder {
  constructor(cols = 30, rows = 30) {
    this.cols = cols;
    this.rows = rows;

    // ── Grid data ────────────────────────────────────────────────────────────
    // Each cell: { base: TILE, object: null | ObjectInstance, dirty: bool, secured: bool }
    this.grid = [];

    // ── Placed objects registry ──────────────────────────────────────────────
    this.objects = [];   // ObjectInstance[]

    // ── Mode ─────────────────────────────────────────────────────────────────
    this.mode          = 'VIEW';   // VIEW | BUILD | DELETE
    this.selectedTool  = TILE.FLOOR;
    this.selectedObj   = null;     // key in OBJECTS or null
    this.rotation      = 0;        // 0|90|180|270

    // ── Hover / highlight ────────────────────────────────────────────────────
    this.hoverCell     = null;     // { x, y }
    this.isValidHover  = false;

    // ── Special tiles ────────────────────────────────────────────────────────
    this.entrancePos   = null;
    this.exitPos       = null;
    this.checkoutTiles = [];       // { x, y }[]
    this.shelves       = [];       // ObjectInstance[]
    this.storageTiles  = [];       // { x, y }[]

    // ── Pathfinding graph cache ───────────────────────────────────────────────
    this._pathGraphDirty = true;

    // ── Expansion zones ───────────────────────────────────────────────────────
    this.expansionZones = [];      // { x, y, w, h, locked: bool }

    // ── Decoration reputation bonus ──────────────────────────────────────────
    this.decorationRepBonus = 0;

    // ── Reference to game manager (set externally) ────────────────────────────
    this.gameManager = null;
  }

  // ── Initialise the grid ────────────────────────────────────────────────────
  init() {
    this.grid = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ({
        base: TILE.EMPTY, object: null, dirty: false, secured: false
      }))
    );

    // Place default starter layout
    this._placeStarterLayout();
    this._pathGraphDirty = true;
    console.log('[StoreBuilder] Grid initialised.');
  }

  // ── Default starter room ───────────────────────────────────────────────────
  _placeStarterLayout() {
    // 10×10 starter room in the top-left corner (tiles 1-10, 1-10)
    for (let y = 1; y <= 10; y++) {
      for (let x = 1; x <= 10; x++) {
        const isWall = x === 1 || x === 10 || y === 1 || y === 10;
        this._setBase(x, y, isWall ? TILE.WALL : TILE.FLOOR);
      }
    }

    // Entrance at bottom-left
    this._setBase(3, 10, TILE.ENTRANCE);
    this.entrancePos = { x: 3, y: 10 };

    // Exit at bottom-right
    this._setBase(8, 10, TILE.EXIT);
    this.exitPos = { x: 8, y: 10 };

    // A central path aisle
    for (let y = 2; y <= 9; y++) this._setBase(5, y, TILE.PATH);

    // Two small starter shelves
    this._placeObjectAt('shelf_small', 2, 3, 0);
    this._placeObjectAt('shelf_small', 3, 3, 0);

    // One checkout
    this._placeObjectAt('checkout', 4, 8, 0);

    // Storage room stub
    for (let y = 2; y <= 4; y++)
      for (let x = 7; x <= 9; x++) this._setBase(x, y, TILE.STORAGE);
    this.storageTiles = [{ x:7,y:2 }];

    // Expansion zones (locked until level-up)
    this.expansionZones = [
      { x:11, y:1,  w:10, h:10, locked:true,  label:'East Wing'  },
      { x:1,  y:11, w:10, h:10, locked:true,  label:'South Wing' },
    ];
  }

  // ── Low-level grid helpers ─────────────────────────────────────────────────
  _inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }
  _cell(x, y)         { return this._inBounds(x, y) ? this.grid[y][x] : null; }
  _setBase(x, y, t)   { if (this._inBounds(x, y)) this.grid[y][x].base = t; }

  isWalkable(x, y) {
    const c = this._cell(x, y);
    if (!c) return false;
    return TILE_META[c.base]?.walkable === true && c.object === null;
  }

  // ── Tool selection ─────────────────────────────────────────────────────────
  selectTile(tileType) {
    this.selectedTool = tileType;
    this.selectedObj  = null;
  }
  selectObject(objKey) {
    this.selectedObj  = objKey;
    this.selectedTool = null;
  }
  rotate() {
    this.rotation = (this.rotation + 90) % 360;
  }

  // ── Hover update (called on mouse move) ───────────────────────────────────
  setHover(x, y) {
    this.hoverCell    = { x, y };
    this.isValidHover = this.selectedObj
      ? this._canPlaceObject(this.selectedObj, x, y, this.rotation)
      : this._canPlaceTile(this.selectedTool, x, y);
  }

  // ── Placement validation ───────────────────────────────────────────────────
  _canPlaceTile(tileType, x, y) {
    if (tileType === null || tileType === undefined) return false;
    const c = this._cell(x, y);
    if (!c) return false;
    if (c.object) return false;   // occupied by an object
    const meta = TILE_META[tileType];
    if (!meta) return false;

    // Floor/path can only replace EMPTY
    if (tileType === TILE.FLOOR || tileType === TILE.PATH)
      return c.base === TILE.EMPTY;

    return true;
  }

  _canPlaceObject(objKey, x, y, rotation) {
    const def = OBJECTS[objKey];
    if (!def) return false;
    const { w, h } = this._rotatedSize(def.w, def.h, rotation);

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const c = this._cell(x + dx, y + dy);
        if (!c) return false;
        if (c.object) return false;
        // Objects must be placed on floor or path
        if (c.base !== TILE.FLOOR && c.base !== TILE.PATH) return false;
      }
    }
    return true;
  }

  _rotatedSize(w, h, rotation) {
    return (rotation === 90 || rotation === 270)
      ? { w: h, h: w }
      : { w, h };
  }

  // ── Primary placement API ─────────────────────────────────────────────────
  place(x, y) {
    if (!this._checkFunds()) return false;

    if (this.selectedObj) {
      return this._placeObjectAt(this.selectedObj, x, y, this.rotation);
    } else if (this.selectedTool !== null) {
      return this._placeTileAt(this.selectedTool, x, y);
    }
    return false;
  }

  _placeTileAt(tileType, x, y) {
    if (!this._canPlaceTile(tileType, x, y)) return false;
    const cost = TILE_META[tileType]?.cost ?? 0;
    if (!this._spendMoney(cost)) return false;

    this._setBase(x, y, tileType);
    this._pathGraphDirty = true;
    this._updateSpecialTiles(x, y, tileType);
    return true;
  }

  _placeObjectAt(objKey, x, y, rotation) {
    if (!this._canPlaceObject(objKey, x, y, rotation)) return false;
    const def  = OBJECTS[objKey];
    const cost = def.cost ?? (TILE_META[def.tile]?.cost ?? 0);
    if (!this._spendMoney(cost)) return false;

    const { w, h } = this._rotatedSize(def.w, def.h, rotation);
    const instance = {
      key: objKey, def, x, y, w, h, rotation,
      id: `obj_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      // Runtime state
      stock: def.capacity, maxStock: def.capacity,
      category: null,
    };

    // Stamp footprint onto grid
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.grid[y + dy][x + dx].object = instance;
        this._setBase(x + dx, y + dy, def.tile);
      }
    }

    this.objects.push(instance);
    this._pathGraphDirty = true;
    this._indexSpecialObject(instance);
    return instance;
  }

  // ── Deletion ──────────────────────────────────────────────────────────────
  delete(x, y) {
    const c = this._cell(x, y);
    if (!c) return false;

    if (c.object) {
      return this._deleteObject(c.object);
    } else if (c.base !== TILE.EMPTY) {
      this._setBase(x, y, TILE.EMPTY);
      this._pathGraphDirty = true;
      return true;
    }
    return false;
  }

  _deleteObject(instance) {
    for (let dy = 0; dy < instance.h; dy++) {
      for (let dx = 0; dx < instance.w; dx++) {
        const c = this._cell(instance.x + dx, instance.y + dy);
        if (c) {
          c.object = null;
          c.base   = TILE.FLOOR;
        }
      }
    }
    this.objects = this.objects.filter(o => o.id !== instance.id);
    this.shelves  = this.shelves.filter(o => o.id !== instance.id);
    this.checkoutTiles = this.checkoutTiles.filter(t =>
      !(t.x >= instance.x && t.x < instance.x + instance.w &&
        t.y >= instance.y && t.y < instance.y + instance.h));
    this._recalcDecorationBonus();
    this._pathGraphDirty = true;
    return true;
  }

  // ── Index special objects ─────────────────────────────────────────────────
  _indexSpecialObject(inst) {
    if (inst.def.tile === TILE.SHELF)    this.shelves.push(inst);
    if (inst.def.tile === TILE.CHECKOUT) {
      // The interaction point is directly in front (below) the checkout
      this.checkoutTiles.push({ x: inst.x, y: inst.y + inst.h, instance: inst });
    }
    if (inst.def.tile === TILE.DECORATION) this._recalcDecorationBonus();
    if (inst.def.tile === TILE.CAMERA) {
      // Mark covered tiles as secured
      this._markSecuredArea(inst.x, inst.y, 5);
    }
  }

  _updateSpecialTiles(x, y, tileType) {
    if (tileType === TILE.ENTRANCE) this.entrancePos = { x, y };
    if (tileType === TILE.EXIT)     this.exitPos     = { x, y };
    if (tileType === TILE.STORAGE)  this.storageTiles.push({ x, y });
  }

  _markSecuredArea(cx, cy, radius) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const c = this._cell(cx + dx, cy + dy);
        if (c) c.secured = true;
      }
    }
  }

  _recalcDecorationBonus() {
    this.decorationRepBonus = this.objects
      .filter(o => o.def.tile === TILE.DECORATION || o.def.tile === TILE.CHECKOUT)
      .reduce((sum, o) => sum + (o.def.repBonus ?? 0), 0);
  }

  // ── Expansion zone unlock ─────────────────────────────────────────────────
  unlockExpansionZone(index) {
    const zone = this.expansionZones[index];
    if (!zone || !zone.locked) return false;
    if (!this._spendMoney(2000)) return false;

    zone.locked = false;
    // Fill zone with floor
    for (let y = zone.y; y < zone.y + zone.h; y++) {
      for (let x = zone.x; x < zone.x + zone.w; x++) {
        if (this._inBounds(x, y)) this._setBase(x, y, TILE.FLOOR);
      }
    }
    this._pathGraphDirty = true;
    console.log(`[StoreBuilder] Expansion zone "${zone.label}" unlocked.`);
    return true;
  }

  // ── Pathfinding: A* ───────────────────────────────────────────────────────

  /** Find shortest walkable path from (sx,sy) to (ex,ey). Returns cell array or null. */
  findPath(sx, sy, ex, ey) {
    if (!this.isWalkable(ex, ey)) return null;

    const key  = (x, y) => y * this.cols + x;
    const h    = (x, y) => Math.abs(x - ex) + Math.abs(y - ey);

    const open   = new MinHeap(n => n.f);
    const closed = new Set();
    const cameFrom = {};
    const gScore   = {};

    const start = { x: sx, y: sy, g: 0, f: h(sx, sy) };
    gScore[key(sx, sy)] = 0;
    open.push(start);

    let iterations = 0;
    const MAX_ITER  = 2000;

    while (!open.isEmpty() && iterations++ < MAX_ITER) {
      const current = open.pop();
      const ck      = key(current.x, current.y);

      if (current.x === ex && current.y === ey) {
        // Reconstruct path
        const path = [];
        let node   = ck;
        while (node !== undefined) {
          const nx = node % this.cols;
          const ny = Math.floor(node / this.cols);
          path.unshift({ x: nx, y: ny });
          node = cameFrom[node];
        }
        return path;
      }

      if (closed.has(ck)) continue;
      closed.add(ck);

      for (const { dx, dy } of DIRS4) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (!this.isWalkable(nx, ny)) continue;

        const nk = key(nx, ny);
        if (closed.has(nk)) continue;

        const ng = current.g + 1;
        if (ng < (gScore[nk] ?? Infinity)) {
          gScore[nk]    = ng;
          cameFrom[nk]  = ck;
          open.push({ x: nx, y: ny, g: ng, f: ng + h(nx, ny) });
        }
      }
    }
    return null; // no path
  }

  /** Returns walkable neighbours (used by customers for exploratory checks). */
  getWalkableNeighbours(x, y) {
    return DIRS4
      .map(({ dx, dy }) => ({ x: x + dx, y: y + dy }))
      .filter(p => this.isWalkable(p.x, p.y));
  }

  /** Returns the closest checkout queue position. */
  getCheckoutQueuePos(checkoutInstance) {
    // Queue forms directly below the checkout footprint
    const qx = checkoutInstance.x;
    const qy = checkoutInstance.y + checkoutInstance.h;
    return { x: qx, y: qy };
  }

  /** Returns the nearest shelf that carries a given category. */
  findShelfForCategory(category) {
    return this.shelves.find(s => s.category === category && s.stock > 0) ?? null;
  }

  /** Returns all shelves that need restocking. */
  getEmptyShelves() {
    return this.shelves.filter(s => s.stock === 0);
  }

  // ── Entrance position ─────────────────────────────────────────────────────
  getEntrancePosition() { return this.entrancePos; }
  getExitPosition()     { return this.exitPos; }

  // ── Dirty floor marking (called when customer spills, etc.) ───────────────
  markDirty(x, y) {
    const c = this._cell(x, y);
    if (c) c.dirty = true;
  }
  cleanTile(x, y) {
    const c = this._cell(x, y);
    if (c) c.dirty = false;
  }
  getDirtyTiles() {
    const dirty = [];
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++)
        if (this.grid[y][x].dirty) dirty.push({ x, y });
    return dirty;
  }

  // ── Economy bridge ────────────────────────────────────────────────────────
  _spendMoney(amount) {
    if (!this.gameManager) return true; // dev mode
    return this.gameManager.economySystem.spend(amount, 'construction');
  }
  _checkFunds() {
    return true; // actual check done in _spendMoney
  }

  // ── Serialization ─────────────────────────────────────────────────────────
  serialize() {
    return {
      cols: this.cols, rows: this.rows,
      grid: this.grid.map(row => row.map(c => ({ base: c.base, dirty: c.dirty, secured: c.secured }))),
      objects: this.objects.map(o => ({
        key: o.key, x: o.x, y: o.y, rotation: o.rotation,
        stock: o.stock, category: o.category,
      })),
      expansionZones: this.expansionZones,
    };
  }

  deserialize(data) {
    this.cols = data.cols;
    this.rows = data.rows;
    this.init();
    // Restore grid bases
    data.grid.forEach((row, y) =>
      row.forEach((c, x) => {
        this.grid[y][x].base    = c.base;
        this.grid[y][x].dirty   = c.dirty;
        this.grid[y][x].secured = c.secured;
      })
    );
    // Restore objects
    data.objects.forEach(o => {
      const inst = this._placeObjectAt(o.key, o.x, o.y, o.rotation);
      if (inst) { inst.stock = o.stock; inst.category = o.category; }
    });
    this.expansionZones = data.expansionZones;
    this._pathGraphDirty = true;
  }
}

// ── MinHeap utility (used by A*) ──────────────────────────────────────────────
class MinHeap {
  constructor(keyFn) { this._data = []; this._key = keyFn; }
  push(item) {
    this._data.push(item);
    this._bubbleUp(this._data.length - 1);
  }
  pop() {
    const top  = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0) { this._data[0] = last; this._sinkDown(0); }
    return top;
  }
  isEmpty() { return this._data.length === 0; }
  _bubbleUp(i) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this._key(this._data[p]) <= this._key(this._data[i])) break;
      [this._data[i], this._data[p]] = [this._data[p], this._data[i]];
      i = p;
    }
  }
  _sinkDown(i) {
    const n = this._data.length;
    while (true) {
      let m = i;
      const l = 2*i+1, r = 2*i+2;
      if (l < n && this._key(this._data[l]) < this._key(this._data[m])) m = l;
      if (r < n && this._key(this._data[r]) < this._key(this._data[m])) m = r;
      if (m === i) break;
      [this._data[i], this._data[m]] = [this._data[m], this._data[i]];
      i = m;
    }
  }
}
