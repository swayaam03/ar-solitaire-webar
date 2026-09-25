/* ============================================================================
   AR KLONDIKE SOLITAIRE — game.js
   ============================================================================
   Single-Mesh Card Architecture:
   - Exactly ONE <a-plane> entity per card with THREE.DoubleSide material.
   - Textures swap dynamically on that single mesh when card.faceUp changes.
   - No two-plane wrappers, no 180° rotations, no Z-fighting or plane bleeding.
   - Elevation base BOARD_Z = 0.015 ensures cards never clip into the target image.
   - CARD_Z_STEP = 0.008 with mesh.renderOrder = layer + 1 for deterministic stacking.
   - Direct mesh.uuid -> card / slot Maps for instant, unambiguous raycasting.
   ========================================================================== */

// ----------------------------------------------------------------------------
// 0. CONFIG & DEBUG
// ----------------------------------------------------------------------------
const DEBUG_AR = true;     // Real-time diagnostics overlay for physical phone testing
const DEBUG_BOARD = false;  // Toggle to true to render the gold board bounding box

const CONFIG = {
  useImageTextures: false,
  cardImagePath: 'assets/cards/',
  cardBackImage: 'assets/back.png',
};

// ----------------------------------------------------------------------------
// 1. CONSTANTS — dimensions, layout, and AR coordinate space
// ----------------------------------------------------------------------------
const BOARD_SCALE = 1.0; // 1:1 target-local coordinate system

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const SUIT_SYMBOLS = { hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663', spades: '\u2660' };
const SUIT_COLORS = { hearts: 'red', diamonds: 'red', clubs: 'black', spades: 'black' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUES = RANKS.reduce((map, r, i) => { map[r] = i + 1; return map; }, {});

// Card footprint in target-local units (poker 2.5:3.5 aspect ratio)
const CARD_WIDTH = 0.110;
const CARD_HEIGHT = 0.154;

// Horizontal spacing across 7 tableau columns
const COL_GAP = 0.115;
const TABLEAU_X = [-3, -2, -1, 0, 1, 2, 3].map((n) => n * COL_GAP);

// Tableau vertical cascade: clear, generous spacing to ensure readability
const TABLEAU_TOP_Y = 0.05;
const TABLEAU_FACEDOWN_STEP = 0.024;
const TABLEAU_FACEUP_STEP = 0.050;

// Top row: Stock | Waste | (gap) | Foundation x4
const TOP_ROW_Y = 0.30;
const STOCK_POS = { x: TABLEAU_X[0], y: TOP_ROW_Y };
const WASTE_POS = { x: TABLEAU_X[1], y: TOP_ROW_Y };
const FOUNDATION_X = [TABLEAU_X[3], TABLEAU_X[4], TABLEAU_X[5], TABLEAU_X[6]];
const FOUNDATION_Y = TOP_ROW_Y;

// AR depth relative to target surface
const BOARD_Z = 0.015;     // 1.5 cm above marker plane: eliminates target clipping
const CARD_Z_STEP = 0.008; // 8 mm physical step per card in stack

// Selection lift
const SELECT_LIFT_Y = 0.015;
const SELECT_LIFT_Z = 0.025;

// Calculated board boundaries: 0.800 m wide (80% of 1.0 target width)
const BOARD_WIDTH = 6 * COL_GAP + CARD_WIDTH;
const BOARD_HEIGHT = 0.774;

// ----------------------------------------------------------------------------
// 2. GAME STATE & MAPPINGS
// ----------------------------------------------------------------------------
let deck = [];
let tableau = [[], [], [], [], [], [], []];
let stock = [];
let waste = [];
let foundations = { hearts: [], diamonds: [], clubs: [], spades: [] };

let selected = null;

// Direct mapping from Three.js mesh.uuid -> Card object or Pile Slot
const meshToCard = new Map();
const meshToSlot = new Map();
const pileSlots = [];
let texturesReadyCount = 0;

// ----------------------------------------------------------------------------
// 3. DEBUG OVERLAY HELPER
// ----------------------------------------------------------------------------
function updateDebug(data) {
  if (!DEBUG_AR) return;
  const panel = document.getElementById('debugPanel');
  if (panel && panel.style.display === 'none') {
    panel.style.display = 'block';
  }

  if (data.tracking !== undefined) {
    const el = document.getElementById('debugTracking');
    if (el) el.innerHTML = data.tracking;
  }
  if (data.cardMeshes !== undefined) {
    const el = document.getElementById('debugCardMeshes');
    if (el) el.textContent = data.cardMeshes;
  }
  if (data.visibleMeshes !== undefined) {
    const el = document.getElementById('debugVisibleMeshes');
    if (el) el.textContent = data.visibleMeshes;
  }
  if (data.texturesReady !== undefined) {
    const el = document.getElementById('debugTexturesReady');
    if (el) el.textContent = data.texturesReady;
  }
  if (data.pointer !== undefined) {
    const el = document.getElementById('debugPointer');
    if (el) el.textContent = data.pointer;
  }
  if (data.ndc !== undefined) {
    const el = document.getElementById('debugNDC');
    if (el) el.textContent = data.ndc;
  }
  if (data.hits !== undefined) {
    const el = document.getElementById('debugHits');
    if (el) el.textContent = data.hits;
  }
  if (data.hitObject !== undefined) {
    const el = document.getElementById('debugHitObject');
    if (el) el.textContent = data.hitObject;
  }
  if (data.card !== undefined) {
    const el = document.getElementById('debugCard');
    if (el) el.textContent = data.card;
  }
  if (data.selected !== undefined) {
    const el = document.getElementById('debugSelected');
    if (el) el.textContent = data.selected;
  }
  if (data.board !== undefined) {
    const el = document.getElementById('debugBoard');
    if (el) el.textContent = data.board;
  }
}

// ----------------------------------------------------------------------------
// 4. DECK BUILDING / SHUFFLING / DEALING
// ----------------------------------------------------------------------------
function buildDeck() {
  const cards = [];
  let id = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({
        id: id++,
        suit,
        rank,
        rankValue: RANK_VALUES[rank],
        color: SUIT_COLORS[suit],
        faceUp: false,
        location: null,
        el: null, // Single <a-plane>
        selected: false,
      });
    }
  }
  return cards;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function dealNewGame() {
  clearBoard();
  selected = null;
  meshToCard.clear();

  deck = shuffle(buildDeck());
  tableau = [[], [], [], [], [], [], []];
  stock = [];
  waste = [];
  foundations = { hearts: [], diamonds: [], clubs: [], spades: [] };

  let idx = 0;
  for (let col = 0; col < 7; col++) {
    for (let row = 0; row <= col; row++) {
      const card = deck[idx++];
      card.faceUp = row === col;
      card.location = { type: 'tableau', index: col };
      tableau[col].push(card);
    }
  }
  while (idx < deck.length) {
    const card = deck[idx++];
    card.faceUp = false;
    card.location = { type: 'stock' };
    stock.push(card);
  }

  const container = document.getElementById('cardsContainer');
  deck.forEach((card) => container.appendChild(createCardEntity(card)));
  renderBoard(true);

  updateDebug({
    cardMeshes: '52',
    visibleMeshes: `${deck.filter(c => c.faceUp).length} face-up`,
    texturesReady: `${texturesReadyCount}/53`,
    card: 'DEALT',
    selected: 'NO',
    board: `${BOARD_WIDTH.toFixed(2)}x${BOARD_HEIGHT.toFixed(2)} (scale: ${BOARD_SCALE})`
  });
}

function clearBoard() {
  const container = document.getElementById('cardsContainer');
  if (container) {
    while (container.firstChild) container.removeChild(container.firstChild);
  }
  const win = document.getElementById('winMessage');
  if (win) win.style.display = 'none';
}

// ----------------------------------------------------------------------------
// 5. SINGLE-MESH CARD ENTITY CREATION & VISUAL UPDATING
// ----------------------------------------------------------------------------
function createCardEntity(card) {
  // Exactly ONE <a-plane> per card. No wrappers, no front/back plane offsets.
  const el = document.createElement('a-plane');
  el.id = 'card-' + card.id;
  el.classList.add('card-plane');
  el.setAttribute('width', CARD_WIDTH);
  el.setAttribute('height', CARD_HEIGHT);
  el.setAttribute('position', `0 0 ${BOARD_Z}`);
  el.setAttribute('rotation', '0 0 0');
  el.setAttribute('material', 'shader: flat; side: double; transparent: false; opacity: 1');

  function initMesh() {
    const mesh = el.getObject3D('mesh');
    if (mesh) {
      meshToCard.set(mesh.uuid, card);
      mesh.material.transparent = false;
      mesh.material.opacity = 1.0;
      mesh.material.side = THREE.DoubleSide;
      mesh.material.depthTest = true;
      mesh.material.depthWrite = true;
      updateCardVisual(card);
      console.log(`CARD VISUAL READY: card-${card.id}`);
    } else {
      el.addEventListener('loaded', () => {
        const m = el.getObject3D('mesh');
        if (m) {
          meshToCard.set(m.uuid, card);
          m.material.transparent = false;
          m.material.opacity = 1.0;
          m.material.side = THREE.DoubleSide;
          m.material.depthTest = true;
          m.material.depthWrite = true;
          updateCardVisual(card);
          console.log(`CARD VISUAL READY: card-${card.id}`);
        }
      }, { once: true });
    }
  }
  initMesh();

  card.el = el;
  return el;
}

function setCardTexture(card, texture) {
  if (!card || !card.el) return;
  const mesh = card.el.getObject3D('mesh');
  if (mesh && mesh.material) {
    mesh.material.map = texture;
    mesh.material.color.set(card.selected ? 0xffea75 : 0xffffff);
    mesh.material.transparent = false;
    mesh.material.opacity = 1.0;
    mesh.material.side = THREE.DoubleSide;
    mesh.material.depthTest = true;
    mesh.material.depthWrite = true;
    mesh.material.needsUpdate = true;
  }
}

// Swaps texture on the single mesh when faceUp changes (no 180° rotation needed)
function updateCardVisual(card) {
  if (!card) return;
  const texture = card.faceUp ? getFrontTexture(card) : getBackTexture();
  setCardTexture(card, texture);
}

function setHighlight(card, on) {
  card.selected = on;
  if (!card.el) return;
  const mesh = card.el.getObject3D('mesh');
  if (mesh && mesh.material) {
    mesh.material.color.set(on ? 0xffea75 : 0xffffff);
    mesh.material.needsUpdate = true;
  }
}

// ----------------------------------------------------------------------------
// 6. HIGH-CONTRAST OPAQUE TEXTURES (WHITE CARD FACES / CRIMSON BACK)
// ----------------------------------------------------------------------------
const frontTextureCache = {};
let backTextureCache = null;

function getFrontTexture(card) {
  const key = card.suit + '_' + card.rank;
  if (frontTextureCache[key]) return frontTextureCache[key];

  let texture;
  if (CONFIG.useImageTextures) {
    texture = new THREE.TextureLoader().load(buildCardImageUrl(card));
  } else {
    texture = generatePlaceholderFrontTexture(card);
  }
  frontTextureCache[key] = texture;
  return texture;
}

function getBackTexture() {
  if (backTextureCache) return backTextureCache;
  if (CONFIG.useImageTextures) {
    backTextureCache = new THREE.TextureLoader().load(CONFIG.cardBackImage);
  } else {
    backTextureCache = generatePlaceholderBackTexture();
  }
  return backTextureCache;
}

function buildCardImageUrl(card) {
  const suitInitial = card.suit.charAt(0).toUpperCase();
  return `${CONFIG.cardImagePath}${card.rank}${suitInitial}.png`;
}

function generatePlaceholderFrontTexture(card) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 358;
  const ctx = canvas.getContext('2d');
  const color = card.color === 'red' ? '#c81010' : '#0a0a0a';

  // Solid pure white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Outer dark solid border
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 4;
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18, false, true);

  // Inner subtle border
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  roundRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 14, false, true);

  ctx.fillStyle = color;
  ctx.textBaseline = 'top';

  // Top-left rank + suit
  ctx.font = 'bold 44px Georgia, serif';
  ctx.fillText(card.rank, 16, 12);
  ctx.font = '36px Georgia, serif';
  ctx.fillText(SUIT_SYMBOLS[card.suit], 16, 60);

  // Bottom-right rank + suit
  ctx.save();
  ctx.translate(canvas.width - 16, canvas.height - 12);
  ctx.rotate(Math.PI);
  ctx.font = 'bold 44px Georgia, serif';
  ctx.fillText(card.rank, 0, 0);
  ctx.font = '36px Georgia, serif';
  ctx.fillText(SUIT_SYMBOLS[card.suit], 0, 48);
  ctx.restore();

  // Centre big suit symbol
  ctx.font = '136px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(SUIT_SYMBOLS[card.suit], canvas.width / 2, canvas.height / 2 - 68);
  ctx.textAlign = 'left';

  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  texture.needsUpdate = true;
  texturesReadyCount++;
  console.log(`TEXTURE READY: ${card.rank}${card.suit.charAt(0).toUpperCase()}`);
  return texture;
}

function generatePlaceholderBackTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 358;
  const ctx = canvas.getContext('2d');

  // Solid crimson/burgundy background
  ctx.fillStyle = '#7a1113';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Gold outer border
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 5;
  roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 16, false, true);

  // Cream inner border
  ctx.strokeStyle = '#f4f1e8';
  ctx.lineWidth = 2;
  roundRect(ctx, 14, 14, canvas.width - 28, canvas.height - 28, 12, false, true);

  // Diamond lattice pattern
  ctx.strokeStyle = 'rgba(244, 241, 232, 0.4)';
  ctx.lineWidth = 2;
  for (let i = -canvas.height; i < canvas.width; i += 18) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + canvas.height, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, canvas.height);
    ctx.lineTo(i + canvas.height, 0);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  texture.needsUpdate = true;
  texturesReadyCount++;
  console.log('TEXTURE READY: BACK');
  return texture;
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

// ----------------------------------------------------------------------------
// 7. PILE SLOTS & BOARD BOUNDS
// ----------------------------------------------------------------------------
function createBoardBounds(container) {
  if (!DEBUG_BOARD) return;
  const existing = document.getElementById('debugBoardBounds');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const box = document.createElement('a-plane');
  box.id = 'debugBoardBounds';
  box.setAttribute('width', BOARD_WIDTH);
  box.setAttribute('height', BOARD_HEIGHT);
  box.setAttribute('position', `0 -0.01 0.002`);
  box.setAttribute('material', 'shader: flat; color: #d4af37; wireframe: true; opacity: 0.8; transparent: true');
  container.appendChild(box);
}

function createPileSlots() {
  const container = document.getElementById('slotsContainer');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  meshToSlot.clear();
  pileSlots.length = 0;

  addSlot(container, 'stock', null, STOCK_POS.x, STOCK_POS.y);
  addSlot(container, 'waste', null, WASTE_POS.x, WASTE_POS.y);
  SUITS.forEach((suit, i) => addSlot(container, 'foundation', suit, FOUNDATION_X[i], FOUNDATION_Y));
  for (let c = 0; c < 7; c++) addSlot(container, 'tableau', c, TABLEAU_X[c], TABLEAU_TOP_Y);

  createBoardBounds(container);
}

function addSlot(container, type, id, x, y) {
  const el = document.createElement('a-plane');
  el.classList.add('pile-slot');
  el.dataset.pileType = type;
  if (id !== null && id !== undefined) {
    el.dataset.pileId = id;
  }
  el.setAttribute('width', CARD_WIDTH);
  el.setAttribute('height', CARD_HEIGHT);
  el.setAttribute('position', `${x} ${y} ${BOARD_Z - 0.004}`);
  el.setAttribute('rotation', '0 0 0');
  el.setAttribute('material', 'shader: flat; color: #ffffff; opacity: 0.20; transparent: true; side: double');

  const slotData = type === 'foundation'
    ? { type: 'foundation', suit: id, index: id, el }
    : { type, index: id, el };

  pileSlots.push(slotData);

  function registerSlotMesh() {
    const mesh = el.getObject3D('mesh');
    if (mesh) {
      mesh.renderOrder = 0;
      meshToSlot.set(mesh.uuid, slotData);
    } else {
      el.addEventListener('loaded', () => {
        const m = el.getObject3D('mesh');
        if (m) {
          m.renderOrder = 0;
          meshToSlot.set(m.uuid, slotData);
        }
      }, { once: true });
    }
  }
  registerSlotMesh();

  container.appendChild(el);
}

// ----------------------------------------------------------------------------
// 8. LAYOUT / RENDERING WITH Z-DEPTH & RENDERORDER
// ----------------------------------------------------------------------------
function computeTableauPositions(col) {
  const positions = [];
  let y = TABLEAU_TOP_Y;
  const pile = tableau[col];
  for (let i = 0; i < pile.length; i++) {
    positions.push({
      x: TABLEAU_X[col],
      y,
      z: BOARD_Z + i * CARD_Z_STEP,
      layer: i,
    });
    y -= pile[i].faceUp ? TABLEAU_FACEUP_STEP : TABLEAU_FACEDOWN_STEP;
  }
  return positions;
}

function renderBoard(instant) {
  stock.forEach((card, i) => {
    setCardTransform(card, { x: STOCK_POS.x, y: STOCK_POS.y, z: BOARD_Z + i * CARD_Z_STEP, layer: i }, instant);
  });

  waste.forEach((card, i) => {
    const fromTop = waste.length - 1 - i;
    const fan = fromTop < 3 ? (2 - fromTop) * 0.018 : 0;
    setCardTransform(card, { x: WASTE_POS.x + fan, y: WASTE_POS.y, z: BOARD_Z + i * CARD_Z_STEP, layer: i }, instant);
  });

  SUITS.forEach((suit, fi) => {
    foundations[suit].forEach((card, i) => {
      setCardTransform(card, { x: FOUNDATION_X[fi], y: FOUNDATION_Y, z: BOARD_Z + i * CARD_Z_STEP, layer: i }, instant);
    });
  });

  for (let col = 0; col < 7; col++) {
    const positions = computeTableauPositions(col);
    tableau[col].forEach((card, i) => setCardTransform(card, positions[i], instant));
  }
}

function setCardTransform(card, pos, instant) {
  const el = card.el;
  if (!el) return;

  updateCardVisual(card);

  const mesh = el.getObject3D('mesh');
  if (mesh) {
    mesh.renderOrder = (pos.layer !== undefined ? pos.layer : 0) + 1;
  }

  if (instant) {
    el.removeAttribute('animation__move');
    el.removeAttribute('animation__lift');
    el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
    el.setAttribute('rotation', '0 0 0');
  } else {
    el.setAttribute('animation__move', `property: position; to: ${pos.x} ${pos.y} ${pos.z}; dur: 320; easing: easeOutQuad`);
  }
}

// ----------------------------------------------------------------------------
// 9. PILE / RUN HELPERS
// ----------------------------------------------------------------------------
function getPileArray(pile) {
  if (pile.type === 'tableau') return tableau[pile.index];
  if (pile.type === 'foundation') return foundations[pile.suit || pile.index];
  if (pile.type === 'waste') return waste;
  if (pile.type === 'stock') return stock;
  return [];
}

function isTopOfPile(card, pile) {
  const arr = getPileArray(pile);
  return arr.length > 0 && arr[arr.length - 1].id === card.id;
}

function isValidRunFrom(col, card) {
  const arr = tableau[col];
  const idx = arr.findIndex((c) => c.id === card.id);
  if (idx === -1 || !arr[idx].faceUp) return false;
  for (let i = idx; i < arr.length - 1; i++) {
    const a = arr[i];
    const b = arr[i + 1];
    if (!a.faceUp || !b.faceUp) return false;
    if (a.color === b.color) return false;
    if (a.rankValue !== b.rankValue + 1) return false;
  }
  return true;
}

function getRunFrom(col, card) {
  const arr = tableau[col];
  const idx = arr.findIndex((c) => c.id === card.id);
  return arr.slice(idx);
}

// ----------------------------------------------------------------------------
// 10. MOVE VALIDATION RULES
// ----------------------------------------------------------------------------
function canPlaceOnTableau(card, destCol) {
  const arr = tableau[destCol];
  if (arr.length === 0) return card.rank === 'K';
  const top = arr[arr.length - 1];
  if (!top.faceUp) return false;
  return top.color !== card.color && top.rankValue === card.rankValue + 1;
}

function canPlaceOnFoundation(card, suit) {
  if (card.suit !== suit) return false;
  const arr = foundations[suit];
  if (!arr || arr.length === 0) return card.rank === 'A';
  const top = arr[arr.length - 1];
  return top.rankValue === card.rankValue - 1;
}

// ----------------------------------------------------------------------------
// 11. SELECTION & FEEDBACK
// ----------------------------------------------------------------------------
function selectCard(card, pile) {
  const run = pile.type === 'tableau' ? getRunFrom(pile.index, card) : [card];
  selected = { card, pile, run };

  run.forEach((c, idx) => {
    c.selected = true;
    const el = c.el;
    let pos = el.getAttribute('position');
    if (typeof pos === 'string') {
      const parts = pos.trim().split(/\s+/).map(Number);
      pos = { x: parts[0] || 0, y: parts[1] || 0, z: parts[2] || 0 };
    } else if (!pos && el.object3D) {
      pos = { x: el.object3D.position.x, y: el.object3D.position.y, z: el.object3D.position.z };
    } else if (!pos) {
      pos = { x: 0, y: 0, z: 0 };
    }

    el.dataset.origX = pos.x;
    el.dataset.origY = pos.y;
    el.dataset.origZ = pos.z;

    const targetY = (parseFloat(pos.y) + SELECT_LIFT_Y).toFixed(4);
    const targetZ = (parseFloat(pos.z) + SELECT_LIFT_Z).toFixed(4);

    const mesh = el.getObject3D('mesh');
    if (mesh) {
      mesh.renderOrder = 200 + idx;
    }

    el.setAttribute('animation__lift', `property: position; to: ${pos.x} ${targetY} ${targetZ}; dur: 140; easing: easeOutQuad`);
    setHighlight(c, true);
  });

  const cardStr = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
  const pileStr = `${pile.type}${pile.index !== undefined ? '[' + pile.index + ']' : pile.suit ? '[' + pile.suit + ']' : ''}`;
  console.log(`SELECTED: ${cardStr}`);
  console.log(`SOURCE: ${pileStr}`);
  updateDebug({
    selected: `YES (${cardStr})`,
  });
}

function deselectCard() {
  if (!selected) return;
  const cardStr = `${selected.card.rank}${SUIT_SYMBOLS[selected.card.suit]}`;

  selected.run.forEach((c) => {
    c.selected = false;
    const el = c.el;
    const origX = el.dataset.origX;
    const origY = el.dataset.origY;
    const origZ = el.dataset.origZ;
    if (origY !== undefined && origZ !== undefined) {
      el.setAttribute('animation__lift', `property: position; to: ${origX} ${origY} ${origZ}; dur: 140; easing: easeOutQuad`);
      setTimeout(() => {
        el.removeAttribute('animation__lift');
      }, 150);
    }
    setHighlight(c, false);
  });

  renderBoard(true); // Re-assigns clean layer renderOrders
  selected = null;
  console.log(`DESELECTED: ${cardStr}`);
  updateDebug({
    selected: 'NO',
  });
}

function clearSelectionForMove(run) {
  run.forEach((c) => {
    c.selected = false;
    c.el.removeAttribute('animation__lift');
    setHighlight(c, false);
  });
}

// ----------------------------------------------------------------------------
// 12. CLICK & ACTION HANDLERS
// ----------------------------------------------------------------------------
function onCardClicked(card) {
  const pile = card.location;
  if (!pile) return;

  // Stock tap draws immediately
  if (pile.type === 'stock') {
    drawFromStock();
    return;
  }

  // Face-down cards in tableau cannot be selected or targeted
  if (!card.faceUp) return;

  if (!selected) {
    if (pile.type === 'foundation' && !isTopOfPile(card, pile)) return;
    if (pile.type === 'waste' && !isTopOfPile(card, pile)) return;
    if (pile.type === 'tableau' && !isValidRunFrom(pile.index, card)) return;
    selectCard(card, pile);
    return;
  }

  // Tap already-selected card cancels selection
  if (selected.card === card) {
    deselectCard();
    return;
  }

  // Second tap on a different card uses that card's location as destination
  attemptMove(selected, card.location);
}

function handlePileClick(pile) {
  if (pile.type === 'stock') {
    drawFromStock();
    return;
  }
  if (!selected) return;
  attemptMove(selected, pile);
}

// ----------------------------------------------------------------------------
// 13. MOVE EXECUTION
// ----------------------------------------------------------------------------
function attemptMove(sel, destPile) {
  const { run, pile: srcPile } = sel;
  const cardStr = `${sel.card.rank}${SUIT_SYMBOLS[sel.card.suit]}`;
  const destSuit = destPile.suit || destPile.index;
  const srcSuit = srcPile.suit || srcPile.index;

  const destStr = `${destPile.type}${destPile.index !== undefined ? '[' + destPile.index + ']' : destPile.suit ? '[' + destPile.suit + ']' : ''}`;
  console.log(`DESTINATION: ${destStr}`);
  console.log(`MOVE: ${cardStr} → ${destStr}`);

  const isSamePile = destPile.type === srcPile.type && (
    destPile.type === 'foundation'
      ? destSuit === srcSuit
      : destPile.type === 'tableau'
      ? String(destPile.index) === String(srcPile.index)
      : true
  );

  if (isSamePile) {
    console.log('VALID: false (same pile, canceling)');
    deselectCard();
    return;
  }

  let valid = false;
  if (destPile.type === 'foundation' && run.length === 1 && canPlaceOnFoundation(run[0], destSuit)) {
    valid = true;
  } else if (destPile.type === 'tableau' && canPlaceOnTableau(run[0], destPile.index)) {
    valid = true;
  }

  console.log(`VALID: ${valid}`);
  if (valid) {
    clearSelectionForMove(run);
    moveCardsToPile(run, srcPile, destPile);
    selected = null;
    checkAutoFlipTableauTop(srcPile);
    checkWinCondition();
  } else {
    deselectCard();
  }
}

function moveCardsToPile(run, srcPile, destPile) {
  const srcArr = getPileArray(srcPile);
  run.forEach((c) => {
    const i = srcArr.indexOf(c);
    if (i > -1) srcArr.splice(i, 1);
  });

  const destArr = getPileArray(destPile);
  const destSuit = destPile.suit || destPile.index;
  run.forEach((c) => {
    c.location = destPile.type === 'foundation'
      ? { type: 'foundation', suit: destSuit, index: destSuit }
      : { type: destPile.type, index: destPile.index };
    destArr.push(c);
  });

  renderBoard(false);
}

function checkAutoFlipTableauTop(pile) {
  if (pile.type !== 'tableau') return;
  const arr = tableau[pile.index];
  if (arr.length === 0) return;
  const top = arr[arr.length - 1];
  if (!top.faceUp) {
    top.faceUp = true;
    updateCardVisual(top);
    renderBoard(false);
  }
}

// ----------------------------------------------------------------------------
// 14. STOCK / WASTE
// ----------------------------------------------------------------------------
function drawFromStock() {
  if (selected) deselectCard();

  if (stock.length === 0) {
    if (waste.length === 0) return;
    while (waste.length) {
      const c = waste.pop();
      c.faceUp = false;
      c.location = { type: 'stock' };
      stock.push(c);
    }
    renderBoard(false);
    console.log('STOCK: Recycled waste to stock');
    return;
  }

  const card = stock.pop();
  card.faceUp = true;
  card.location = { type: 'waste' };
  waste.push(card);
  renderBoard(false);
  const cardStr = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
  console.log(`STOCK: Drew ${cardStr}`);
}

// ----------------------------------------------------------------------------
// 15. WIN CONDITION
// ----------------------------------------------------------------------------
function checkWinCondition() {
  const won = SUITS.every((s) => foundations[s].length === 13);
  if (won) {
    const win = document.getElementById('winMessage');
    if (win) win.style.display = 'flex';
  }
}

// ----------------------------------------------------------------------------
// 16. MANUAL TOUCH & RAYCASTING PIPELINE (SINGLE MESH PER CARD)
// ----------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
let isHandlingTap = false;
let lastTapProcessedTime = 0;
let tapStartPos = null;
let tapStartTime = 0;

function getInteractiveMeshes() {
  const meshes = [];

  // Active pile slots
  pileSlots.forEach((slotData) => {
    const mesh = slotData.el ? slotData.el.getObject3D('mesh') : null;
    if (!mesh) return;

    let isTargetable = false;
    if (slotData.type === 'stock') {
      isTargetable = true; // Always targetable to draw or recycle
    } else if (slotData.type === 'waste') {
      isTargetable = waste.length === 0;
    } else if (slotData.type === 'tableau') {
      isTargetable = tableau[slotData.index] && tableau[slotData.index].length === 0;
    } else if (slotData.type === 'foundation') {
      isTargetable = foundations[slotData.suit] && foundations[slotData.suit].length === 0;
    }

    if (isTargetable) {
      meshes.push(mesh);
    }
  });

  // Active cards: face-up cards + top card of stock
  deck.forEach((card) => {
    if (!card.el) return;
    const mesh = card.el.getObject3D('mesh');
    if (!mesh) return;

    const isStockTop = card.location && card.location.type === 'stock' && isTopOfPile(card, card.location);
    if (card.faceUp || isStockTop) {
      meshes.push(mesh);
    }
  });

  return meshes;
}

function performRaycast(clientX, clientY) {
  const scene = document.querySelector('a-scene');
  if (!scene || !scene.camera || !scene.canvas) return;

  const canvas = scene.canvas;
  const camera = scene.camera;
  const rect = canvas.getBoundingClientRect();

  if (
    clientX < rect.left || clientX > rect.right ||
    clientY < rect.top || clientY > rect.bottom
  ) {
    return;
  }

  // Exact Normalized Device Coordinates relative to WebGL canvas
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);

  const candidateMeshes = getInteractiveMeshes();
  if (candidateMeshes.length === 0) return;

  const hits = raycaster.intersectObjects(candidateMeshes, false);

  updateDebug({
    pointer: `${Math.round(clientX)}, ${Math.round(clientY)}`,
    ndc: `${ndcX.toFixed(2)}, ${ndcY.toFixed(2)}`,
    hits: hits.length
  });

  if (hits.length === 0) {
    updateDebug({ hitObject: 'NONE', card: 'NONE' });
    return;
  }

  // Sorted by distance: hits[0] is physically closest top-most card
  const hitMesh = hits[0].object;
  const card = meshToCard.get(hitMesh.uuid);
  const slot = meshToSlot.get(hitMesh.uuid);

  updateDebug({
    hitObject: card ? `card-${card.id}` : slot ? `slot-${slot.type}` : hitMesh.uuid.slice(0, 8)
  });

  if (card) {
    const cardStr = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
    updateDebug({
      card: `${cardStr} (${card.location ? card.location.type : '?'})`
    });
    onCardClicked(card);
  } else if (slot) {
    const slotStr = `${slot.type}${slot.index !== undefined ? '[' + slot.index + ']' : slot.suit ? '[' + slot.suit + ']' : ''}`;
    updateDebug({
      card: slotStr
    });
    handlePileClick(slot);
  }
}

function setupManualRaycasting() {
  function onTouchStart(e) {
    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      return;
    }
    if (e.touches && e.touches.length > 0) {
      tapStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      tapStartTime = performance.now();
    }
  }

  function onTouchEnd(e) {
    if (!tapStartPos) return;
    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      tapStartPos = null;
      return;
    }
    const touch = e.changedTouches && e.changedTouches.length > 0 ? e.changedTouches[0] : null;
    if (!touch) {
      tapStartPos = null;
      return;
    }

    const dist = Math.hypot(touch.clientX - tapStartPos.x, touch.clientY - tapStartPos.y);
    const dt = performance.now() - tapStartTime;
    tapStartPos = null;

    if (dist > 28 || dt > 650) return;

    const now = performance.now();
    if (isHandlingTap || now - lastTapProcessedTime < 320) return;
    isHandlingTap = true;
    lastTapProcessedTime = now;

    try {
      performRaycast(touch.clientX, touch.clientY);
    } finally {
      setTimeout(() => { isHandlingTap = false; }, 100);
    }
  }

  function onPointerDown(e) {
    if (e.pointerType === 'touch') return;
    if (e.isPrimary === false) return;
    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      return;
    }
    tapStartPos = { x: e.clientX, y: e.clientY };
    tapStartTime = performance.now();
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') return;
    if (e.isPrimary === false || !tapStartPos) return;
    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      tapStartPos = null;
      return;
    }

    const dist = Math.hypot(e.clientX - tapStartPos.x, e.clientY - tapStartPos.y);
    const dt = performance.now() - tapStartTime;
    tapStartPos = null;

    if (dist > 25 || dt > 650) return;

    const now = performance.now();
    if (isHandlingTap || now - lastTapProcessedTime < 320) return;
    isHandlingTap = true;
    lastTapProcessedTime = now;

    try {
      performRaycast(e.clientX, e.clientY);
    } finally {
      setTimeout(() => { isHandlingTap = false; }, 100);
    }
  }

  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });

  window.addEventListener('resize', () => {
    const scene = document.querySelector('a-scene');
    if (scene && scene.camera && scene.canvas) {
      const rect = scene.canvas.getBoundingClientRect();
      console.log(`RESIZE: Canvas is ${rect.width}x${rect.height}`);
    }
  });

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      const scene = document.querySelector('a-scene');
      if (scene && scene.camera && scene.canvas) {
        const rect = scene.canvas.getBoundingClientRect();
        console.log(`ORIENTATION CHANGE: Canvas is ${rect.width}x${rect.height}`);
      }
    }, 200);
  });

  const targetEl = document.querySelector('[mindar-image-target]');
  if (targetEl) {
    targetEl.addEventListener('targetFound', () => {
      console.log('AR: Target Found');
      updateDebug({ tracking: '<span class="status-tracking">TRACKING</span>' });
    });
    targetEl.addEventListener('targetLost', () => {
      console.log('AR: Target Lost');
      updateDebug({ tracking: '<span class="status-searching">SEARCHING</span>' });
    });
  }
}

// ----------------------------------------------------------------------------
// 17. CONTROLLED SCENARIO INTERACTION TEST SUITE
// ----------------------------------------------------------------------------
window.runSolitaireInteractionTests = function() {
  console.log('=== STARTING CONTROLLED SOLITAIRE INTERACTION TESTS ===');
  let passed = 0;
  const total = 7;

  dealNewGame();

  // Test 1: Tap visible tableau card
  const t1Card = tableau[0][0];
  onCardClicked(t1Card);
  const pass1 = selected && selected.card === t1Card;
  console.log(`[Test 1] Select visible tableau card (${t1Card.rank}${t1Card.suit}): ${pass1 ? 'PASS' : 'FAIL'}`);
  if (pass1) passed++;

  // Test 2: Tap same card again -> cancels
  onCardClicked(t1Card);
  const pass2 = selected === null;
  console.log(`[Test 2] Cancel selection by tapping same card: ${pass2 ? 'PASS' : 'FAIL'}`);
  if (pass2) passed++;

  // Test 3: Tap stock -> moves 1 card to waste
  const stockBefore = stock.length;
  const wasteBefore = waste.length;
  drawFromStock();
  const pass3 = stock.length === stockBefore - 1 && waste.length === wasteBefore + 1;
  console.log(`[Test 3] Draw from stock: ${pass3 ? 'PASS' : 'FAIL'}`);
  if (pass3) passed++;

  // Test 4: Tap waste card -> selects
  const topWaste = waste[waste.length - 1];
  onCardClicked(topWaste);
  const pass4 = selected && selected.card === topWaste;
  console.log(`[Test 4] Select top waste card: ${pass4 ? 'PASS' : 'FAIL'}`);
  if (pass4) passed++;
  deselectCard();

  // Test 5: Valid tableau move (place Red 8 onto Black 9)
  const red8 = deck.find((c) => c.rank === '8' && c.color === 'red');
  const black9 = deck.find((c) => c.rank === '9' && c.color === 'black');
  tableau[1] = [black9]; black9.faceUp = true; black9.location = { type: 'tableau', index: 1 };
  tableau[2] = [red8]; red8.faceUp = true; red8.location = { type: 'tableau', index: 2 };
  onCardClicked(red8);
  onCardClicked(black9);
  const pass5 = tableau[1].length === 2 && tableau[1][1] === red8 && tableau[2].length === 0;
  console.log(`[Test 5] Valid tableau move (8 onto 9): ${pass5 ? 'PASS' : 'FAIL'}`);
  if (pass5) passed++;

  // Test 6: Invalid move (place 10 onto 8) -> cancels
  const red10 = deck.find((c) => c.rank === '10' && c.color === 'red');
  tableau[3] = [red10]; red10.faceUp = true; red10.location = { type: 'tableau', index: 3 };
  onCardClicked(red10);
  onCardClicked(red8);
  const pass6 = selected === null && tableau[3].includes(red10);
  console.log(`[Test 6] Invalid move rejection: ${pass6 ? 'PASS' : 'FAIL'}`);
  if (pass6) passed++;

  // Test 7: Empty tableau accepts King only
  tableau[4] = [];
  const nonKing = deck.find((c) => c.rank === '5');
  tableau[5] = [nonKing]; nonKing.faceUp = true; nonKing.location = { type: 'tableau', index: 5 };
  onCardClicked(nonKing);
  handlePileClick({ type: 'tableau', index: 4 });
  const rejectedNonKing = tableau[4].length === 0 && selected === null;

  const king = deck.find((c) => c.rank === 'K');
  tableau[5] = [king]; king.faceUp = true; king.location = { type: 'tableau', index: 5 };
  onCardClicked(king);
  handlePileClick({ type: 'tableau', index: 4 });
  const acceptedKing = tableau[4].length === 1 && tableau[4][0] === king;

  const pass7 = rejectedNonKing && acceptedKing;
  console.log(`[Test 7] Empty tableau King validation: ${pass7 ? 'PASS' : 'FAIL'}`);
  if (pass7) passed++;

  console.log(`=== TEST SUMMARY: ${passed}/${total} PASSED ===`);
  dealNewGame();
  return passed === total;
};

// ----------------------------------------------------------------------------
// 18. BOOTSTRAP
// ----------------------------------------------------------------------------
function init() {
  createPileSlots();
  setupManualRaycasting();
  const newGameBtn = document.getElementById('newGameBtn');
  if (newGameBtn) newGameBtn.addEventListener('click', dealNewGame);
  window.dealNewGame = dealNewGame;
  dealNewGame();
}

const sceneEl = document.querySelector('a-scene');
if (sceneEl.hasLoaded) {
  init();
} else {
  sceneEl.addEventListener('loaded', init);
}
