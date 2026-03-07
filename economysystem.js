// =============================================================================
// SCRIPT 5 — EconomySystem.js
// =============================================================================
// Full tycoon economy engine:
//   • Real-time money tracking
//   • Dynamic product pricing (supply/demand model)
//   • Daily expenses: salaries + electricity + restocking
//   • Revenue from sales with personality-driven spending
//   • Store upgrades unlocked by money + reputation
//   • Delivery truck supply chain
//   • Product popularity ratings per category
//   • Daily profit/loss reports
// =============================================================================

// ── Product categories and their base prices ───────────────────────────────
const PRODUCTS = {
  basics    : { basePrice:  2.50, restockCost: 1.00, label: 'Basic Goods'   },
  snacks    : { basePrice:  1.80, restockCost: 0.70, label: 'Snacks'        },
  beverages : { basePrice:  2.20, restockCost: 0.90, label: 'Beverages'     },
  dairy     : { basePrice:  3.00, restockCost: 1.30, label: 'Dairy'         },
  produce   : { basePrice:  2.80, restockCost: 1.10, label: 'Produce'       },
  frozen    : { basePrice:  4.50, restockCost: 2.00, label: 'Frozen Goods'  },
  meat      : { basePrice:  7.00, restockCost: 3.50, label: 'Meat'          },
};

// ── Upgrade definitions ─────────────────────────────────────────────────────
const UPGRADES = [
  { id:'storefront',    label:'Neon Storefront',  cost:500,   effect:'reputation+5',  applied:false },
  { id:'music',         label:'Background Music', cost:300,   effect:'patience+10%',  applied:false },
  { id:'ac',            label:'Air Conditioning', cost:800,   effect:'satisfaction+5',applied:false },
  { id:'big_storage',   label:'Big Storage Room', cost:1500,  effect:'stock_cap+50%', applied:false },
  { id:'security_sys',  label:'Security System',  cost:1200,  effect:'theft-80%',     applied:false },
  { id:'loyalty_card',  label:'Loyalty Card',     cost:600,   effect:'spend+15%',     applied:false },
  { id:'price_scanner', label:'Auto Price Scanner',cost:900,  effect:'efficiency+10%',applied:false },
  { id:'delivery_opt',  label:'Express Delivery', cost:2000,  effect:'restock_speed*2',applied:false},
];

// ── Delivery truck ──────────────────────────────────────────────────────────
class DeliveryTruck {
  constructor() {
    this.inTransit    = false;
    this.arrivalTime  = 0;       // game-time minutes when it arrives
    this.cargo        = {};      // { category: amount }
    this.cost         = 0;
  }

  dispatch(cargo, currentGameTime, transitMinutes, cost) {
    this.inTransit   = true;
    this.cargo       = cargo;
    this.arrivalTime = currentGameTime + transitMinutes;
    this.cost        = cost;
    console.log(`[DeliveryTruck] Dispatched. Arrives in ${transitMinutes} game-minutes.`);
  }

  checkArrival(currentGameTime) {
    if (this.inTransit && currentGameTime >= this.arrivalTime) {
      this.inTransit = false;
      const cargo    = this.cargo;
      this.cargo     = {};
      return cargo;   // caller handles restocking
    }
    return null;
  }
}

// =============================================================================
// EconomySystem
// =============================================================================

class EconomySystem {
  constructor(gameManager) {
    this.gameManager = gameManager;

    // ── Money ────────────────────────────────────────────────────────────────
    this.money       = 5000;
    this.totalEarned = 0;
    this.totalSpent  = 0;

    // ── Daily ledger ─────────────────────────────────────────────────────────
    this.dailyRevenue  = 0;
    this.dailyExpenses = 0;
    this.dailyHistory  = [];   // [{ day, revenue, expenses, profit }]

    // ── Product prices (start at base, drift with demand) ─────────────────
    this.prices      = {};     // category → current price
    this.demand      = {};     // category → units sold today
    this.popularity  = {};     // category → 0-100 score

    // ── Electricity cost (per real-second of game time) ───────────────────
    this.electricityRate = 50; // per game-day

    // ── Upgrades ─────────────────────────────────────────────────────────────
    this.upgrades    = UPGRADES.map(u => ({ ...u }));

    // ── Delivery truck fleet ─────────────────────────────────────────────────
    this.trucks      = [new DeliveryTruck()];

    // ── Player price overrides (from UI) ─────────────────────────────────────
    this.priceMultipliers = {};  // category → multiplier (default 1.0)

    // ── Transaction log ───────────────────────────────────────────────────────
    this.transactionLog = [];
  }

  // ── Initialise ────────────────────────────────────────────────────────────
  init() {
    Object.keys(PRODUCTS).forEach(cat => {
      this.prices[cat]          = PRODUCTS[cat].basePrice;
      this.demand[cat]          = 0;
      this.popularity[cat]      = 50;
      this.priceMultipliers[cat] = 1.0;
    });
    console.log('[EconomySystem] Initialised.');
  }

  // ── Main tick: update prices dynamically ─────────────────────────────────
  tick(delta) {
    this._updateDynamicPrices(delta);
    this._checkTruckArrivals();
  }

  // ── Dynamic pricing: demand raises price, oversupply lowers it ────────────
  _updateDynamicPrices(delta) {
    const interval = 60; // re-price every 60 real-seconds
    if (!this._priceTimer) this._priceTimer = 0;
    this._priceTimer += delta;
    if (this._priceTimer < interval) return;
    this._priceTimer = 0;

    Object.keys(PRODUCTS).forEach(cat => {
      const pop        = this.popularity[cat];
      const demandMult = 0.8 + (pop / 100) * 0.4;     // 0.8x – 1.2x
      const repMult    = 0.9 + (this.gameManager.reputation / 100) * 0.2;
      const playerMult = this.priceMultipliers[cat];

      this.prices[cat] = PRODUCTS[cat].basePrice * demandMult * repMult * playerMult;

      // Decay demand daily so old data doesn't linger
      this.demand[cat] = Math.max(0, this.demand[cat] - 1);
    });
  }

  // ── Spend money (returns false if insufficient) ───────────────────────────
  spend(amount, reason = 'misc') {
    if (amount > this.money) return false;
    this.money         -= amount;
    this.totalSpent    += amount;
    this.dailyExpenses += amount;
    this._logTransaction(-amount, reason);
    return true;
  }

  // ── Earn money ────────────────────────────────────────────────────────────
  earn(amount, reason = 'misc') {
    this.money        += amount;
    this.totalEarned  += amount;
    this.dailyRevenue += amount;
    this._logTransaction(amount, reason);
  }

  // ── Record a sale (called by CustomerAI / CheckoutQueue) ─────────────────
  recordSale(amount, personalityLabel) {
    this.earn(amount, `sale_${personalityLabel}`);

    // Update popularity for sold categories
    // (simplified: we don't track per-item, so bump all proportionally)
    Object.keys(this.demand).forEach(cat => {
      this.demand[cat]     += amount / Object.keys(this.demand).length;
      this.popularity[cat] = Math.min(100, this.popularity[cat] + 0.5);
    });
  }

  // ── End-of-day expenses ───────────────────────────────────────────────────
  processDailyExpenses() {
    const gm = this.gameManager;

    // 1) Employee salaries
    const salaryTotal = gm.employeeSystem.getDailySalaryTotal();
    this.spend(salaryTotal, 'salaries');

    // 2) Electricity
    const elecCost = this.electricityRate * gm.diffCfg.costMult;
    this.spend(elecCost, 'electricity');

    // 3) Automatic restocking cost for shelves that were used today
    const restockCost = this._calculateRestockCost();
    this.spend(restockCost, 'auto_restock');

    // 4) Record daily summary
    const profit = this.dailyRevenue - this.dailyExpenses;
    this.dailyHistory.push({
      day      : gm.currentDay - 1,
      revenue  : this.dailyRevenue,
      expenses : this.dailyExpenses,
      profit   : profit,
    });

    // Reputation bonus for profitable day
    if (profit > 0) gm.awardReputation(1, 'profitable_day');
    if (profit < -500) gm.awardReputation(-2, 'major_loss');

    console.log(`[EconomySystem] Day ${gm.currentDay - 1} summary: `
      + `Rev $${this.dailyRevenue.toFixed(0)}, `
      + `Exp $${this.dailyExpenses.toFixed(0)}, `
      + `Profit $${profit.toFixed(0)}`);

    // Reset daily counters
    this.dailyRevenue  = 0;
    this.dailyExpenses = 0;

    // Game-over if bankrupt
    if (this.money <= 0) {
      gm.state = 'GAME_OVER';
      gm.emit('gameOver', { reason: 'bankrupt' });
    }
  }

  _calculateRestockCost() {
    const sb = this.gameManager.storeBuilder;
    let cost = 0;
    sb.shelves.forEach(shelf => {
      if (shelf.category) {
        const deficit = shelf.maxStock - shelf.stock;
        cost += deficit * (PRODUCTS[shelf.category]?.restockCost ?? 1);
      }
    });
    return cost * 0.3; // only charge 30% (rest comes from owned inventory)
  }

  // ── Player sets price multiplier for a category ───────────────────────────
  setPlayerPrice(category, multiplier) {
    if (!PRODUCTS[category]) return;
    // Clamp: 0.5x – 3x
    this.priceMultipliers[category] = Math.max(0.5, Math.min(3.0, multiplier));
  }

  // ── Get current shelf price ────────────────────────────────────────────────
  getPrice(category) {
    return this.prices[category] ?? PRODUCTS[category]?.basePrice ?? 2.0;
  }

  // ── Order a delivery truck ────────────────────────────────────────────────
  orderDelivery(cargoList) {
    // cargoList = [{ category, amount }]
    const freeTruck = this.trucks.find(t => !t.inTransit);
    if (!freeTruck) {
      console.warn('[EconomySystem] No truck available.');
      return false;
    }

    const cargo     = {};
    let   totalCost = 0;
    cargoList.forEach(({ category, amount }) => {
      if (PRODUCTS[category]) {
        cargo[category]  = (cargo[category] ?? 0) + amount;
        totalCost       += amount * PRODUCTS[category].restockCost;
      }
    });

    // Delivery fee
    const hasExpressUpgrade = this.upgrades.find(u => u.id === 'delivery_opt')?.applied;
    const transitMins       = hasExpressUpgrade ? 5 : 15;
    totalCost              *= 1.1; // 10% delivery markup

    if (!this.spend(totalCost, 'delivery_order')) {
      console.warn('[EconomySystem] Not enough money for delivery.');
      return false;
    }

    freeTruck.dispatch(cargo, this.gameManager.gameTime, transitMins, totalCost);
    this.gameManager.emit('deliveryOrdered', { cargo, cost: totalCost, eta: transitMins });
    return true;
  }

  // ── Check if any truck has arrived ────────────────────────────────────────
  _checkTruckArrivals() {
    const gm = this.gameManager;
    this.trucks.forEach(truck => {
      const cargo = truck.checkArrival(gm.gameTime);
      if (!cargo) return;

      // Restock shelves
      const sb = gm.storeBuilder;
      Object.entries(cargo).forEach(([category, amount]) => {
        let remaining = amount;
        sb.shelves.forEach(shelf => {
          if (remaining <= 0) return;
          if (shelf.category === category || !shelf.category) {
            const space    = shelf.maxStock - shelf.stock;
            const toAdd    = Math.min(space, remaining);
            shelf.stock   += toAdd;
            shelf.category = category;
            remaining     -= toAdd;
          }
        });
      });

      gm.emit('deliveryArrived', { cargo });
      gm.awardReputation(0.5, 'delivery_received');
      console.log('[EconomySystem] Delivery arrived!', cargo);
    });
  }

  // ── Purchase an upgrade ────────────────────────────────────────────────────
  buyUpgrade(upgradeId) {
    const upgrade = this.upgrades.find(u => u.id === upgradeId);
    if (!upgrade) return false;
    if (upgrade.applied) return false;
    if (!this.spend(upgrade.cost, `upgrade_${upgradeId}`)) return false;

    upgrade.applied = true;
    this._applyUpgradeEffect(upgrade);
    this.gameManager.emit('upgradeApplied', { upgrade });
    console.log(`[EconomySystem] Upgrade applied: ${upgrade.label}`);
    return true;
  }

  _applyUpgradeEffect(upgrade) {
    const gm = this.gameManager;
    switch (upgrade.id) {
      case 'storefront':   gm.awardReputation(5, 'upgrade_storefront'); break;
      case 'ac':           gm.awardReputation(3, 'upgrade_ac'); break;
      case 'loyalty_card': // Spend multiplier baked into customer AI via economy
        Object.keys(this.priceMultipliers).forEach(k => {
          this.priceMultipliers[k] *= 1.15;
        });
        break;
      // Other effects interpreted by their respective systems
    }
  }

  // ── Summary helpers ────────────────────────────────────────────────────────
  getFinancialSummary() {
    const lastDay = this.dailyHistory[this.dailyHistory.length - 1];
    return {
      money       : this.money,
      totalEarned : this.totalEarned,
      totalSpent  : this.totalSpent,
      lastDayProfit: lastDay?.profit ?? 0,
      lastDayRevenue: lastDay?.revenue ?? 0,
      dailyHistory: this.dailyHistory.slice(-7),  // last 7 days
    };
  }

  // ── Transaction log ───────────────────────────────────────────────────────
  _logTransaction(amount, reason) {
    this.transactionLog.push({
      amount,
      reason,
      time : this.gameManager.gameTime,
      day  : this.gameManager.currentDay,
    });
    if (this.transactionLog.length > 500) this.transactionLog.shift();
  }

  // ── Serialization ─────────────────────────────────────────────────────────
  serialize() {
    return {
      money         : this.money,
      totalEarned   : this.totalEarned,
      totalSpent    : this.totalSpent,
      prices        : this.prices,
      popularity    : this.popularity,
      priceMultipliers: this.priceMultipliers,
      upgrades      : this.upgrades,
      dailyHistory  : this.dailyHistory,
    };
  }

  deserialize(data) {
    Object.assign(this, data);
  }
}
