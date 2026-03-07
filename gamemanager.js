// =============================================================================
// SCRIPT 1 — GameManager.js
// =============================================================================
// Central game controller. Initializes all systems, manages the day/night
// cycle, spawns customers, tracks reputation & store level, and drives the
// main game-loop tick that every other system hooks into.
// =============================================================================

class GameManager {
  constructor() {
    // ── Core references (injected after construction) ──────────────────────
    this.storeBuilder   = null;
    this.customerAI     = null;
    this.employeeSystem = null;
    this.economySystem  = null;
    this.renderer       = null;   // canvas/UI renderer reference

    // ── Game state ──────────────────────────────────────────────────────────
    this.state      = 'MENU';   // MENU | PLAYING | PAUSED | BUILD_MODE | GAME_OVER
    this.difficulty = 'NORMAL'; // EASY | NORMAL | HARD

    // ── Time system ─────────────────────────────────────────────────────────
    this.gameTime        = 6 * 60;   // minutes since midnight (starts 06:00)
    this.dayDuration     = 900;      // real-seconds per full in-game day
    this.timeScale       = (24 * 60) / 900; // in-game minutes per real-second
    this.currentDay      = 1;
    this.isStoreOpen     = false;
    this.lastTickTime    = 0;

    // ── Reputation ──────────────────────────────────────────────────────────
    this.reputation      = 50;     // 0–100
    this.reputationLog   = [];     // { delta, source, time }

    // ── Store level ─────────────────────────────────────────────────────────
    this.storeLevelIndex = 0;
    this.storeLevels     = [
      { level:1, name:'Corner Shop',  minRep:0,  maxEmp:4,  categories:['basics','snacks'],                          zones:1 },
      { level:2, name:'Mini Market',  minRep:20, maxEmp:8,  categories:['basics','snacks','beverages','dairy'],       zones:2 },
      { level:3, name:'Supermarket',  minRep:50, maxEmp:16, categories:['basics','snacks','beverages','dairy',
                                                                         'produce','frozen','meat'],                   zones:4 },
      { level:4, name:'Mega Store',   minRep:85, maxEmp:30, categories:['all'],                                       zones:8 },
    ];

    // ── Customer spawning ────────────────────────────────────────────────────
    this.spawnCooldown   = 0;     // seconds until next spawn attempt
    this.totalCustomersToday = 0;

    // ── Difficulty config ────────────────────────────────────────────────────
    this.difficultyConfig = {
      EASY:   { patienceMult: 1.5, spawnMult: 0.7, costMult: 0.8, theftMult: 0.5 },
      NORMAL: { patienceMult: 1.0, spawnMult: 1.0, costMult: 1.0, theftMult: 1.0 },
      HARD:   { patienceMult: 0.6, spawnMult: 1.4, costMult: 1.3, theftMult: 1.8 },
    };

    // ── Event bus ───────────────────────────────────────────────────────────
    this._listeners = {};

    // ── Statistics ───────────────────────────────────────────────────────────
    this.stats = {
      totalRevenue    : 0,
      totalCustomers  : 0,
      averageSatisfaction: 100,
      daysPlayed      : 0,
      theftIncidents  : 0,
    };
  }

  // ── System injection ───────────────────────────────────────────────────────
  injectSystems({ storeBuilder, customerAI, employeeSystem, economySystem, renderer }) {
    this.storeBuilder   = storeBuilder;
    this.customerAI     = customerAI;
    this.employeeSystem = employeeSystem;
    this.economySystem  = economySystem;
    this.renderer       = renderer;
    console.log('[GameManager] All systems injected.');
  }

  // ── Start a new game ───────────────────────────────────────────────────────
  startGame(difficulty = 'NORMAL') {
    this.difficulty  = difficulty;
    this.state       = 'PLAYING';
    this.gameTime    = 6 * 60;
    this.currentDay  = 1;
    this.reputation  = 50;
    this.isStoreOpen = false;
    this.lastTickTime = performance.now();

    // Initialize sub-systems
    this.storeBuilder.init();
    this.economySystem.init();
    this.employeeSystem.init();
    this.customerAI.init();

    this.emit('gameStarted', { difficulty });
    console.log(`[GameManager] Game started — difficulty: ${difficulty}`);
    requestAnimationFrame(ts => this._loop(ts));
  }

  // ── Main game loop (called every animation frame) ──────────────────────────
  _loop(timestamp) {
    if (this.state === 'GAME_OVER') return;

    const realDelta = (timestamp - this.lastTickTime) / 1000; // seconds
    this.lastTickTime = timestamp;

    if (this.state === 'PLAYING') {
      this._advanceTime(realDelta);
      this._tickSystems(realDelta);
      this._handleCustomerSpawning(realDelta);
      this._checkStoreProgression();
    }

    if (this.renderer) this.renderer.render(realDelta);

    requestAnimationFrame(ts => this._loop(ts));
  }

  // ── Advance in-game clock ──────────────────────────────────────────────────
  _advanceTime(delta) {
    const prevMinutes   = this.gameTime;
    this.gameTime      += delta * this.timeScale;

    // Midnight wrap → new day
    if (this.gameTime >= 24 * 60) {
      this.gameTime -= 24 * 60;
      this._onNewDay();
    }

    // Store opens at 08:00, closes at 21:00
    const wasOpen = this.isStoreOpen;
    this.isStoreOpen = this.gameTime >= 8 * 60 && this.gameTime < 21 * 60;

    if (!wasOpen && this.isStoreOpen)  this.emit('storeOpened',  { day: this.currentDay });
    if ( wasOpen && !this.isStoreOpen) this.emit('storeClosed',  { day: this.currentDay });
  }

  // ── End of day processing ──────────────────────────────────────────────────
  _onNewDay() {
    this.currentDay++;
    this.totalCustomersToday = 0;
    this.stats.daysPlayed++;

    // Pay salaries and operating costs at end of day
    this.economySystem.processDailyExpenses();

    // Decay reputation slightly each day (keeps the player engaged)
    this._applyReputation(-1, 'daily_decay');

    this.emit('newDay', { day: this.currentDay });
    console.log(`[GameManager] ── Day ${this.currentDay} begins ──`);
  }

  // ── Tick all sub-systems ───────────────────────────────────────────────────
  _tickSystems(delta) {
    this.customerAI.tick(delta);
    this.employeeSystem.tick(delta);
    this.economySystem.tick(delta);
  }

  // ── Customer spawning logic ────────────────────────────────────────────────
  _handleCustomerSpawning(delta) {
    if (!this.isStoreOpen) return;

    this.spawnCooldown -= delta;
    if (this.spawnCooldown > 0) return;

    const spawnRate = this._calculateSpawnRate();
    this.spawnCooldown = spawnRate;

    // Respect a max simultaneous customer cap
    const maxCustomers = 5 + this.storeLevelIndex * 4;
    if (this.customerAI.activeCustomers.length < maxCustomers) {
      this.customerAI.spawnCustomer(this._getEntryPoint());
      this.totalCustomersToday++;
      this.stats.totalCustomers++;
    }
  }

  // ── Spawn interval based on time-of-day and difficulty ────────────────────
  _calculateSpawnRate() {
    const cfg   = this.difficultyConfig[this.difficulty];
    const hour  = Math.floor(this.gameTime / 60);

    // Rush hours: 09-11 and 17-19
    const trafficMap = {
      6:5, 7:4, 8:3, 9:1.5, 10:1.5, 11:2.5, 12:2,
      13:2, 14:2.5, 15:3, 16:2.5, 17:1.5, 18:1.5, 19:3, 20:4
    };
    const baseSecs = (trafficMap[hour] ?? 4) * cfg.spawnMult;

    // Level scaling: higher-level stores attract more customers
    return Math.max(0.8, baseSecs - this.storeLevelIndex * 0.2);
  }

  // ── Find the store entrance tile ──────────────────────────────────────────
  _getEntryPoint() {
    return this.storeBuilder.getEntrancePosition() || { x: 1, y: 1 };
  }

  // ── Reputation management ──────────────────────────────────────────────────
  _applyReputation(delta, source) {
    const prev        = this.reputation;
    this.reputation   = Math.max(0, Math.min(100, this.reputation + delta));
    this.reputationLog.push({ delta, source, time: this.gameTime });

    // Keep log at reasonable size
    if (this.reputationLog.length > 200) this.reputationLog.shift();

    if (Math.floor(prev / 20) !== Math.floor(this.reputation / 20)) {
      // Crossed a tier boundary
      this.emit('reputationTierChanged', { reputation: this.reputation });
    }
    this.emit('reputationChanged', { prev, current: this.reputation, delta, source });
  }

  // Public method for other systems to award/penalise reputation
  awardReputation(delta, source) { this._applyReputation(delta, source); }

  // ── Store level-up checks ──────────────────────────────────────────────────
  _checkStoreProgression() {
    const nextIndex = this.storeLevelIndex + 1;
    if (nextIndex >= this.storeLevels.length) return;

    const nextLevel = this.storeLevels[nextIndex];
    if (this.reputation >= nextLevel.minRep) {
      this.storeLevelIndex = nextIndex;
      this.emit('storeLevelUp', { level: nextLevel });
      console.log(`[GameManager] Store levelled up → ${nextLevel.name}`);
    }
  }

  // ── Current store level helper ────────────────────────────────────────────
  get currentLevel() { return this.storeLevels[this.storeLevelIndex]; }

  get diffCfg() { return this.difficultyConfig[this.difficulty]; }

  // ── Clock helpers ─────────────────────────────────────────────────────────
  getTimeString() {
    const h = String(Math.floor(this.gameTime / 60)).padStart(2, '0');
    const m = String(Math.floor(this.gameTime % 60)).padStart(2, '0');
    return `${h}:${m}`;
  }

  isRushHour() {
    const h = Math.floor(this.gameTime / 60);
    return (h >= 9 && h < 11) || (h >= 17 && h < 19);
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────
  pause()  { if (this.state === 'PLAYING')  this.state = 'PAUSED';  this.emit('paused'); }
  resume() { if (this.state === 'PAUSED')   { this.state = 'PLAYING'; this.lastTickTime = performance.now(); this.emit('resumed'); } }
  toggleBuildMode() {
    if (this.state === 'PLAYING')    { this.state = 'BUILD_MODE'; this.emit('buildModeOn'); }
    else if (this.state === 'BUILD_MODE') { this.state = 'PLAYING';  this.emit('buildModeOff'); }
  }

  // ── Save / Load ───────────────────────────────────────────────────────────
  saveGame() {
    const saveData = {
      version      : '1.0',
      timestamp    : Date.now(),
      gameTime     : this.gameTime,
      currentDay   : this.currentDay,
      reputation   : this.reputation,
      storeLevelIndex: this.storeLevelIndex,
      difficulty   : this.difficulty,
      stats        : this.stats,
      economy      : this.economySystem.serialize(),
      grid         : this.storeBuilder.serialize(),
      employees    : this.employeeSystem.serialize(),
    };
    localStorage.setItem('supermarket_save', JSON.stringify(saveData));
    this.emit('gameSaved');
    console.log('[GameManager] Game saved.');
    return saveData;
  }

  loadGame() {
    const raw = localStorage.getItem('supermarket_save');
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      this.gameTime        = data.gameTime;
      this.currentDay      = data.currentDay;
      this.reputation      = data.reputation;
      this.storeLevelIndex = data.storeLevelIndex;
      this.difficulty      = data.difficulty;
      this.stats           = data.stats;
      this.economySystem.deserialize(data.economy);
      this.storeBuilder.deserialize(data.grid);
      this.employeeSystem.deserialize(data.employees);
      this.emit('gameLoaded', data);
      console.log('[GameManager] Game loaded.');
      return true;
    } catch (e) {
      console.error('[GameManager] Load failed:', e);
      return false;
    }
  }

  // ── Minimal event bus ─────────────────────────────────────────────────────
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }
  off(event, callback) {
    if (this._listeners[event])
      this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
  }
  emit(event, data = {}) {
    (this._listeners[event] || []).forEach(cb => cb(data));
  }
}
