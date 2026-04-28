'use strict';

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const COLS       = 24;
const ROWS       = 16;
const RIVER_COLS = 3;
const CELL       = 40;

const TILE  = { GRASS: 0, PATH: 1, RIVER: 2, BASE: 3 };
const TILE_NAMES = ['grass', 'path', 'river', 'base'];
const STATE = { IDLE: 'IDLE', WAVE_ACTIVE: 'WAVE_ACTIVE', WAVE_COMPLETE: 'WAVE_COMPLETE', WIN: 'WIN', LOSE: 'LOSE' };

// ─────────────────────────────────────────────
//  REGISTRY
// ─────────────────────────────────────────────
const Registry = {
  shooters:   {},
  generators: {},
  enemies:    {},
  waves:      [],
  river:      null,
  mapTiles:   { grass: [], path: [], river: [], base: [] },
};

// ─────────────────────────────────────────────
//  XML PARSER HELPERS
// ─────────────────────────────────────────────
function parseXML(text) { return new DOMParser().parseFromString(text, 'text/xml'); }
function tag(doc, name)    { const e = doc.querySelector(name); return e ? e.textContent.trim() : null; }
function tagNum(doc, name) { const v = tag(doc, name); return v !== null ? parseFloat(v) : null; }
function tagInt(doc, name) { const v = tag(doc, name); return v !== null ? parseInt(v, 10) : null; }

function parseLevelArray(doc, parentTag) {
  const parent = doc.querySelector(parentTag);
  if (!parent) return [];
  const out = [];
  let i = 1;
  while (true) {
    const el = parent.querySelector(`Level_${i}`);
    if (!el) break;
    out.push(parseFloat(el.textContent.trim()));
    i++;
  }
  return out;
}

function parseShooterDef(text) {
  const doc = parseXML(text);

  // Splash radius: 0 or absent = no splash
  const splashRadius  = tagNum(doc, 'Splash_Radius')  || 0;
  // Slow: factor 0–1 (0 = full stop, 1 = no slow). Absent = no slow.
  const slowFactor    = tagNum(doc, 'Slow_Factor');    // null if absent
  const slowDuration  = tagNum(doc, 'Slow_Duration')  || 0;

  return {
    type: 'shooter',
    name:                tag(doc, 'n'),
    image:               tag(doc, 'Image'),
    projectileImage:     tag(doc, 'Projectile_Image'),
    cost:                tagInt(doc, 'Cost'),
    baseDamage:          tagNum(doc, 'Base_Damage'),
    baseFireRate:        tagNum(doc, 'Base_Fire_Rate'),
    baseProjectileSpeed: tagNum(doc, 'Base_Projectile_Speed'),
    range:               tagNum(doc, 'Range'),
    upgradeCosts:        parseLevelArray(doc, 'Upgrade_Costs'),
    levelMultipliers:    parseLevelArray(doc, 'Level_Multipliers'),
    projectileHitRadius: tagInt(doc, 'Projectile_Hit_Radius'),
    // Splash & slow (optional)
    splashRadius,
    hasSplash:   splashRadius > 0,
    slowFactor:  slowFactor !== null ? slowFactor : null,   // null = no slow
    slowDuration,
    hasSlow:     slowFactor !== null && slowDuration > 0,
    description: tag(doc, 'Description'),
  };
}

function parseGeneratorDef(text) {
  const doc = parseXML(text);
  return {
    type: 'generator',
    name:             tag(doc, 'n'),
    image:            tag(doc, 'Image'),
    cost:             tagInt(doc, 'Cost'),
    baseIncome:       tagNum(doc, 'Base_Income'),
    upgradeCosts:     parseLevelArray(doc, 'Upgrade_Costs'),
    levelMultipliers: parseLevelArray(doc, 'Level_Multipliers'),
    description:      tag(doc, 'Description'),
  };
}

function parseEnemyDef(text) {
  const doc = parseXML(text);
  return {
    type: 'enemy',
    name:         tag(doc, 'n'),
    image:        tag(doc, 'Image'),
    maxHealth:    tagInt(doc, 'Max_Health'),
    speed:        tagNum(doc, 'Speed'),
    hitboxRadius: tagInt(doc, 'Hitbox_Radius'),
    reward:       tagInt(doc, 'Reward'),
    riverDamage:  tagInt(doc, 'River_Damage'),
    hpBarWidth:   tagInt(doc, 'Health_Bar_Width'),
    hpBarHeight:  tagInt(doc, 'Health_Bar_Height'),
    description:  tag(doc, 'Description'),
  };
}

function parseWaveDef(text) {
  const doc = parseXML(text);
  const groups = [];
  doc.querySelectorAll('Spawn_Group').forEach(g => {
    groups.push({
      enemyType: g.querySelector('Enemy_Type').textContent.trim(),
      count:     parseInt(g.querySelector('Count').textContent.trim(), 10),
    });
  });
  return { waveNumber: tagInt(doc, 'Wave_Number'), groups };
}

function parseRiverDef(text) {
  return { maxHealth: tagInt(parseXML(text), 'Max_Health') };
}

// ─────────────────────────────────────────────
//  IMAGE CACHE
// ─────────────────────────────────────────────
const ImgCache = {};
function loadImg(src) {
  if (ImgCache[src]) return ImgCache[src];
  const img = new Image(); img.src = src; ImgCache[src] = img; return img;
}

// ─────────────────────────────────────────────
//  MAP
// ─────────────────────────────────────────────
function buildMap() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(TILE.GRASS));

  for (let r = 0; r < ROWS; r++)
    for (let c = COLS - RIVER_COLS; c < COLS; c++)
      grid[r][c] = TILE.RIVER;

  const baseRow = Math.floor(ROWS / 2);
  grid[baseRow][0] = TILE.BASE;

  const waypoints = [
    [0,  baseRow],
    [3,  baseRow],
    [3,  3],
    [7,  3],
    [7,  8],
    [5,  8],
    [5,  12],
    [10, 12],
    [10, 6],
    [16, 6],
    [16, 11],
    [20, 11],
    // [20, 4],
    //[COLS - RIVER_COLS - 1, 4],
    //[COLS - RIVER_COLS - 1, baseRow],
    //[COLS - RIVER_COLS,     baseRow],
  ];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const [c0, r0] = waypoints[i];
    const [c1, r1] = waypoints[i + 1];
    if (c0 === c1) {
      const mn = Math.min(r0, r1), mx = Math.max(r0, r1);
      for (let r = mn; r <= mx; r++) if (grid[r][c0] === TILE.GRASS) grid[r][c0] = TILE.PATH;
    } else {
      const mn = Math.min(c0, c1), mx = Math.max(c0, c1);
      for (let c = mn; c <= mx; c++) if (grid[r0][c] === TILE.GRASS) grid[r0][c] = TILE.PATH;
    }
  }
  grid[baseRow][0] = TILE.BASE;

  return { grid, waypoints, baseRow };
}

// ─────────────────────────────────────────────
//  GAME STATE
// ─────────────────────────────────────────────
let G = {};

function initGame() {
  const { grid, waypoints, baseRow } = buildMap();
  const pixWP = waypoints.map(([c, r]) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 }));

  let totalLen = 0;
  const segLengths = [];
  for (let i = 0; i < pixWP.length - 1; i++) {
    const l = Math.hypot(pixWP[i+1].x - pixWP[i].x, pixWP[i+1].y - pixWP[i].y);
    segLengths.push(l); totalLen += l;
  }

  // Pre-assign image variants for each tile
  const tileImageIndices = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const tile = grid[r][c];
      const tileName = TILE_NAMES[tile];
      const imgs = Registry.mapTiles[tileName];
      const loadedImgs = (imgs || []).filter(i => i?.complete && i.naturalWidth > 0);
      const idx = loadedImgs.length > 0 ? Math.floor(Math.random() * loadedImgs.length) : -1;
      row.push(idx);
    }
    tileImageIndices.push(row);
  }

  G = {
    state:           STATE.IDLE,
    grid, waypoints: pixWP, segLengths, totalPathLen: totalLen, baseRow,
    riverMaxHP:      Registry.river.maxHealth,
    riverHP:         Registry.river.maxHealth,
    bank:            100,
    waveIndex:      -1,
    enemiesDefeated: 0,
    enemies:         [],
    projectiles:     [],
    placedTowers:    [],
    vfx:             [],   // splash/slow visual effects
    spawnQueue:      [],
    spawnTimer:      0,
    waveTotal:       0,
    waveGone:        0,
    incomeTimer:     0,
    placing:         null,
    hoverCell:       null,
    selectedTower:   null,
    tileImageIndices,
  };

  renderPalette();
  updateUI();
  closeInfoPanel();
  hideOverlay();
}

// ─────────────────────────────────────────────
//  PLACEMENT
// ─────────────────────────────────────────────
function isGrass(row, col) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return false;
  return G.grid[row][col] === TILE.GRASS;
}
function isCellOccupied(row, col) { return G.placedTowers.some(t => t.row === row && t.col === col); }
function canPlace(row, col)       { return isGrass(row, col) && !isCellOccupied(row, col); }

function placeTower(def, row, col) {
  const tower = {
    def, level: 1, row, col,
    x: col * CELL + CELL / 2,
    y: row * CELL + CELL / 2,
    cooldown: 0,
    img: def.image ? loadImg(`assets/${def.type}s/${def.image}`) : null,
    projectileImg: def.projectileImage ? loadImg(`assets/projectiles/${def.projectileImage}`) : null,
    maxHealth: def.maxHealth,
    currentHealth: def.Maxhealth,
  };
  computeTowerStats(tower);
  G.placedTowers.push(tower);
  G.bank -= def.cost;
  updateUI();
}

function computeTowerStats(tower) {
  const m = tower.def.levelMultipliers[tower.level - 1];
  if (tower.def.type === 'shooter') {
    tower.damage          = tower.def.baseDamage * m;
    tower.fireRate        = tower.def.baseFireRate * m;
    tower.projectileSpeed = tower.def.baseProjectileSpeed * m;
    tower.attackCooldown  = 1 / tower.fireRate;
    tower.range           = tower.def.range;
  } else {
    tower.income = tower.def.baseIncome * m;
  }
}

// ─────────────────────────────────────────────
//  WAVE SYSTEM
// ─────────────────────────────────────────────
function startNextWave() {
  if (G.state !== STATE.IDLE && G.state !== STATE.WAVE_COMPLETE) return;
  G.waveIndex++;
  if (G.waveIndex >= Registry.waves.length) { triggerWin(); return; }

  const waveDef = Registry.waves[G.waveIndex];
  const queue = [];
  waveDef.groups.forEach(grp => {
    const def = Registry.enemies[grp.enemyType];
    if (!def) { console.warn('Unknown enemy type:', grp.enemyType); return; }
    for (let i = 0; i < grp.count; i++) queue.push(def);
  });

  G.spawnQueue = queue;
  G.spawnTimer = 0;
  G.waveTotal  = queue.length;
  G.waveGone   = 0;
  G.state      = STATE.WAVE_ACTIVE;
  updateUI();
}

function spawnEnemy(def) {
  G.enemies.push({
    def,
    maxHealth:     def.maxHealth,
    currentHealth: def.maxHealth,
    baseSpeed:     def.speed,        // never modified — used to restore after slow
    speed:         def.speed,        // actual current speed (affected by slow)
    slowTimer:     0,                // remaining slow seconds
    slowFactor:    1,                // current slow multiplier (1 = full speed)
    pathProgress:  0,
    x: G.waypoints[0].x,
    y: G.waypoints[0].y,
    img: def.image ? loadImg(`assets/enemies/${def.image}`) : null,
    dead: false,
    id: Math.random(),
  });
}

// ─────────────────────────────────────────────
//  PATH INTERPOLATION
// ─────────────────────────────────────────────
function getPositionAlongPath(progress) {
  let remaining = progress;
  for (let i = 0; i < G.segLengths.length; i++) {
    if (remaining <= G.segLengths[i]) {
      const t = remaining / G.segLengths[i];
      const a = G.waypoints[i], b = G.waypoints[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= G.segLengths[i];
  }
  return { ...G.waypoints[G.waypoints.length - 1] };
}

// ─────────────────────────────────────────────
//  UPDATE ENEMIES  (handles slow timers too)
// ─────────────────────────────────────────────
function updateEnemies(dt) {
  const toRemove = new Set();
  for (const e of G.enemies) {
    if (e.dead) continue;

    // Tick slow timer
    if (e.slowTimer > 0) {
      e.slowTimer -= dt;
      if (e.slowTimer <= 0) {
        e.slowTimer  = 0;
        e.slowFactor = 1;
        e.speed      = e.baseSpeed;
      }
    }

    e.pathProgress += e.speed * CELL * dt;

    if (e.pathProgress >= G.totalPathLen) {
      G.riverHP = Math.max(0, G.riverHP - e.def.riverDamage);
      toRemove.add(e.id);
      G.waveGone++;
      if (G.riverHP <= 0) { triggerLose(); return; }
    } else {
      const pos = getPositionAlongPath(e.pathProgress);
      e.x = pos.x; e.y = pos.y;
    }
  }
  G.enemies = G.enemies.filter(e => !toRemove.has(e.id) && !e.dead);
}

// ─────────────────────────────────────────────
//  UPDATE SHOOTERS
// ─────────────────────────────────────────────
function updateShooters(dt) {
  for (const tower of G.placedTowers) {
    if (tower.def.type !== 'shooter') continue;
    tower.cooldown -= dt;
    if (tower.cooldown > 0 || G.enemies.length === 0) continue;
    if (tower.def.maxHealth > 0 && tower.currentHealth <= 0) continue;

    const rangeBase = tower.range * CELL;
    const inRange = G.enemies
      .filter(e => !e.dead && Math.hypot(e.x - tower.x, e.y - tower.y) <= rangeBase)
      .sort((a, b) => b.pathProgress - a.pathProgress);

    if (!inRange.length) continue;
    const target = inRange[0];
    tower.cooldown = tower.attackCooldown;

    const dx = target.x - tower.x;
    const dy = target.y - tower.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) continue;

    G.projectiles.push({
      // Position in base-CELL space
      x: tower.x, y: tower.y,
      destX: target.x, destY: target.y,
      dx: dx / dist, dy: dy / dist,
      angle: Math.atan2(dy, dx),           // radians — used to rotate the sprite
      speed:       tower.projectileSpeed * CELL,
      damage:      tower.damage,
      hitRadius:   tower.def.projectileHitRadius,
      // Splash
      hasSplash:   tower.def.hasSplash,
      splashRadius:tower.def.splashRadius * CELL,  // in base-CELL px
      // Slow
      hasSlow:     tower.def.hasSlow,
      slowFactor:  tower.def.slowFactor,
      slowDuration:tower.def.slowDuration,
      // Visual — use the projectile-specific image
      img:         tower.projectileImg,
      dead:        false,
    });

    if (tower.def.healthCostPerShot > 0) {
      tower.currentHealth -= tower.def.healthCostPerShot;
      if (tower.currentHealth < 0) tower.currentHealth = 0;
    }
  }
}

// ─────────────────────────────────────────────
//  APPLY HIT  (single target + optional splash)
// ─────────────────────────────────────────────
function applyHit(p, primaryEnemy) {
  const targets = p.hasSplash
    ? G.enemies.filter(e => !e.dead && Math.hypot(e.x - primaryEnemy.x, e.y - primaryEnemy.y) <= p.splashRadius)
    : [primaryEnemy];

  for (const e of targets) {
    e.currentHealth -= p.damage;

    // Apply slow if shooter has slow
    if (p.hasSlow) {
      // Only refresh if new slow is stronger or there is none
      if (p.slowFactor < e.slowFactor || e.slowTimer <= 0) {
        e.slowFactor = p.slowFactor;
        e.slowTimer  = p.slowDuration;
        e.speed      = e.baseSpeed * e.slowFactor;
      }
    }

    if (e.currentHealth <= 0) {
      e.currentHealth = 0;
      e.dead = true;
      G.bank += e.def.reward;
      G.enemiesDefeated++;
      G.waveGone++;
    }
  }

  // Spawn VFX at impact point
  if (p.hasSplash) {
    spawnVFX(primaryEnemy.x, primaryEnemy.y, p.splashRadius, 'splash');
  }
  if (p.hasSlow) {
    spawnVFX(primaryEnemy.x, primaryEnemy.y, Math.max(p.splashRadius, 16), 'slow');
  }
}

// ─────────────────────────────────────────────
//  VFX  (expanding rings)
// ─────────────────────────────────────────────
function spawnVFX(x, y, radius, type) {
  G.vfx.push({ x, y, maxRadius: Math.max(radius, CELL * 0.5), type, age: 0, duration: 0.4 });
}

function updateVFX(dt) {
  for (const v of G.vfx) v.age += dt;
  G.vfx = G.vfx.filter(v => v.age < v.duration);
}

// ─────────────────────────────────────────────
//  UPDATE PROJECTILES
// ─────────────────────────────────────────────
function updateProjectiles(dt) {
  for (const p of G.projectiles) {
    if (p.dead) continue;
    p.x += p.dx * p.speed * dt;
    p.y += p.dy * p.speed * dt;

    // Past destination?
    if ((p.destX - p.x) * p.dx + (p.destY - p.y) * p.dy < 0) { p.dead = true; continue; }
    // Off-screen?
    if (p.x < -CELL || p.x > COLS * CELL + CELL || p.y < -CELL || p.y > ROWS * CELL + CELL) { p.dead = true; continue; }

    // Collision check
    for (const e of G.enemies) {
      if (e.dead) continue;
      if (Math.hypot(p.x - e.x, p.y - e.y) <= p.hitRadius + e.def.hitboxRadius) {
        applyHit(p, e);
        p.dead = true;
        break;
      }
    }
  }
  G.projectiles = G.projectiles.filter(p => !p.dead);
  G.enemies     = G.enemies.filter(e => !e.dead);
}

// ─────────────────────────────────────────────
//  GENERATOR INCOME
// ─────────────────────────────────────────────
function updateIncome(dt) {
  G.incomeTimer += dt;
  if (G.incomeTimer >= 1) {
    G.incomeTimer -= 1;
    for (const t of G.placedTowers) if (t.def.type === 'generator') G.bank += t.income;
  }
}

// ─────────────────────────────────────────────
//  WAVE COMPLETION
// ─────────────────────────────────────────────
function checkWaveComplete() {
  if (G.state !== STATE.WAVE_ACTIVE) return;
  if (G.spawnQueue.length === 0 && G.enemies.length === 0 && G.waveGone >= G.waveTotal) {
    if (G.waveIndex === Registry.waves.length - 1) triggerWin();
    else { G.state = STATE.WAVE_COMPLETE; updateUI(); }
  }
}

// ─────────────────────────────────────────────
//  WIN / LOSE
// ─────────────────────────────────────────────
function triggerWin() {
  G.state = STATE.WIN; G.spawnQueue = [];
  updateUI(); showOverlay('win');
}
function triggerLose() {
  G.state = STATE.LOSE; G.spawnQueue = []; G.enemies = []; G.projectiles = [];
  updateUI(); showOverlay('lose');
}
function showOverlay(type) {
  document.getElementById('overlay-emoji').textContent = type === 'win' ? '🎉' : '💀';
  document.getElementById('overlay-title').className   = type;
  document.getElementById('overlay-title').textContent = type === 'win' ? 'River Saved!' : 'River Lost';
  document.getElementById('overlay-stats').innerHTML   = type === 'win'
    ? `<div class="overlay-stat">Waves survived: <span>${G.waveIndex + 1}</span></div>
       <div class="overlay-stat">Enemies defeated: <span>${G.enemiesDefeated}</span></div>
       <div class="overlay-stat">Final bank: <span>$${Math.floor(G.bank)}</span></div>`
    : `<div class="overlay-stat">Reached wave: <span>${G.waveIndex + 1} / ${Registry.waves.length}</span></div>
       <div class="overlay-stat">Enemies defeated: <span>${G.enemiesDefeated}</span></div>
       <div class="overlay-stat">Bank at loss: <span>$${Math.floor(G.bank)}</span></div>`;
  document.getElementById('overlay').classList.add('visible');
}
function hideOverlay() { document.getElementById('overlay').classList.remove('visible'); }

// ─────────────────────────────────────────────
//  CANVAS + RENDERING
// ─────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');
let cellSize = CELL;

function resizeCanvas() {
  const wrap  = document.getElementById('canvas-wrap');
  const scale = Math.min(wrap.clientWidth / (COLS * CELL), wrap.clientHeight / (ROWS * CELL), 1);
  cellSize      = CELL * scale;
  canvas.width  = Math.floor(COLS * cellSize);
  canvas.height = Math.floor(ROWS * cellSize);
}

// Tile colours — light nature theme
const TILE_FILL   = { [TILE.GRASS]:'#b8dc8e', [TILE.PATH]:'#e8d88a', [TILE.RIVER]:'#7bbcf0', [TILE.BASE]:'#c8a878' };
const TILE_STROKE = { [TILE.GRASS]:'#a0c878', [TILE.PATH]:'#d4c070', [TILE.RIVER]:'#5aa0e0', [TILE.BASE]:'#b09060' };

function render() {
  const cs = cellSize;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. TILES
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = G.grid[r][c];
      const tileName = TILE_NAMES[tile];
      const imgs = Registry.mapTiles[tileName];
      let img = null;
      if (imgs && imgs.length > 0) {
        const imgIdx = G.tileImageIndices[r][c];
        if (imgIdx >= 0 && imgIdx < imgs.length) {
          img = imgs[imgIdx];
        }
      }
      if (img?.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, c * cs, r * cs, cs, cs);
      } else {
        ctx.fillStyle = TILE_FILL[tile];
        ctx.fillRect(c * cs, r * cs, cs, cs);
      }
      ctx.strokeStyle = TILE_STROKE[tile];
      ctx.lineWidth   = 0.5;
      ctx.strokeRect(c * cs + 0.25, r * cs + 0.25, cs - 0.5, cs - 0.5);
    }
  }

  // River shimmer overlay
  const rs = COLS - RIVER_COLS;
  const rg = ctx.createLinearGradient(rs * cs, 0, COLS * cs, 0);
  rg.addColorStop(0, 'rgba(100,180,255,0.25)'); rg.addColorStop(1, 'rgba(60,140,255,0.12)');
  ctx.fillStyle = rg;
  ctx.fillRect(rs * cs, 0, RIVER_COLS * cs, ROWS * cs);

  // Subtle grass dots (disabled when using custom grass image)
  // ctx.fillStyle = 'rgba(80,140,40,0.06)';
  // for (let r = 0; r < ROWS; r++)
  //   for (let c = 0; c < COLS; c++)
  //     if (G.grid[r][c] === TILE.GRASS) {
  //       ctx.beginPath(); ctx.arc(c*cs+cs*.3, r*cs+cs*.3, cs*.06, 0, Math.PI*2); ctx.fill();
  //       ctx.beginPath(); ctx.arc(c*cs+cs*.72,r*cs+cs*.65,cs*.05, 0, Math.PI*2); ctx.fill();
  //     }

  // Placement hover
  if (G.placing && G.hoverCell) {
    const { row, col } = G.hoverCell;
    const ok = canPlace(row, col);
    ctx.fillStyle = ok ? 'rgba(70,132,50,0.22)' : 'rgba(220,50,50,0.22)';
    ctx.fillRect(col*cs, row*cs, cs, cs);
    ctx.strokeStyle = ok ? '#468432' : '#e03030'; ctx.lineWidth = 2;
    ctx.strokeRect(col*cs+1, row*cs+1, cs-2, cs-2);
    if (G.placing.def.type === 'shooter') {
      ctx.beginPath();
      ctx.arc(col*cs+cs/2, row*cs+cs/2, G.placing.def.range*cs, 0, Math.PI*2);
      ctx.strokeStyle = '#ff0000'; ctx.lineWidth = 3;
      ctx.setLineDash([5,4]); ctx.stroke(); ctx.setLineDash([]);
    }
    // Draw the tower image on top
    const img = G.placing.def.image ? loadImg(`assets/${G.placing.def.type}s/${G.placing.def.image}`) : null;
    if (img?.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, col * cs + 2, row * cs + 2, cs - 4, cs - 4);
    }
  }

  // 2. GENERATORS
  for (const t of G.placedTowers) if (t.def.type === 'generator') drawTower(t, cs);

  // 3. SHOOTERS
  for (const t of G.placedTowers) if (t.def.type === 'shooter') drawTower(t, cs);

  // Range ring for selected tower
  if (G.selectedTower?.def.type === 'shooter' && G.selectedTower.row != null) {
    const t = G.selectedTower;
    ctx.beginPath();
    ctx.arc(t.col*cs+cs/2, t.row*cs+cs/2, t.range*cs, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(70,132,50,0.55)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([6,4]); ctx.stroke(); ctx.setLineDash([]);
  }

  // 4. VFX — splash / slow rings (drawn under enemies for depth)
  for (const v of G.vfx) {
    const t     = v.age / v.duration;          // 0→1
    const alpha = 1 - t;
    const r     = v.maxRadius * t * (cs / CELL);
    const sx    = (v.x / CELL) * cs;
    const sy    = (v.y / CELL) * cs;
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, r), 0, Math.PI * 2);
    if (v.type === 'splash') {
      ctx.strokeStyle = `rgba(255,140,30,${alpha * 0.9})`;
      ctx.lineWidth   = 3 * (1 - t) + 1;
    } else { // slow (ice-blue)
      ctx.strokeStyle = `rgba(80,180,255,${alpha * 0.9})`;
      ctx.lineWidth   = 2.5 * (1 - t) + 0.5;
    }
    ctx.stroke();
    // Inner fill fade
    ctx.fillStyle = v.type === 'splash'
      ? `rgba(255,160,50,${alpha * 0.12})`
      : `rgba(100,200,255,${alpha * 0.14})`;
    ctx.fill();
  }

  // 5. ENEMIES
  for (const e of G.enemies) {
    if (e.dead) continue;
    const sx = (e.x / CELL) * cs;
    const sy = (e.y / CELL) * cs;
    const er = Math.max(6, e.def.hitboxRadius * (cs / CELL));

    // Slow tint overlay (drawn behind sprite)
    if (e.slowTimer > 0) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle   = '#60b0ff';
      ctx.beginPath(); ctx.arc(sx, sy, er + 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    if (e.img?.complete && e.img.naturalWidth > 0) {
      ctx.drawImage(e.img, sx - er, sy - er, er * 2, er * 2);
    } else {
      ctx.fillStyle = '#e05030';
      ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(er * 1.1)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🗑', sx, sy + 1);
    }

    // Health bar
    const hpFrac = Math.max(0, e.currentHealth / e.maxHealth);
    const bw = e.def.hpBarWidth * (cs / CELL);
    const bh = Math.max(2, e.def.hpBarHeight * (cs / CELL));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(sx - bw/2, sy - er - bh - 3, bw, bh);
    ctx.fillStyle = hpFrac > 0.6 ? '#468432' : hpFrac > 0.3 ? '#FFA02E' : '#e03030';
    ctx.fillRect(sx - bw/2, sy - er - bh - 3, bw * hpFrac, bh);

    // Slow icon above health bar
    if (e.slowTimer > 0) {
      ctx.font = `${Math.floor(cs * 0.28)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('❄', sx, sy - er - bh - 5);
    }
  }

  // 6. PROJECTILES — drawn as the shooter's own PNG, rotated toward travel direction
  for (const p of G.projectiles) {
    if (p.dead) continue;
    const sx = (p.x / CELL) * cs;
    const sy = (p.y / CELL) * cs;
    // Projectile visual size: 60% of a cell
    const pr = cs * 0.3;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(p.angle + Math.PI / 2); // +90° so "up" in the image faces the travel dir

    if (p.img?.complete && p.img.naturalWidth > 0) {
      ctx.drawImage(p.img, -pr, -pr, pr * 2, pr * 2);
    } else {
      // Fallback: coloured oval
      ctx.fillStyle = p.hasSlow ? '#60b0ff' : '#FFA02E';
      ctx.beginPath();
      ctx.ellipse(0, 0, pr * 0.5, pr, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.ellipse(-pr * 0.12, -pr * 0.25, pr * 0.18, pr * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawTower(t, cs) {
  const x = t.col * cs, y = t.row * cs;

  if (t.img?.complete && t.img.naturalWidth > 0) {
    ctx.drawImage(t.img, x + 2, y + 2, cs - 4, cs - 4);
  } else {
    ctx.fillStyle = t.def.type === 'shooter' ? '#2a6aad' : '#468432';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x+4, y+4, cs-8, cs-8, 4);
    else ctx.rect(x+4, y+4, cs-8, cs-8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.floor(cs * 0.4)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t.def.type === 'shooter' ? '⚡' : '🌿', x + cs/2, y + cs/2);
  }

  // Special-ability indicators (small dots in corner)
  if (t.def.type === 'shooter') {
    let dotX = x + cs - 5;
    if (t.def.hasSplash) {
      ctx.fillStyle = '#FFA02E';
      ctx.beginPath(); ctx.arc(dotX, y + 5, 3, 0, Math.PI * 2); ctx.fill();
      dotX -= 8;
    }
    if (t.def.hasSlow) {
      ctx.fillStyle = '#60b0ff';
      ctx.beginPath(); ctx.arc(dotX, y + 5, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Level badge
  if (t.level > 1) {
    ctx.fillStyle = '#FFA02E';
    ctx.font = `bold ${Math.floor(cs * 0.22)}px Nunito, sans-serif`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`L${t.level}`, x + cs - 2, y + cs - 1);
  }
  if (t.maxHealth > 0) {
    const frac = Math.max(0, t.currentHealth / t.maxHealth);

    const bw = t.def.hpBarWidth * (cs / CELL);
    const bh = Math.max(2, t.def.hpBarHeight * (cs / CELL));

    const sx = x + cs / 2;

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(sx - bw/2, y - bh - 2, bw, bh);

    ctx.fillStyle =
      frac > 0.6 ? '#468432' :
      frac > 0.3 ? '#FFA02E' :
                   '#e03030';

    ctx.fillRect(sx - bw/2, y - bh - 2, bw * frac, bh);
}
  // Selection ring
  if (G.selectedTower === t) {
    ctx.strokeStyle = '#468432'; ctx.lineWidth = 2.5;
    ctx.strokeRect(x + 1.5, y + 1.5, cs - 3, cs - 3);
  }
}

// ─────────────────────────────────────────────
//  UI UPDATES
// ─────────────────────────────────────────────
function updateUI() {
  document.getElementById('ui-wave').textContent     = `${Math.max(0, G.waveIndex + 1)} / ${Registry.waves.length}`;
  document.getElementById('ui-bank').textContent     = `$${Math.floor(G.bank)}`;
  document.getElementById('ui-river-hp').textContent = `${Math.ceil(G.riverHP)} / ${G.riverMaxHP}`;

  const hpFrac = G.riverHP / G.riverMaxHP;
  const bar    = document.getElementById('ui-river-bar');
  bar.style.width      = `${hpFrac * 100}%`;
  bar.style.background = hpFrac > 0.6 ? '#9AD872' : hpFrac > 0.3 ? '#FFA02E' : '#e03030';

  const waveBtn = document.getElementById('btn-next-wave');
  waveBtn.disabled = !(G.state === STATE.IDLE || G.state === STATE.WAVE_COMPLETE);
  waveBtn.textContent =
    G.state === STATE.IDLE          ? '▶ Start Wave 1' :
    G.state === STATE.WAVE_COMPLETE ? `▶ Wave ${G.waveIndex + 2}` :
                                      '⏳ In Progress...';

  document.querySelectorAll('.palette-card').forEach(card => {
    card.classList.toggle('insufficient', parseInt(card.dataset.cost, 10) > G.bank);
  });

  if (G.selectedTower) refreshInfoPanel();
}

// ─────────────────────────────────────────────
//  PALETTE
// ─────────────────────────────────────────────
function renderPalette() {
  const scroll = document.getElementById('palette-scroll');
  scroll.innerHTML = '';

  const sNames = Object.keys(Registry.shooters);
  const gNames = Object.keys(Registry.generators);

  if (sNames.length) {
    const lbl = Object.assign(document.createElement('div'), { className: 'palette-sep-label', textContent: '⚡ Shooters' });
    scroll.appendChild(lbl);
    sNames.forEach(n => scroll.appendChild(makePaletteCard(Registry.shooters[n])));
  }
  if (gNames.length) {
    const lbl = Object.assign(document.createElement('div'), { className: 'palette-sep-label', textContent: '🌿 Generators' });
    scroll.appendChild(lbl);
    gNames.forEach(n => scroll.appendChild(makePaletteCard(Registry.generators[n])));
  }
}

function createTowerPreview(def) {
  const preview = {
    def,
    level: 1,
    row: null,
    col: null,
    cooldown: 0,
    preview: true,
    img: def.image ? loadImg(`assets/${def.type}s/${def.image}`) : null,
  };
  computeTowerStats(preview);
  return preview;
}

function makePaletteCard(def) {
  const card = document.createElement('div');
  card.className        = 'palette-card';
  card.dataset.name     = def.name;
  card.dataset.cost     = def.cost;
  if (def.cost > G.bank) card.classList.add('insufficient');

  const imgSrc = def.image ? `assets/${def.type}s/${def.image}` : null;
  const stat   = def.type === 'shooter'
    ? `DMG ${def.baseDamage} · RNG ${def.range} · ${def.baseFireRate}/s`
    : `$${def.baseIncome}/sec`;

  // Build tag badges
  let tagHTML = '';
  /*if (def.type === 'shooter') {
    if (def.hasSplash) tagHTML += `<span class="card-tag splash">Area!</span>`;
    if (def.hasSlow)   tagHTML += `<span class="card-tag slow">Speed!</span>`;
  }*/

  card.innerHTML = `
    <div class="card-img-wrap">
      ${imgSrc
        ? `<img src="${imgSrc}" alt="${def.name}">`
        : `<span class="card-img-placeholder">${def.type === 'shooter' ? '⚡' : '🌿'}</span>`}
    </div>
    <div class="card-name">${def.name}</div>
    <div class="card-cost">$${def.cost}</div>
    <div class="card-stat">${stat}</div>
    ${tagHTML ? `<div class="card-tags">${tagHTML}</div>` : ''}
  `;

  card.addEventListener('click', () => {
    if (def.cost > G.bank) return;
    if (G.placing?.def.name === def.name) { cancelPlacement(); closeInfoPanel(); return; }
    G.placing = { def };
    openInfoPanel(createTowerPreview(def));
    document.querySelectorAll('.palette-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    canvas.style.cursor = 'crosshair';
  });
  return card;
}

function cancelPlacement() {
  G.placing = null; G.hoverCell = null;
  document.querySelectorAll('.palette-card').forEach(c => c.classList.remove('selected'));
  canvas.style.cursor = 'default';
}

// ─────────────────────────────────────────────
//  INFO PANEL  (side panel)
// ─────────────────────────────────────────────
function openInfoPanel(tower) {
  G.selectedTower = tower;
  // Keep bottom bar on towers tab; side panel handles the info
  document.getElementById('tab-info').style.display = 'none';
  showTab('towers');
  document.getElementById('side-panel').classList.add('visible');
  refreshInfoPanel();
}

function closeInfoPanel() {
  G.selectedTower = null;
  document.getElementById('side-panel').classList.remove('visible');
  document.getElementById('tab-info').style.display = 'none';
  showTab('towers');
}

function refreshInfoPanel() {
  const tower = G.selectedTower;
  if (!tower) return;
  const def = tower.def;

  // ── Image ──
  const spImg      = document.getElementById('sp-img');
  const spFallback = document.getElementById('sp-img-fallback');
  if (def.image) {
    spImg.src           = `assets/${def.type}s/${def.image}`;
    spImg.style.display = '';
    spFallback.style.display = 'none';
  } else {
    spImg.style.display     = 'none';
    spFallback.textContent  = def.type === 'shooter' ? '⚡' : '🌿';
    spFallback.style.display = '';
  }

  // ── Name & type badge ──
  document.getElementById('sp-name').textContent       = def.name;
  document.getElementById('sp-type-badge').textContent = def.type === 'shooter' ? '⚡ Shooter' : '🌿 Generator';

  // ── Ability tags ──
  let tagHTML = '';
  /*if (def.type === 'shooter') {
    if (def.hasSplash) tagHTML += `<span class="card-tag splash">💥 Splash</span>`;
    if (def.hasSlow)   tagHTML += `<span class="card-tag slow">Speed!</span>`;
  }*/
  document.getElementById('sp-tags').innerHTML = tagHTML;

  // ── Description ──
  const descEl = document.getElementById('sp-desc');
  if (def.description) {
    descEl.textContent = def.description;
    descEl.classList.add('has-text');
  } else {
    descEl.textContent = '';
    descEl.classList.remove('has-text');
  }

  // ── Stats ──
  const statsEl  = document.getElementById('sp-stats');
  statsEl.innerHTML = '';
  const maxLevel = def.levelMultipliers.length;
  const hasNext  = tower.level < maxLevel;

  function row(key, val, cls = '') {
    const d = document.createElement('div');
    d.className = 'info-row';
    d.innerHTML = `<span class="info-key">${key}</span><span class="info-val ${cls}">${val}</span>`;
    statsEl.appendChild(d);
  }

  row('Level', `${tower.level} / ${maxLevel}`);

  if (def.type === 'shooter') {
    row('Damage',    tower.damage.toFixed(1));
    row('Fire Rate', `${tower.fireRate.toFixed(2)}/s`);
    row('Range',     `${tower.range} tiles`);
    if (def.hasSplash) row('Splash Radius', `${def.splashRadius} tiles`);
    if (def.hasSlow)   row('Speed of Original',          `${(((1 - def.slowFactor) * 100)).toFixed(0)}% for ${def.slowDuration}s`);
    if (hasNext) {
      const nm = def.levelMultipliers[tower.level];
      row('→ Next Dmg',  (def.baseDamage  * nm).toFixed(1),           'next');
      row('→ Next Rate', `${(def.baseFireRate * nm).toFixed(2)}/s`,    'next');
    }
  } else {
    row('Income', `$${tower.income.toFixed(1)}/s`);
    if (hasNext) {
      const nm = def.levelMultipliers[tower.level];
      row('→ Next Income', `$${(def.baseIncome * nm).toFixed(1)}/s`, 'next');
    }
  }

  // ── Upgrade button ──
  const btn = document.getElementById('sp-upgrade-btn');
  if (!hasNext || tower.preview) {
    btn.textContent = tower.preview ? 'Place to build' : 'MAX LEVEL';
    btn.disabled = true;
  } else {
    const cost = def.upgradeCosts[tower.level];
    btn.textContent = `Upgrade  $${cost}`;
    btn.disabled    = G.bank < cost;
  }
}

document.getElementById('sp-upgrade-btn').addEventListener('click', () => {
  const t = G.selectedTower; if (!t) return;
  const maxLvl = t.def.levelMultipliers.length;
  if (t.level >= maxLvl) return;
  const cost = t.def.upgradeCosts[t.level];
  if (G.bank < cost) return;
  G.bank -= cost; t.level++; computeTowerStats(t); updateUI();
});

document.getElementById('sp-close').addEventListener('click', () => { closeInfoPanel(); canvas.style.cursor = 'default'; });

// Keep legacy bottom-bar upgrade button wired up (panel is hidden but listener is harmless)
document.getElementById('btn-upgrade').addEventListener('click', () => {
  const t = G.selectedTower; if (!t) return;
  const maxLvl = t.def.levelMultipliers.length;
  if (t.level >= maxLvl) return;
  const cost = t.def.upgradeCosts[t.level];
  if (G.bank < cost) return;
  G.bank -= cost; t.level++; computeTowerStats(t); updateUI();
});

document.getElementById('btn-close-info').addEventListener('click', () => { closeInfoPanel(); canvas.style.cursor = 'default'; });

// ─────────────────────────────────────────────
//  CANVAS INPUT
// ─────────────────────────────────────────────
function cellFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    col: Math.floor((e.clientX - rect.left) / cellSize),
    row: Math.floor((e.clientY - rect.top)  / cellSize),
  };
}

canvas.addEventListener('mousemove', e => { if (G.placing) G.hoverCell = cellFromEvent(e); });
canvas.addEventListener('mouseleave',  () => { G.hoverCell = null; });

canvas.addEventListener('click', e => {
  const { row, col } = cellFromEvent(e);
  if (G.placing) {
    if (canPlace(row, col) && G.placing.def.cost <= G.bank) {
      placeTower(G.placing.def, row, col);
      if (!e.shiftKey) cancelPlacement();
    }
    return;
  }
  const hit = G.placedTowers.find(t => t.row === row && t.col === col);
  if (hit) { if (G.selectedTower === hit) closeInfoPanel(); else openInfoPanel(hit); }
  else closeInfoPanel();
});

canvas.addEventListener('contextmenu', e => { e.preventDefault(); cancelPlacement(); closeInfoPanel(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') { cancelPlacement(); closeInfoPanel(); } });

// ─────────────────────────────────────────────
//  BUTTONS
// ─────────────────────────────────────────────
document.getElementById('btn-next-wave').addEventListener('click', startNextWave);
document.getElementById('btn-restart').addEventListener('click', () => { hideOverlay(); initGame(); });

// ─────────────────────────────────────────────
//  GAME LOOP
// ─────────────────────────────────────────────
let lastTime = null;

function gameLoop(ts) {
  if (!lastTime) lastTime = ts;
  const dt = Math.min((ts - lastTime) / 1000, 0.1);
  lastTime = ts;

  if (G.state === STATE.WAVE_ACTIVE) {
    G.spawnTimer -= dt;
    if (G.spawnTimer <= 0 && G.spawnQueue.length > 0) {
      spawnEnemy(G.spawnQueue.shift());
      G.spawnTimer = 1;
    }
    updateEnemies(dt);
    if (G.state !== STATE.LOSE) {
      updateShooters(dt);
      updateProjectiles(dt);
      updateVFX(dt);
      updateIncome(dt);
      checkWaveComplete();
    }
  } else if (G.state === STATE.IDLE || G.state === STATE.WAVE_COMPLETE) {
    updateVFX(dt);
  }

  if (G.state !== STATE.WIN && G.state !== STATE.LOSE) updateUI();

  render();
  requestAnimationFrame(gameLoop);
}

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed: ${url} (${res.status})`);
  return res.text();
}

function setLoadMsg(msg) { document.getElementById('loading-msg').textContent = msg; }

async function boot() {
  try {
    setLoadMsg('Reading manifest...');
    const manifest = JSON.parse(await fetchText('data/manifest.json'));

    setLoadMsg('Loading river...');
    Registry.river = parseRiverDef(await fetchText(`data/river/${manifest.river}`));

    setLoadMsg('Loading shooters...');
    const shooterImgPromises = [];
    for (const f of (manifest.shooters || [])) {
      const def = parseShooterDef(await fetchText(`data/shooters/${f}`));
      Registry.shooters[def.name] = def;
      // Pre-load shooter image
      if (def.image) {
        const img = new Image();
        img.src = `assets/shooters/${def.image}`;
        ImgCache[`assets/shooters/${def.image}`] = img;
        shooterImgPromises.push(new Promise(r => { img.onload = r; img.onerror = r; }));
      }
      // Pre-load projectile image
      if (def.projectileImage) {
        const img = new Image();
        img.src = `assets/projectiles/${def.projectileImage}`;
        ImgCache[`assets/projectiles/${def.projectileImage}`] = img;
        shooterImgPromises.push(new Promise(r => { img.onload = r; img.onerror = r; }));
      }
    }
    // Wait for shooter images to load
    if (shooterImgPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(shooterImgPromises),
        new Promise(r => setTimeout(r, 2000))
      ]).catch(() => {});
    }

    setLoadMsg('Loading generators...');
    const generatorImgPromises = [];
    for (const f of (manifest.generators || [])) {
      const def = parseGeneratorDef(await fetchText(`data/generators/${f}`));
      Registry.generators[def.name] = def;
      // Pre-load generator image
      if (def.image) {
        const img = new Image();
        img.src = `assets/generators/${def.image}`;
        ImgCache[`assets/generators/${def.image}`] = img;
        generatorImgPromises.push(new Promise(r => { img.onload = r; img.onerror = r; }));
      }
    }
    // Wait for generator images to load
    if (generatorImgPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(generatorImgPromises),
        new Promise(r => setTimeout(r, 2000))
      ]).catch(() => {});
    }

    setLoadMsg('Loading enemies...');
    for (const f of (manifest.enemies || [])) {
      const def = parseEnemyDef(await fetchText(`data/enemies/${f}`));
      Registry.enemies[def.name] = def;
    }

    setLoadMsg('Loading waves...');
    for (const f of (manifest.waves || [])) {
      Registry.waves.push(parseWaveDef(await fetchText(`data/waves/${f}`)));
    }
    Registry.waves.sort((a, b) => a.waveNumber - b.waveNumber);

    setLoadMsg('Loading map tiles...');
    // Load single base versions first
    const baseGrass = loadImg('map/grass.png');
    const basePath = loadImg('map/path.png');
    const baseRiver = loadImg('map/river.png');
    const baseBase = loadImg('map/base.png');
    
    // Wait for base images to load or timeout
    await Promise.race([
      Promise.all([
        new Promise(r => { baseGrass.onload = r; }),
        new Promise(r => { basePath.onload = r; }),
        new Promise(r => { baseRiver.onload = r; }),
        new Promise(r => { baseBase.onload = r; })
      ]),
      new Promise(r => setTimeout(r, 3000))
    ]).catch(() => {});
    
    Registry.mapTiles.grass.push(baseGrass);
    Registry.mapTiles.path.push(basePath);
    Registry.mapTiles.river.push(baseRiver);
    Registry.mapTiles.base.push(baseBase);
    
    // Try loading numbered variants (grass1, grass2, etc.)
    // Collect all numbered variant promises
    const variantPromises = [];
    const variantImgs = { grass: [], path: [], river: [], base: [] };
    
    for (let i = 1; i <= 5; i++) {
      const grassImg = loadImg(`map/grass${i}.png`);
      const pathImg = loadImg(`map/path${i}.png`);
      const riverImg = loadImg(`map/river${i}.png`);
      const baseImg = loadImg(`map/base${i}.png`);
      
      variantImgs.grass.push(grassImg);
      variantImgs.path.push(pathImg);
      variantImgs.river.push(riverImg);
      variantImgs.base.push(baseImg);
      
      variantPromises.push(
        new Promise(r => { grassImg.onload = r; grassImg.onerror = r; }),
        new Promise(r => { pathImg.onload = r; pathImg.onerror = r; }),
        new Promise(r => { riverImg.onload = r; riverImg.onerror = r; }),
        new Promise(r => { baseImg.onload = r; baseImg.onerror = r; })
      );
    }
    
    // Wait for variants with timeout
    await Promise.race([
      Promise.allSettled(variantPromises),
      new Promise(r => setTimeout(r, 3000))
    ]).catch(() => {});
    
    // Push only the variants that actually loaded
    for (let i = 0; i < 5; i++) {
      if (variantImgs.grass[i]?.complete && variantImgs.grass[i].naturalWidth > 0) Registry.mapTiles.grass.push(variantImgs.grass[i]);
      if (variantImgs.path[i]?.complete && variantImgs.path[i].naturalWidth > 0) Registry.mapTiles.path.push(variantImgs.path[i]);
      if (variantImgs.river[i]?.complete && variantImgs.river[i].naturalWidth > 0) Registry.mapTiles.river.push(variantImgs.river[i]);
      if (variantImgs.base[i]?.complete && variantImgs.base[i].naturalWidth > 0) Registry.mapTiles.base.push(variantImgs.base[i]);
    }

    setLoadMsg('Ready!');
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('landing').style.display        = 'flex';

    initGame();
    requestAnimationFrame(gameLoop);

  } catch (err) {
    setLoadMsg(`⚠ Error: ${err.message}`);
    console.error(err);
  }
}

boot();