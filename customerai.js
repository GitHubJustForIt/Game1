// =============================================================================
// SCRIPT 3 — CustomerAI.js
// =============================================================================
// The most sophisticated system. Controls all in-store customer agents.
//
// Each customer is an autonomous state-machine with:
//   • Personality (affects patience, budget, speed, shopping behaviour)
//   • A randomly generated shopping list
//   • A* pathfinding through the store grid
//   • A satisfaction rating that feeds back to GameManager reputation
//   • A patience timer that can cause them to abandon and leave angry
//   • Queue management at checkout counters
// =============================================================================

// ── Customer state machine states ─────────────────────────────────────────────
const C_STATE = Object.freeze({
  ENTERING       : 'ENTERING',       // walking from entrance to first aisle
  BROWSING       : 'BROWSING',       // choosing next item to find
  WALKING_TO_SHELF: 'WALKING_TO_SHELF', // following A* path to shelf
  PICKING_ITEM   : 'PICKING_ITEM',   // short animation at shelf
  WALKING_TO_CHECKOUT: 'WALKING_TO_CHECKOUT',
  QUEUEING       : 'QUEUEING',       // standing in checkout queue
  PAYING         : 'PAYING',         // being served at checkout
  WALKING_TO_EXIT: 'WALKING_TO_EXIT',
  EXITING        : 'EXITING',        // reached exit, remove from sim
  LEAVING_ANGRY  : 'LEAVING_ANGRY',  // walked out before finishing
  STEALING       : 'STEALING',       // if thief personality
});

// ── Personality definitions ───────────────────────────────────────────────────
const PERSONALITIES = {
  SPEED_SHOPPER: {
    label         : 'Speed Shopper',
    color         : '#ff6b35',
    patienceMult  : 0.8,    // less patient than average
    budgetMult    : 1.0,
    speedMult     : 1.5,    // moves faster
    listSizeMult  : 0.5,    // buys fewer items
    priceThreshold: 1.2,    // won't buy if price > 120% of base
    queueTolerance: 2,      // leaves if queue > 2 people
    spendPerItem  : 1.0,
  },
  CASUAL_BROWSER: {
    label         : 'Casual Browser',
    color         : '#88b04b',
    patienceMult  : 1.5,
    budgetMult    : 1.2,
    speedMult     : 0.75,
    listSizeMult  : 1.3,
    priceThreshold: 1.5,
    queueTolerance: 5,
    spendPerItem  : 1.2,
  },
  BIG_SPENDER: {
    label         : 'Big Spender',
    color         : '#f7c59f',
    patienceMult  : 1.2,
    budgetMult    : 3.0,
    speedMult     : 1.0,
    listSizeMult  : 2.0,
    priceThreshold: 3.0,    // price-insensitive
    queueTolerance: 4,
    spendPerItem  : 2.5,
  },
  IMPATIENT: {
    label         : 'Impatient Customer',
    color         : '#e63946',
    patienceMult  : 0.4,
    budgetMult    : 1.0,
    speedMult     : 1.2,
    listSizeMult  : 0.8,
    priceThreshold: 1.3,
    queueTolerance: 1,
    spendPerItem  : 1.0,
  },
  BUDGET_SHOPPER: {
    label         : 'Budget Shopper',
    color         : '#457b9d',
    patienceMult  : 1.3,
    budgetMult    : 0.5,
    speedMult     : 0.9,
    listSizeMult  : 1.0,
    priceThreshold: 0.9,    // very price-sensitive
    queueTolerance: 3,
    spendPerItem  : 0.6,
  },
  THIEF: {
    label         : 'Thief',
    color         : '#2b2d42',
    patienceMult  : 1.0,
    budgetMult    : 0.0,    // pays nothing
    speedMult     : 1.1,
    listSizeMult  : 0.6,
    priceThreshold: 99,
    queueTolerance: 0,      // never queues; just walks out
    spendPerItem  : 0,
  },
};

const PERSONALITY_KEYS = Object.keys(PERSONALITIES);
const PRODUCT_CATEGORIES = ['basics', 'snacks', 'beverages', 'dairy', 'produce', 'frozen', 'meat'];

// ── Customer queue per checkout ───────────────────────────────────────────────
class CheckoutQueue {
  constructor(checkoutInstance) {
    this.checkout  = checkoutInstance;
    this.customers = [];   // ordered: [0] = being served
    this.serveTimer= 0;    // countdown for current customer
  }

  enqueue(customer) { this.customers.push(customer); }
  dequeue()         { return this.customers.shift(); }
  get length()      { return this.customers.length; }
  get isBusy()      { return this.customers.length > 0; }

  /** Tick the queue forward. Returns revenue if a customer finishes paying. */
  tick(delta, gameManager) {
    if (this.customers.length === 0) return 0;

    const current = this.customers[0];
    if (current.state !== C_STATE.PAYING) {
      current._setState(C_STATE.PAYING);
      // Service time depends on employee skill + item count
      const cashier     = gameManager.employeeSystem.getCashierAt(this.checkout);
      const skillBonus  = cashier ? cashier.skillLevel * 0.15 : 0;
      this.serveTimer   = Math.max(1, current.shoppingList.length * 1.5 * (1 - skillBonus));
    }

    this.serveTimer -= delta;
    if (this.serveTimer <= 0) {
      return this._completeTransaction(gameManager);
    }
    return 0;
  }

  _completeTransaction(gameManager) {
    const customer = this.dequeue();
    const revenue  = customer.calculateSpend();
    customer.satisfaction = Math.min(100, customer.satisfaction + 10);
    customer._setState(C_STATE.WALKING_TO_EXIT);
    gameManager.economySystem.recordSale(revenue, customer.personality.label);
    gameManager.awardReputation(0.5 + customer.satisfaction * 0.02, 'happy_customer');
    return revenue;
  }
}

// ── Customer agent ────────────────────────────────────────────────────────────
class Customer {
  constructor(id, startX, startY, gameManager) {
    this.id          = id;
    this.gameManager = gameManager;

    // Position (world-space, sub-tile precision)
    this.x = startX;
    this.y = startY;

    // Personality
    const pKey       = this._pickPersonality();
    this.personalityKey = pKey;
    this.personality = PERSONALITIES[pKey];

    // Stats
    const basePat     = 30 + Math.random() * 40; // 30–70 seconds of patience
    const diffMult    = gameManager.diffCfg.patienceMult;
    this.maxPatience  = basePat * this.personality.patienceMult * diffMult;
    this.patience     = this.maxPatience;
    this.satisfaction = 70 + Math.random() * 30;  // 70–100 start
    this.budget       = (20 + Math.random() * 80) * this.personality.budgetMult;
    this.spent        = 0;

    // Shopping list: random items from available categories
    this.shoppingList     = this._generateShoppingList();
    this.pendingItems     = [...this.shoppingList];
    this.cartItems        = [];

    // State machine
    this.state        = C_STATE.ENTERING;
    this.stateTimer   = 0;   // general-purpose timer for current state

    // Pathfinding
    this.currentPath  = [];
    this.pathIndex    = 0;
    this.moveSpeed    = (1.5 + Math.random() * 0.5) * this.personality.speedMult; // tiles/sec
    this.targetShelf  = null;
    this.targetCheckout = null;

    // Flags
    this.isAngry      = false;
    this.hasStolen    = false;
    this.markedForRemoval = false;
  }

  // ── Personality selection (weighted; thieves are rare) ────────────────────
  _pickPersonality() {
    const weights = {
      SPEED_SHOPPER : 20,
      CASUAL_BROWSER: 30,
      BIG_SPENDER   : 15,
      IMPATIENT     : 20,
      BUDGET_SHOPPER: 13,
      THIEF         :  2, // rare
    };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r       = Math.random() * total;
    for (const [key, w] of Object.entries(weights)) {
      r -= w;
      if (r <= 0) return key;
    }
    return 'CASUAL_BROWSER';
  }

  // ── Random shopping list generation ──────────────────────────────────────
  _generateShoppingList() {
    const level      = this.gameManager.currentLevel;
    const available  = level.categories.includes('all')
      ? PRODUCT_CATEGORIES
      : level.categories;

    const count = Math.max(1, Math.round(
      (2 + Math.random() * 4) * this.personality.listSizeMult
    ));
    const list  = [];
    for (let i = 0; i < count; i++) {
      const cat = available[Math.floor(Math.random() * available.length)];
      list.push({ category: cat, found: false, price: 0 });
    }
    return list;
  }

  // ── State transition ──────────────────────────────────────────────────────
  _setState(newState) {
    this.state      = newState;
    this.stateTimer = 0;
    this.currentPath = [];
    this.pathIndex  = 0;
  }

  // ── Main update tick ──────────────────────────────────────────────────────
  tick(delta, storeBuilder, customerAI) {
    this.stateTimer += delta;

    // Drain patience while inside
    if (this.state !== C_STATE.EXITING && this.state !== C_STATE.LEAVING_ANGRY) {
      this.patience -= delta;
      if (this.patience <= 0) {
        this._leaveAngry('patience_exhausted');
        return;
      }
    }

    switch (this.state) {
      case C_STATE.ENTERING:           this._tickEntering(delta, storeBuilder); break;
      case C_STATE.BROWSING:           this._tickBrowsing(delta, storeBuilder); break;
      case C_STATE.WALKING_TO_SHELF:   this._tickWalking(delta, storeBuilder, C_STATE.PICKING_ITEM); break;
      case C_STATE.PICKING_ITEM:       this._tickPickingItem(delta); break;
      case C_STATE.WALKING_TO_CHECKOUT:this._tickWalking(delta, storeBuilder, C_STATE.QUEUEING); break;
      case C_STATE.QUEUEING:           this._tickQueueing(delta, customerAI); break;
      case C_STATE.PAYING:             /* handled by CheckoutQueue */  break;
      case C_STATE.WALKING_TO_EXIT:    this._tickWalking(delta, storeBuilder, C_STATE.EXITING); break;
      case C_STATE.LEAVING_ANGRY:      this._tickLeavingAngry(delta, storeBuilder); break;
      case C_STATE.STEALING:           this._tickStealing(delta); break;
    }
  }

  // ── State: ENTERING ───────────────────────────────────────────────────────
  _tickEntering(delta, sb) {
    // Walk to a random floor tile near the centre
    if (this.currentPath.length === 0) {
      const dest = this._findStartBrowsePoint(sb);
      if (dest) this._requestPath(sb, dest.x, dest.y);
      else       this._setState(C_STATE.BROWSING); // no path, just start
    }
    this._followPath(delta, sb);
    if (this._reachedPathEnd()) this._setState(C_STATE.BROWSING);
  }

  // ── State: BROWSING ───────────────────────────────────────────────────────
  _tickBrowsing(delta, sb) {
    if (this.pendingItems.length === 0) {
      // All items collected (or given up on) → head to checkout or exit
      if (this.cartItems.length > 0) {
        this._findAndTargetCheckout(sb);
      } else {
        // Nothing in cart – just leave
        this._requestPath(sb, sb.getExitPosition().x, sb.getExitPosition().y);
        this._setState(C_STATE.WALKING_TO_EXIT);
      }
      return;
    }

    // Special: Thief skips checkout
    if (this.personalityKey === 'THIEF' && this.cartItems.length > 0) {
      if (Math.random() < 0.3) {
        this._setState(C_STATE.STEALING);
        return;
      }
    }

    // Pick next item from list
    const item    = this.pendingItems[0];
    const shelf   = sb.findShelfForCategory(item.category);

    if (!shelf) {
      // Product not in store → reduce satisfaction
      item.found  = false;
      this.satisfaction -= 10;
      this.pendingItems.shift();
      this.gameManager.awardReputation(-0.3, 'missing_product');
      return;
    }

    // Navigate to the tile adjacent to the shelf
    const target = this._getAccessPoint(shelf, sb);
    if (!target) {
      // Shelf inaccessible → unhappy
      this.satisfaction -= 5;
      this.pendingItems.shift();
      return;
    }

    this.targetShelf = shelf;
    this._requestPath(sb, target.x, target.y);
    this._setState(C_STATE.WALKING_TO_SHELF);
  }

  // ── State: WALKING (generic) ──────────────────────────────────────────────
  _tickWalking(delta, sb, nextState) {
    this._followPath(delta, sb);

    if (this._reachedPathEnd()) {
      this._setState(nextState);
    }

    // If path is empty and we didn't ask for one yet, try again
    if (this.currentPath.length === 0 && this.stateTimer > 3) {
      // Stuck for 3 sec → leave angry
      this._leaveAngry('navigation_stuck');
    }
  }

  // ── State: PICKING_ITEM ───────────────────────────────────────────────────
  _tickPickingItem(delta) {
    if (this.stateTimer < 1.0) return; // animation delay

    const item  = this.pendingItems.shift();
    const shelf = this.targetShelf;

    if (shelf && shelf.stock > 0) {
      // Check budget
      const price = this.gameManager.economySystem.getPrice(item.category);
      if (price <= this.budget * this.personality.priceThreshold) {
        shelf.stock--;
        item.found  = true;
        item.price  = price;
        this.cartItems.push(item);
        this.spent += price;
        this.satisfaction += 3;
      } else {
        // Too expensive
        this.satisfaction -= 5;
        this.gameManager.awardReputation(-0.1, 'price_too_high');
      }
    } else {
      // Shelf empty
      this.satisfaction -= 8;
      this.gameManager.awardReputation(-0.2, 'empty_shelf');
    }

    this.targetShelf = null;
    this._setState(C_STATE.BROWSING);
  }

  // ── State: QUEUEING ───────────────────────────────────────────────────────
  _tickQueueing(delta, customerAI) {
    if (!this.targetCheckout) { this._leaveAngry('no_checkout'); return; }

    const queue = customerAI.getQueueFor(this.targetCheckout);
    if (!queue) { this._leaveAngry('no_queue'); return; }

    // Check queue patience
    if (queue.length > this.personality.queueTolerance) {
      this._leaveAngry('queue_too_long');
      return;
    }

    // Enqueue once
    if (!this._enqueuedAt) {
      queue.enqueue(this);
      this._enqueuedAt = this.targetCheckout.id;
    }
    // Payment transition handled by CheckoutQueue.tick()
  }

  // ── State: STEALING ──────────────────────────────────────────────────────
  _tickStealing(delta) {
    if (this.stateTimer < 2) return; // 2-sec "pocket" animation

    const sb      = this.gameManager.storeBuilder;
    const secured = sb._cell(Math.round(this.x), Math.round(this.y))?.secured;
    const caught  = secured && Math.random() < 0.8; // 80% catch if camera nearby

    if (caught) {
      this.gameManager.awardReputation(-5, 'theft_caught');
      this.gameManager.stats.theftIncidents++;
      this._leaveAngry('caught_stealing');
    } else {
      // Successful theft
      this.hasStolen = true;
      this.gameManager.stats.theftIncidents++;
      this.gameManager.awardReputation(-2, 'theft_undetected');
      this._requestPath(sb, sb.getExitPosition().x, sb.getExitPosition().y);
      this._setState(C_STATE.WALKING_TO_EXIT);
    }
  }

  // ── State: LEAVING_ANGRY ─────────────────────────────────────────────────
  _tickLeavingAngry(delta, sb) {
    if (this.currentPath.length === 0) {
      const exit = sb.getExitPosition();
      if (exit) this._requestPath(sb, exit.x, exit.y);
    }
    this._followPath(delta, sb);
    if (this._reachedPathEnd()) {
      this.markedForRemoval = true;
    }
  }

  // ── Path helpers ─────────────────────────────────────────────────────────
  _requestPath(sb, tx, ty) {
    const path = sb.findPath(Math.round(this.x), Math.round(this.y), tx, ty);
    if (path && path.length > 0) {
      this.currentPath = path;
      this.pathIndex   = 0;
    }
  }

  _followPath(delta, sb) {
    if (this.pathIndex >= this.currentPath.length) return;

    const target = this.currentPath[this.pathIndex];
    const dx     = target.x - this.x;
    const dy     = target.y - this.y;
    const dist   = Math.sqrt(dx * dx + dy * dy);
    const step   = this.moveSpeed * delta;

    // Random dirt chance while walking
    if (Math.random() < 0.002) sb.markDirty(Math.round(this.x), Math.round(this.y));

    if (dist <= step) {
      this.x = target.x;
      this.y = target.y;
      this.pathIndex++;
    } else {
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    }
  }

  _reachedPathEnd() {
    return this.pathIndex >= this.currentPath.length && this.currentPath.length > 0;
  }

  // ── Checkout targeting ────────────────────────────────────────────────────
  _findAndTargetCheckout(sb) {
    if (sb.checkoutTiles.length === 0) {
      // No checkout → leave
      this._requestPath(sb, sb.getExitPosition().x, sb.getExitPosition().y);
      this._setState(C_STATE.WALKING_TO_EXIT);
      return;
    }

    // Pick checkout with shortest queue
    const checkouts = sb.checkoutTiles;
    let best = checkouts[0];
    // (real queue length comparison done in CustomerAI where queues live)

    this.targetCheckout = best.instance;
    const qPos = sb.getCheckoutQueuePos(best.instance);
    this._requestPath(sb, qPos.x, qPos.y);
    this._setState(C_STATE.WALKING_TO_CHECKOUT);
  }

  // ── Find an accessible tile adjacent to a shelf ───────────────────────────
  _getAccessPoint(shelf, sb) {
    // Try tiles below, above, left, right of the shelf footprint
    const candidates = [];
    for (let dx = -1; dx <= shelf.w; dx++) {
      candidates.push({ x: shelf.x + dx, y: shelf.y - 1 });
      candidates.push({ x: shelf.x + dx, y: shelf.y + shelf.h });
    }
    return candidates.find(p => sb.isWalkable(p.x, p.y)) ?? null;
  }

  // ── Find a starting browse tile ──────────────────────────────────────────
  _findStartBrowsePoint(sb) {
    // Pick a random path tile
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = Math.floor(Math.random() * sb.cols);
      const y = Math.floor(Math.random() * sb.rows);
      if (sb.isWalkable(x, y)) return { x, y };
    }
    return null;
  }

  // ── Leave angry helper ────────────────────────────────────────────────────
  _leaveAngry(reason) {
    this.isAngry    = true;
    this.satisfaction = Math.max(0, this.satisfaction - 20);
    this._setState(C_STATE.LEAVING_ANGRY);
    this.gameManager.awardReputation(-1.5, `angry_${reason}`);
    this.gameManager.stats.averageSatisfaction =
      (this.gameManager.stats.averageSatisfaction * 0.95 + this.satisfaction * 0.05);
  }

  // ── Revenue calculation ───────────────────────────────────────────────────
  calculateSpend() {
    return this.cartItems.reduce((sum, item) => sum + (item.price ?? 0), 0);
  }

  // ── Rendering data ────────────────────────────────────────────────────────
  getRenderData() {
    return {
      id          : this.id,
      x           : this.x,
      y           : this.y,
      state       : this.state,
      color       : this.personality.color,
      isAngry     : this.isAngry,
      satisfaction: this.satisfaction,
      patience    : this.patience / this.maxPatience,
      label       : this.personality.label,
    };
  }
}

// =============================================================================
// CustomerAI — manages all customer agents and checkout queues
// =============================================================================

class CustomerAI {
  constructor(gameManager) {
    this.gameManager    = gameManager;
    this.activeCustomers = [];
    this.queues          = new Map();   // checkout.id → CheckoutQueue
    this._nextId         = 1;
  }

  init() {
    this.activeCustomers = [];
    this.queues.clear();
    this._buildQueues();
  }

  _buildQueues() {
    const sb = this.gameManager.storeBuilder;
    sb.checkoutTiles.forEach(ct => {
      this.queues.set(ct.instance.id, new CheckoutQueue(ct.instance));
    });
  }

  // ── Spawn a new customer ─────────────────────────────────────────────────
  spawnCustomer(pos) {
    const id       = `cust_${this._nextId++}`;
    const customer = new Customer(id, pos.x, pos.y, this.gameManager);
    this.activeCustomers.push(customer);
    return customer;
  }

  // ── Main tick ────────────────────────────────────────────────────────────
  tick(delta) {
    const sb = this.gameManager.storeBuilder;

    // Tick each customer
    this.activeCustomers.forEach(c => c.tick(delta, sb, this));

    // Tick checkout queues
    this.queues.forEach(q => q.tick(delta, this.gameManager));

    // Remove exited or marked customers
    this.activeCustomers = this.activeCustomers.filter(c => {
      if (c.state === C_STATE.EXITING || c.markedForRemoval) {
        this._onCustomerLeave(c);
        return false;
      }
      return true;
    });
  }

  _onCustomerLeave(customer) {
    // Update global satisfaction average
    const gm = this.gameManager;
    gm.stats.averageSatisfaction =
      (gm.stats.averageSatisfaction * 0.9 + customer.satisfaction * 0.1);

    // Remove from any queue they were in
    this.queues.forEach(q => {
      q.customers = q.customers.filter(c => c.id !== customer.id);
    });
  }

  // ── Queue accessors ───────────────────────────────────────────────────────
  getQueueFor(checkoutInstance) {
    return this.queues.get(checkoutInstance.id) ?? null;
  }

  getShortestQueue() {
    let best = null, bestLen = Infinity;
    this.queues.forEach(q => {
      if (q.length < bestLen) { best = q; bestLen = q.length; }
    });
    return best;
  }

  // ── Rebuild queues when new checkouts are placed ──────────────────────────
  onCheckoutAdded(checkoutInstance) {
    this.queues.set(checkoutInstance.id, new CheckoutQueue(checkoutInstance));
  }

  // ── Render data ───────────────────────────────────────────────────────────
  getRenderData() {
    return this.activeCustomers.map(c => c.getRenderData());
  }

  serialize()        { return {}; }  // customers are ephemeral
  deserialize(_data) { this.init(); }
}
