// =============================================================================
// SCRIPT 4 — EmployeeSystem.js
// =============================================================================
// Manages all employee agents.
//
// Employee types: Cashier | Restocker | Cleaner | Manager
// Each employee is driven by a priority-queue task system:
//   → scan for highest-priority available task
//   → path to it
//   → execute it
//   → repeat
//
// Employees have stats (skill, energy, speed) that affect performance.
// Energy depletes over time; employees rest when energy is low.
// Manager boosts all nearby employees.
// =============================================================================

// ── Employee type constants ───────────────────────────────────────────────────
const EMP_TYPE = Object.freeze({
  CASHIER   : 'CASHIER',
  RESTOCKER : 'RESTOCKER',
  CLEANER   : 'CLEANER',
  MANAGER   : 'MANAGER',
});

// ── Employee state machine ────────────────────────────────────────────────────
const EMP_STATE = Object.freeze({
  IDLE          : 'IDLE',
  WALKING       : 'WALKING',
  WORKING       : 'WORKING',
  RESTING       : 'RESTING',
  FETCHING_STOCK: 'FETCHING_STOCK',   // Restocker walking to storage
  DELIVERING    : 'DELIVERING',        // Restocker walking to shelf
});

// ── Base stats per type ───────────────────────────────────────────────────────
const TYPE_BASE_STATS = {
  [EMP_TYPE.CASHIER]:   { baseSalary: 80,  baseSpeed: 1.0, baseEfficiency: 1.0 },
  [EMP_TYPE.RESTOCKER]: { baseSalary: 70,  baseSpeed: 1.2, baseEfficiency: 1.0 },
  [EMP_TYPE.CLEANER]:   { baseSalary: 60,  baseSpeed: 1.0, baseEfficiency: 1.0 },
  [EMP_TYPE.MANAGER]:   { baseSalary: 150, baseSpeed: 0.9, baseEfficiency: 1.5 },
};

// ── Task definitions ──────────────────────────────────────────────────────────
// Priority: lower number = more urgent
const TASK_PRIORITY = {
  SERVE_CUSTOMER   : 1,   // Cashier
  RESTOCK_SHELF    : 1,   // Restocker
  CLEAN_MESS       : 1,   // Cleaner
  ORGANIZE_STOCK   : 3,   // Restocker
  PATROL           : 5,   // Cleaner / Manager
  BOOST_EMPLOYEES  : 2,   // Manager
  REST             : 10,  // all
};

// =============================================================================
// Employee agent
// =============================================================================

class Employee {
  constructor(id, type, gameManager) {
    this.id          = id;
    this.type        = type;
    this.gameManager = gameManager;

    // ── Spawning position (set when hired) ──────────────────────────────────
    this.x = 0;
    this.y = 0;

    // ── Skill (1-10, improves over time) ────────────────────────────────────
    this.skillLevel  = 1 + Math.floor(Math.random() * 3);  // 1–3 at hire
    this.experience  = 0;

    // ── Base stats ──────────────────────────────────────────────────────────
    const base       = TYPE_BASE_STATS[type];
    this.salary      = base.baseSalary * (0.9 + Math.random() * 0.2);   // ±10%
    this.baseSpeed   = base.baseSpeed;
    this.efficiency  = base.baseEfficiency;

    // ── Energy (0–100) ───────────────────────────────────────────────────────
    this.energy      = 100;
    this.isResting   = false;

    // ── State machine ────────────────────────────────────────────────────────
    this.state       = EMP_STATE.IDLE;
    this.stateTimer  = 0;
    this.currentTask = null;
    this.currentPath = [];
    this.pathIndex   = 0;

    // ── Type-specific runtime data ────────────────────────────────────────────
    this.assignedCheckout = null;   // Cashier only
    this.carriedStock     = null;   // Restocker: { category, amount }

    // ── Manager boost range ──────────────────────────────────────────────────
    this.boostRadius = 5;   // tiles
  }

  // ── Effective speed after skill and energy adjustments ───────────────────
  get speed() {
    const energyFactor = 0.5 + (this.energy / 100) * 0.5;    // 50–100% speed
    const skillFactor  = 1 + (this.skillLevel - 1) * 0.05;   // +5% per skill level
    return this.baseSpeed * energyFactor * skillFactor;
  }

  get effectiveEfficiency() {
    const skillFactor  = 1 + (this.skillLevel - 1) * 0.08;
    const energyFactor = 0.6 + (this.energy / 100) * 0.4;
    return this.efficiency * skillFactor * energyFactor;
  }

  // ── Main tick ─────────────────────────────────────────────────────────────
  tick(delta) {
    this.stateTimer += delta;

    // Energy drain
    this._drainEnergy(delta);

    // Check for rest
    if (this.energy <= 10 && !this.isResting) {
      this._startResting();
      return;
    }
    if (this.isResting) {
      this._tickResting(delta);
      return;
    }

    // State dispatch
    switch (this.state) {
      case EMP_STATE.IDLE:           this._tickIdle();             break;
      case EMP_STATE.WALKING:        this._tickWalking(delta);     break;
      case EMP_STATE.WORKING:        this._tickWorking(delta);     break;
      case EMP_STATE.FETCHING_STOCK: this._tickFetchingStock(delta);break;
      case EMP_STATE.DELIVERING:     this._tickDelivering(delta);  break;
    }

    // Gain experience passively
    this.experience += delta * 0.01;
    this._checkLevelUp();
  }

  // ── Energy management ─────────────────────────────────────────────────────
  _drainEnergy(delta) {
    const drain = this.state === EMP_STATE.WORKING ? 2.0 : 0.5;
    this.energy = Math.max(0, this.energy - drain * delta);
  }

  _startResting() {
    this.isResting   = true;
    this.currentTask = null;
    this._setState(EMP_STATE.RESTING);
  }

  _tickResting(delta) {
    this.energy = Math.min(100, this.energy + 10 * delta); // recover 10/sec
    if (this.energy >= 90) {
      this.isResting = false;
      this._setState(EMP_STATE.IDLE);
    }
  }

  // ── IDLE: Find highest-priority task ─────────────────────────────────────
  _tickIdle() {
    if (this.stateTimer < 0.5) return; // short pause before re-evaluating

    const task = this._pickBestTask();
    if (!task) return; // nothing to do

    this.currentTask = task;
    this._beginTask(task);
  }

  // ── Task selection per employee type ─────────────────────────────────────
  _pickBestTask() {
    const gm = this.gameManager;
    const sb = gm.storeBuilder;

    switch (this.type) {

      case EMP_TYPE.CASHIER: {
        // 1) Serve a waiting customer at assigned checkout
        if (this.assignedCheckout) {
          const q = gm.customerAI.getQueueFor(this.assignedCheckout);
          if (q && q.length > 0) return { type:'SERVE_CUSTOMER', priority:1, target: this.assignedCheckout };
        }
        // 2) Find any checkout with a queue
        const checkout = sb.checkoutTiles[0];
        if (checkout) return { type:'SERVE_CUSTOMER', priority:1, target: checkout.instance };
        return null;
      }

      case EMP_TYPE.RESTOCKER: {
        // 1) Find empty shelves
        const emptyShelf = sb.getEmptyShelves()[0];
        if (emptyShelf) return { type:'RESTOCK_SHELF', priority:1, target: emptyShelf };
        // 2) Organise partial shelves
        const lowShelf = sb.shelves.find(s => s.stock < s.maxStock * 0.5);
        if (lowShelf) return { type:'ORGANIZE_STOCK', priority:3, target: lowShelf };
        // 3) Idle patrol
        return { type:'PATROL', priority:5, target: null };
      }

      case EMP_TYPE.CLEANER: {
        // 1) Clean dirt
        const dirtyTile = sb.getDirtyTiles()[0];
        if (dirtyTile) return { type:'CLEAN_MESS', priority:1, target: dirtyTile };
        // 2) Patrol
        return { type:'PATROL', priority:5, target: null };
      }

      case EMP_TYPE.MANAGER: {
        // 1) Boost nearby employees
        return { type:'BOOST_EMPLOYEES', priority:2, target: null };
      }

      default: return null;
    }
  }

  // ── Begin executing a task ────────────────────────────────────────────────
  _beginTask(task) {
    const sb = this.gameManager.storeBuilder;

    switch (task.type) {
      case 'SERVE_CUSTOMER': {
        // Walk to checkout
        if (task.target) {
          const qPos = sb.getCheckoutQueuePos(task.target);
          this._walkTo(qPos.x, qPos.y - 1, EMP_STATE.WORKING);
          this.assignedCheckout = task.target;
        }
        break;
      }
      case 'RESTOCK_SHELF': {
        // First go to storage to pick up stock
        const storage = sb.storageTiles[0];
        if (storage) {
          this._walkTo(storage.x, storage.y, EMP_STATE.FETCHING_STOCK);
        }
        break;
      }
      case 'ORGANIZE_STOCK': {
        const target = this._getAccessPoint(task.target, sb);
        if (target) this._walkTo(target.x, target.y, EMP_STATE.WORKING);
        break;
      }
      case 'CLEAN_MESS': {
        this._walkTo(task.target.x, task.target.y, EMP_STATE.WORKING);
        break;
      }
      case 'PATROL': {
        const dest = this._randomWalkableTile(sb);
        if (dest) this._walkTo(dest.x, dest.y, EMP_STATE.IDLE);
        break;
      }
      case 'BOOST_EMPLOYEES': {
        // Manager stands near employees; no walking needed
        this._setState(EMP_STATE.WORKING);
        break;
      }
    }
  }

  // ── WALKING: Follow path ──────────────────────────────────────────────────
  _tickWalking(delta) {
    this._followPath(delta);
    if (this._reachedPathEnd()) {
      this._setState(this._postWalkState || EMP_STATE.WORKING);
    }
  }

  // ── WORKING: Execute current task ─────────────────────────────────────────
  _tickWorking(delta) {
    if (!this.currentTask) { this._setState(EMP_STATE.IDLE); return; }

    const task = this.currentTask;
    const gm   = this.gameManager;
    const sb   = gm.storeBuilder;

    switch (task.type) {
      case 'SERVE_CUSTOMER': {
        // Just being present at checkout speeds up the queue
        // (CheckoutQueue.tick checks for cashier skill)
        if (this.stateTimer > 30) {
          // Re-evaluate after 30 sec in case queue is gone
          this._setState(EMP_STATE.IDLE);
        }
        break;
      }
      case 'ORGANIZE_STOCK': {
        const shelf = task.target;
        const fillRate = 1 * this.effectiveEfficiency * delta;
        shelf.stock = Math.min(shelf.maxStock, shelf.stock + fillRate);
        if (shelf.stock >= shelf.maxStock * 0.95) {
          this.experience += 5;
          this._setState(EMP_STATE.IDLE);
        }
        break;
      }
      case 'CLEAN_MESS': {
        if (this.stateTimer > (1.5 / this.effectiveEfficiency)) {
          sb.cleanTile(task.target.x, task.target.y);
          gm.awardReputation(0.2, 'cleaning');
          this.experience += 3;
          this._setState(EMP_STATE.IDLE);
        }
        break;
      }
      case 'BOOST_EMPLOYEES': {
        // Every second, boost nearby employees
        if (this.stateTimer > 1) {
          this.stateTimer = 0;
          this._applyManagerBoost();
        }
        break;
      }
    }
  }

  // ── FETCHING_STOCK: At storage, pick up goods ─────────────────────────────
  _tickFetchingStock(delta) {
    if (this.stateTimer < 1.5 / this.effectiveEfficiency) return;

    // Pick up stock for the target shelf's category
    const shelf = this.currentTask?.target;
    if (!shelf) { this._setState(EMP_STATE.IDLE); return; }

    this.carriedStock = { category: shelf.category, amount: shelf.maxStock };

    // Now walk to the shelf
    const sb     = this.gameManager.storeBuilder;
    const access = this._getAccessPoint(shelf, sb);
    if (access) {
      this._walkTo(access.x, access.y, EMP_STATE.DELIVERING);
    } else {
      this._setState(EMP_STATE.IDLE);
    }
  }

  // ── DELIVERING: At shelf, restock it ──────────────────────────────────────
  _tickDelivering(delta) {
    if (this.stateTimer < 2.0 / this.effectiveEfficiency) return;

    const shelf = this.currentTask?.target;
    if (shelf && this.carriedStock) {
      shelf.stock    = Math.min(shelf.maxStock, shelf.stock + this.carriedStock.amount);
      shelf.category = shelf.category ?? this.carriedStock.category;
      this.gameManager.awardReputation(0.3, 'shelf_restocked');
      this.experience += 8;
    }
    this.carriedStock = null;
    this._setState(EMP_STATE.IDLE);
  }

  // ── Manager boost ─────────────────────────────────────────────────────────
  _applyManagerBoost() {
    const es = this.gameManager.employeeSystem;
    es.employees.forEach(emp => {
      if (emp.id === this.id) return;
      const dx   = emp.x - this.x;
      const dy   = emp.y - this.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist <= this.boostRadius) {
        // Temporarily raise their efficiency (cap at 2x)
        emp.efficiency = Math.min(2.0, emp.efficiency + 0.01);
      }
    });
  }

  // ── Level-up ──────────────────────────────────────────────────────────────
  _checkLevelUp() {
    const threshold = this.skillLevel * 100;
    if (this.experience >= threshold && this.skillLevel < 10) {
      this.skillLevel++;
      this.experience = 0;
      console.log(`[Employee ${this.id}] Levelled up to skill ${this.skillLevel}`);
      this.gameManager.emit('employeeLevelUp', { employee: this });
    }
  }

  // ── Path helpers ─────────────────────────────────────────────────────────
  _walkTo(tx, ty, nextState) {
    const sb   = this.gameManager.storeBuilder;
    const path = sb.findPath(Math.round(this.x), Math.round(this.y), tx, ty);
    if (path) {
      this.currentPath   = path;
      this.pathIndex     = 0;
      this._postWalkState = nextState;
      this._setState(EMP_STATE.WALKING);
    } else {
      this._setState(nextState); // teleport fallback
    }
  }

  _followPath(delta) {
    if (this.pathIndex >= this.currentPath.length) return;
    const target = this.currentPath[this.pathIndex];
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const step = this.speed * delta;
    if (dist <= step) {
      this.x = target.x; this.y = target.y;
      this.pathIndex++;
    } else {
      this.x += (dx/dist)*step;
      this.y += (dy/dist)*step;
    }
  }

  _reachedPathEnd() {
    return this.currentPath.length > 0 && this.pathIndex >= this.currentPath.length;
  }

  _setState(s) {
    this.state      = s;
    this.stateTimer = 0;
    if (s !== EMP_STATE.WALKING) this.currentPath = [];
  }

  _getAccessPoint(obj, sb) {
    const w = obj.w ?? 1, h = obj.h ?? 1;
    const candidates = [
      { x: obj.x,       y: obj.y + h },
      { x: obj.x,       y: obj.y - 1 },
      { x: obj.x - 1,   y: obj.y     },
      { x: obj.x + w,   y: obj.y     },
    ];
    return candidates.find(p => sb.isWalkable(p.x, p.y)) ?? null;
  }

  _randomWalkableTile(sb) {
    for (let i = 0; i < 20; i++) {
      const x = Math.floor(Math.random() * sb.cols);
      const y = Math.floor(Math.random() * sb.rows);
      if (sb.isWalkable(x, y)) return { x, y };
    }
    return null;
  }

  // ── Render data ───────────────────────────────────────────────────────────
  getRenderData() {
    const colorMap = {
      [EMP_TYPE.CASHIER]:   '#f4d03f',
      [EMP_TYPE.RESTOCKER]: '#5dade2',
      [EMP_TYPE.CLEANER]:   '#a9cce3',
      [EMP_TYPE.MANAGER]:   '#ec7063',
    };
    return {
      id    : this.id,
      x     : this.x,
      y     : this.y,
      type  : this.type,
      state : this.state,
      energy: this.energy,
      skill : this.skillLevel,
      color : colorMap[this.type] ?? '#fff',
    };
  }

  serialize() {
    return { id: this.id, type: this.type, x: this.x, y: this.y,
             skillLevel: this.skillLevel, experience: this.experience,
             salary: this.salary, energy: this.energy };
  }
}

// =============================================================================
// EmployeeSystem — manages the entire employee roster
// =============================================================================

class EmployeeSystem {
  constructor(gameManager) {
    this.gameManager = gameManager;
    this.employees   = [];
    this._nextId     = 1;
  }

  init() {
    this.employees = [];
  }

  // ── Hire an employee ──────────────────────────────────────────────────────
  hire(type) {
    const level = this.gameManager.currentLevel;
    if (this.employees.length >= level.maxEmp) {
      console.warn('[EmployeeSystem] Max employees reached for this store level.');
      return null;
    }

    const id   = `emp_${this._nextId++}`;
    const emp  = new Employee(id, type, this.gameManager);

    // Spawn near entrance
    const entrance = this.gameManager.storeBuilder.getEntrancePosition() ?? { x:2, y:2 };
    emp.x = entrance.x;
    emp.y = entrance.y;

    // Deduct hiring bonus from economy
    const hiringCost = emp.salary * 0.5;
    if (!this.gameManager.economySystem.spend(hiringCost, 'hiring')) {
      console.warn('[EmployeeSystem] Not enough money to hire.');
      return null;
    }

    this.employees.push(emp);
    this.gameManager.emit('employeeHired', { employee: emp });
    console.log(`[EmployeeSystem] Hired ${type} (id: ${id})`);
    return emp;
  }

  // ── Fire an employee ──────────────────────────────────────────────────────
  fire(empId) {
    const idx = this.employees.findIndex(e => e.id === empId);
    if (idx === -1) return false;
    const emp = this.employees.splice(idx, 1)[0];
    this.gameManager.emit('employeeFired', { employee: emp });
    return true;
  }

  // ── Main tick ────────────────────────────────────────────────────────────
  tick(delta) {
    this.employees.forEach(e => e.tick(delta));
  }

  // ── Get cashier assigned to a checkout ───────────────────────────────────
  getCashierAt(checkoutInstance) {
    return this.employees.find(
      e => e.type === EMP_TYPE.CASHIER && e.assignedCheckout?.id === checkoutInstance.id
    ) ?? null;
  }

  // ── Daily salary processing (called by GameManager) ──────────────────────
  getDailySalaryTotal() {
    return this.employees.reduce((sum, e) => sum + e.salary, 0);
  }

  // ── Render data ───────────────────────────────────────────────────────────
  getRenderData() {
    return this.employees.map(e => e.getRenderData());
  }

  // ── Serialization ─────────────────────────────────────────────────────────
  serialize() {
    return { employees: this.employees.map(e => e.serialize()) };
  }

  deserialize(data) {
    this.init();
    (data.employees ?? []).forEach(d => {
      const emp = new Employee(d.id, d.type, this.gameManager);
      Object.assign(emp, d);
      this.employees.push(emp);
    });
  }
}
