/* ============================================================================
   AR KLONDIKE SOLITAIRE — game.js
   ============================================================================
   Architecture:
   1. CARD MODEL     — Plain JS objects {suit, rank, rankValue, color, faceUp,
                         location, el, frontEl, backEl, hitEl, isInteractive}.
   2. 3D CARDS       — Wrapper entity containing front plane, back plane, and
                         a transparent interaction hitbox.
   3. MESH MAPPING   — Robust mesh.uuid -> card / slot Maps for instant,
                         unambiguous resolution without fragile DOM traversal.
   4. INTERACTION    — Coordinated touch / pointer pipeline with tap validation,
                         debounce, and interaction locks to prevent ghost clicks.
   5. COORDINATES    — Strict NDC calculation against the actual A-Frame canvas.
   ========================================================================== */

// ----------------------------------------------------------------------------
// 0. CONFIG & DEBUG
// ----------------------------------------------------------------------------
const DEBUG_AR = true; // Enables real-time diagnostics overlay on phone

const CONFIG = {
  useImageTextures: false,
  cardImagePath: 'assets/cards/',
  cardBackImage: 'assets/back.png',
};

// ----------------------------------------------------------------------------
// 1. CONSTANTS — suits, ranks, and the 3D table layout
// ----------------------------------------------------------------------------
const BOARD_SCALE = 0.72; // Global scale applied to #gameBoard

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const SUIT_SYMBOLS = { hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663', spades: '\u2660' };
const SUIT_COLORS = { hearts: 'red', diamonds: 'red', clubs: 'black', spades: 'black' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUES = RANKS.reduce((map, r, i) => { map[r] = i + 1; return map; }, {});

// Card footprint, in target-local units. Standard poker card ~2.5:3.5.
const CARD_WIDTH = 0.11;
const CARD_HEIGHT = 0.154;

// Horizontal spacing between the 7 tableau columns / top-row piles.
const COL_GAP = 0.115;
const TABLEAU_X = [-3, -2, -1, 0, 1, 2, 3].map((n) => n * COL_GAP);

// Vertical cascade: how far down (in Y) each successive tableau card sits.
const TABLEAU_TOP_Y = -0.02;
const TABLEAU_FACEDOWN_STEP = 0.018;
const TABLEAU_FACEUP_STEP = 0.040;

// Top row: Stock | Waste | (gap) | Foundation x4
const TOP_ROW_Y = 0.28;
const STOCK_POS = { x: TABLEAU_X[0], y: TOP_ROW_Y };
const WASTE_POS = { x: TABLEAU_X[1], y: TOP_ROW_Y };
const FOUNDATION_X = [TABLEAU_X[3], TABLEAU_X[4], TABLEAU_X[5], TABLEAU_X[6]];
const FOUNDATION_Y = TOP_ROW_Y;

// Stable Z-depth ordering
const CARD_Z_STEP = 0.006;
const PLANE_Z_OFFSET = 0.0015;

// Selection lift
const SELECT_LIFT_Y = 0.015;
const SELECT_LIFT_Z = 0.025;

// ----------------------------------------------------------------------------
// 2. GAME STATE & MAPPINGS
// ----------------------------------------------------------------------------
let deck = [];
let tableau = [[], [], [], [], [], [], []];
let stock = [];
let waste = [];
let foundations = { hearts: [], diamonds: [], clubs: [], spades: [] };

// The current selection: { card, pile, run }
let selected = null;

// Direct mapping from Three.js mesh.uuid -> Card or Pile Slot
const meshToCard = new Map();
const meshToSlot = new Map();
const pileSlots = [];

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
  if (data.hitType !== undefined) {
    const el = document.getElementById('debugHitType');
    if (el) el.textContent = data.hitType;
  }
  if (data.card !== undefined) {
    const el = document.getElementById('debugCard');
    if (el) el.textContent = data.card;
  }
  if (data.selected !== undefined) {
    const el = document.getElementById('debugSelected');
    if (el) el.textContent = data.selected;
  }
  if (data.action !== undefined) {
    const el = document.getElementById('debugAction');
    if (el) el.textContent = data.action;
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
        el: null,
        frontEl: null,
        backEl: null,
        hitEl: null,
        isInteractive: false,
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
    card: 'DEALT',
    selected: 'NO',
    action: 'New Game Started'
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
// 5. 3D CARD ENTITY CREATION & INTERACTION COLLIDERS
// ----------------------------------------------------------------------------
function createCardEntity(card) {
  const wrapper = document.createElement('a-entity');
  wrapper.id = 'card-' + card.id;
  wrapper.classList.add('card-wrapper');
  wrapper.dataset.cardId = card.id;

  // Front plane (visible when faceUp)
  const front = document.createElement('a-plane');
  front.classList.add('card-front');
  front.setAttribute('width', CARD_WIDTH);
  front.setAttribute('height', CARD_HEIGHT);
  front.setAttribute('position', `0 0 ${PLANE_Z_OFFSET}`);
  front.setAttribute('visible', card.faceUp);
  front.setAttribute('material', 'shader: flat; side: front');

  // Back plane (visible when !faceUp)
  const back = document.createElement('a-plane');
  back.classList.add('card-back');
  back.setAttribute('width', CARD_WIDTH);
  back.setAttribute('height', CARD_HEIGHT);
  back.setAttribute('rotation', '0 180 0');
  back.setAttribute('position', `0 0 ${-PLANE_Z_OFFSET}`);
  back.setAttribute('visible', !card.faceUp);
  back.setAttribute('material', 'shader: flat; side: front; color: #8B0000');

  // Dedicated transparent interaction hitbox covering full card surface
  const hit = document.createElement('a-plane');
  hit.classList.add('card-hitbox');
  hit.setAttribute('width', (CARD_WIDTH * 1.08).toFixed(4));
  hit.setAttribute('height', (CARD_HEIGHT * 1.08).toFixed(4));
  hit.setAttribute('position', `0 0 ${PLANE_Z_OFFSET + 0.001}`);
  hit.setAttribute('material', 'shader: flat; transparent: true; opacity: 0.001; depthWrite: false; side: double');
  hit.setAttribute('visible', card.faceUp || (card.location && card.location.type === 'stock'));

  wrapper.appendChild(front);
  wrapper.appendChild(back);
  wrapper.appendChild(hit);

  // Register in meshToCard map for instant O(1) resolution on raycast hits
  function registerMesh(el) {
    const mesh = el.getObject3D('mesh');
    if (mesh) {
      meshToCard.set(mesh.uuid, card);
    } else {
      el.addEventListener('loaded', () => {
        const m = el.getObject3D('mesh');
        if (m) meshToCard.set(m.uuid, card);
      }, { once: true });
    }
  }

  registerMesh(front);
  registerMesh(back);
  registerMesh(hit);

  // Apply textures
  front.addEventListener('loaded', () => applyTexture(front, getFrontTexture(card)));
  back.addEventListener('loaded', () => applyTexture(back, getBackTexture()));

  card.el = wrapper;
  card.frontEl = front;
  card.backEl = back;
  card.hitEl = hit;
  return wrapper;
}

function updateCardInteraction(card) {
  if (!card || !card.el) return;
  const isStock = card.location && card.location.type === 'stock';
  card.isInteractive = card.faceUp || isStock;

  if (card.frontEl) card.frontEl.setAttribute('visible', card.faceUp);
  if (card.backEl) card.backEl.setAttribute('visible', !card.faceUp);
  if (card.hitEl) card.hitEl.setAttribute('visible', card.isInteractive);
}

function applyTexture(planeEl, texture) {
  const mesh = planeEl.getObject3D('mesh');
  if (mesh && mesh.material) {
    mesh.material.map = texture;
    mesh.material.color.set(0xffffff);
    mesh.material.depthTest = true;
    mesh.material.depthWrite = true;
    mesh.material.needsUpdate = true;
  } else {
    setTimeout(() => applyTexture(planeEl, texture), 50);
  }
}

function setHighlight(card, on) {
  [card.frontEl, card.backEl].forEach((el) => {
    if (!el) return;
    const mesh = el.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.color.set(on ? 0xffd54f : 0xffffff);
      mesh.material.needsUpdate = true;
    }
  });
}

// ----------------------------------------------------------------------------
// 6. TEXTURE GENERATION
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
  const color = card.color === 'red' ? '#c81e1e' : '#111111';

  ctx.fillStyle = '#fbfbf7';
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 20, true, false);
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 3;
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 20, false, true);

  ctx.fillStyle = color;
  ctx.textBaseline = 'top';

  // Top-left rank + suit
  ctx.font = 'bold 42px Georgia, serif';
  ctx.fillText(card.rank, 16, 12);
  ctx.font = '34px Georgia, serif';
  ctx.fillText(SUIT_SYMBOLS[card.suit], 16, 58);

  // Bottom-right rank + suit
  ctx.save();
  ctx.translate(canvas.width - 16, canvas.height - 12);
  ctx.rotate(Math.PI);
  ctx.font = 'bold 42px Georgia, serif';
  ctx.fillText(card.rank, 0, 0);
  ctx.font = '34px Georgia, serif';
  ctx.fillText(SUIT_SYMBOLS[card.suit], 0, 46);
  ctx.restore();

  // Centre suit symbol
  ctx.font = '130px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(SUIT_SYMBOLS[card.suit], canvas.width / 2, canvas.height / 2 - 65);
  ctx.textAlign = 'left';

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function generatePlaceholderBackTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 358;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#7a1414';
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 20, true, false);
  ctx.strokeStyle = '#f4f1e8';
  ctx.lineWidth = 6;
  roundRect(ctx, 14, 14, canvas.width - 28, canvas.height - 28, 14, false, true);

  ctx.strokeStyle = 'rgba(244,241,232,0.35)';
  ctx.lineWidth = 2;
  for (let i = -canvas.height; i < canvas.width; i += 16) {
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
  texture.needsUpdate = true;
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
// 7. PILE SLOTS — Click targets for empty piles
// ----------------------------------------------------------------------------
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
}

function addSlot(container, type, id, x, y) {
  const el = document.createElement('a-plane');
  el.classList.add('pile-slot');
  el.dataset.pileType = type;
  if (id !== null && id !== undefined) {
    el.dataset.pileId = id;
  }
  el.setAttribute('width', (CARD_WIDTH * 1.06).toFixed(4));
  el.setAttribute('height', (CARD_HEIGHT * 1.06).toFixed(4));
  el.setAttribute('position', `${x} ${y} -0.005`);
  el.setAttribute('material', 'shader: flat; color: #ffffff; opacity: 0.15; transparent: true; side: double');

  const slotData = type === 'foundation'
    ? { type: 'foundation', suit: id, index: id, el }
    : { type, index: id, el };

  pileSlots.push(slotData);

  function registerSlotMesh() {
    const mesh = el.getObject3D('mesh');
    if (mesh) {
      meshToSlot.set(mesh.uuid, slotData);
    } else {
      el.addEventListener('loaded', () => {
        const m = el.getObject3D('mesh');
        if (m) meshToSlot.set(m.uuid, slotData);
      }, { once: true });
    }
  }
  registerSlotMesh();

  container.appendChild(el);
}

// ----------------------------------------------------------------------------
// 8. LAYOUT / RENDERING
// ----------------------------------------------------------------------------
function computeTableauPositions(col) {
  const positions = [];
  let y = TABLEAU_TOP_Y;
  const pile = tableau[col];
  for (let i = 0; i < pile.length; i++) {
    positions.push({ x: TABLEAU_X[col], y, z: i * CARD_Z_STEP });
    y -= pile[i].faceUp ? TABLEAU_FACEUP_STEP : TABLEAU_FACEDOWN_STEP;
  }
  return positions;
}

function renderBoard(instant) {
  stock.forEach((card, i) => {
    setCardTransform(card, { x: STOCK_POS.x, y: STOCK_POS.y, z: i * CARD_Z_STEP }, false, instant);
  });

  waste.forEach((card, i) => {
    const fromTop = waste.length - 1 - i;
    const fan = fromTop < 3 ? (2 - fromTop) * 0.016 : 0;
    setCardTransform(card, { x: WASTE_POS.x + fan, y: WASTE_POS.y, z: i * CARD_Z_STEP }, true, instant);
  });

  SUITS.forEach((suit, fi) => {
    foundations[suit].forEach((card, i) => {
      setCardTransform(card, { x: FOUNDATION_X[fi], y: FOUNDATION_Y, z: i * CARD_Z_STEP }, true, instant);
    });
  });

  for (let col = 0; col < 7; col++) {
    const positions = computeTableauPositions(col);
    tableau[col].forEach((card, i) => setCardTransform(card, positions[i], card.faceUp, instant));
  }
}

function applyDepthBias(card, layer) {
  [card.frontEl, card.backEl].forEach((el) => {
    if (!el) return;
    const mesh = el.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.depthTest = true;
      mesh.material.depthWrite = true;
      mesh.material.polygonOffset = true;
      mesh.material.polygonOffsetFactor = -0.5;
      mesh.material.polygonOffsetUnits = -1;
    }
  });
}

function setCardTransform(card, pos, faceUp, instant) {
  const el = card.el;
  if (!el) return;
  const targetRotation = faceUp ? '0 0 0' : '0 180 0';

  updateCardInteraction(card);
  applyDepthBias(card, Math.round(pos.z / CARD_Z_STEP));

  if (instant) {
    el.removeAttribute('animation__move');
    el.removeAttribute('animation__flip');
    el.removeAttribute('animation__lift');
    el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
    el.setAttribute('rotation', targetRotation);
  } else {
    // Keep both faces visible during 3D flip animation
    if (card.frontEl) card.frontEl.setAttribute('visible', true);
    if (card.backEl) card.backEl.setAttribute('visible', true);
    el.setAttribute('animation__move', `property: position; to: ${pos.x} ${pos.y} ${pos.z}; dur: 350; easing: easeOutQuad`);
    el.setAttribute('animation__flip', `property: rotation; to: ${targetRotation}; dur: 300; easing: easeInOutQuad`);
    setTimeout(() => {
      updateCardInteraction(card);
    }, 320);
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
  run.forEach((c) => {
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
    el.setAttribute('animation__lift', `property: position; to: ${pos.x} ${targetY} ${targetZ}; dur: 150; easing: easeOutQuad`);
    setHighlight(c, true);
  });

  const cardStr = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
  const pileStr = `${pile.type}${pile.index !== undefined ? '[' + pile.index + ']' : pile.suit ? '[' + pile.suit + ']' : ''}`;
  console.log(`SELECTED: ${cardStr}`);
  console.log(`SOURCE: ${pileStr}`);
  updateDebug({
    selected: `YES (${cardStr})`,
    action: `Selected ${cardStr} from ${pileStr}`
  });
}

function deselectCard() {
  if (!selected) return;
  const cardStr = `${selected.card.rank}${SUIT_SYMBOLS[selected.card.suit]}`;
  selected.run.forEach((c) => {
    const el = c.el;
    const origX = el.dataset.origX;
    const origY = el.dataset.origY;
    const origZ = el.dataset.origZ;
    if (origY !== undefined && origZ !== undefined) {
      el.setAttribute('animation__lift', `property: position; to: ${origX} ${origY} ${origZ}; dur: 150; easing: easeOutQuad`);
      setTimeout(() => {
        el.removeAttribute('animation__lift');
      }, 160);
    }
    setHighlight(c, false);
  });
  selected = null;
  console.log(`DESELECTED: ${cardStr}`);
  updateDebug({
    selected: 'NO',
    action: `Deselected ${cardStr}`
  });
}

function clearSelectionForMove(run) {
  run.forEach((c) => {
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

  // Face-down tableau cards cannot be selected or targeted
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
    updateDebug({
      selected: 'NO',
      action: `Moved ${cardStr} to ${destStr}`
    });
  } else {
    deselectCard();
    updateDebug({
      selected: 'NO',
      action: `Invalid move: ${cardStr} to ${destStr}`
    });
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
    updateDebug({ action: 'Stock recycled' });
    return;
  }

  const card = stock.pop();
  card.faceUp = true;
  card.location = { type: 'waste' };
  waste.push(card);
  renderBoard(false);
  const cardStr = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
  console.log(`STOCK: Drew ${cardStr}`);
  updateDebug({ action: `Drew ${cardStr}` });
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
// 16. MANUAL TOUCH & RAYCASTING PIPELINE
// ----------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
let isHandlingTap = false;
let lastTapProcessedTime = 0;
let tapStartPos = null;
let tapStartTime = 0;

function getInteractiveMeshes() {
  const meshes = [];

  // 1. Pile slots: Stock always; others only when empty
  pileSlots.forEach((slotData) => {
    const mesh = slotData.el ? slotData.el.getObject3D('mesh') : null;
    if (!mesh) return;

    let isTargetable = false;
    if (slotData.type === 'stock') {
      isTargetable = true;
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

  // 2. Interactive cards:
  deck.forEach((card) => {
    if (!card.el) return;
    updateCardInteraction(card);

    if (card.isInteractive) {
      const hitMesh = card.hitEl ? card.hitEl.getObject3D('mesh') : null;
      if (hitMesh) {
        meshes.push(hitMesh);
      } else {
        const fallback = card.faceUp
          ? (card.frontEl ? card.frontEl.getObject3D('mesh') : null)
          : (card.backEl ? card.backEl.getObject3D('mesh') : null);
        if (fallback) meshes.push(fallback);
      }
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
    updateDebug({ hitType: 'MISS', card: 'NONE' });
    return;
  }

  // Find the mapped Card or Slot from the closest hit
  const hitObj = hits[0].object;
  let card = null;
  let slot = null;
  let curr = hitObj;

  while (curr) {
    if (meshToCard.has(curr.uuid)) {
      card = meshToCard.get(curr.uuid);
      break;
    }
    if (meshToSlot.has(curr.uuid)) {
      slot = meshToSlot.get(curr.uuid);
      break;
    }
    curr = curr.parent;
  }

  if (card) {
    const cardStr = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
    updateDebug({
      hitType: 'CARD',
      card: `${cardStr} (${card.location ? card.location.type : '?'})`
    });
    onCardClicked(card);
  } else if (slot) {
    const slotStr = `${slot.type}${slot.index !== undefined ? '[' + slot.index + ']' : slot.suit ? '[' + slot.suit + ']' : ''}`;
    updateDebug({
      hitType: 'SLOT',
      card: slotStr
    });
    handlePileClick(slot);
  } else {
    updateDebug({ hitType: 'UNMAPPED', card: 'NONE' });
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

    // Generous tap threshold for mobile screens
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
    if (e.pointerType === 'touch') return; // Touch devices handled by onTouchStart
    if (e.isPrimary === false) return;
    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      return;
    }
    tapStartPos = { x: e.clientX, y: e.clientY };
    tapStartTime = performance.now();
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') return; // Handled by onTouchEnd
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

  // Handle MindAR tracking events
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

  // Initialize fresh board
  dealNewGame();

  // Test 1: Tap visible tableau card -> highlights
  const t1Card = tableau[0][0];
  onCardClicked(t1Card);
  const pass1 = selected && selected.card === t1Card;
  console.log(`[Test 1] Select visible tableau card (${t1Card.rank}${t1Card.suit}): ${pass1 ? 'PASS' : 'FAIL'}`);
  if (pass1) passed++;

  // Test 2: Tap same card again -> deselects
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
  onCardClicked(red8); // Invalid
  const pass6 = selected === null && tableau[3].includes(red10);
  console.log(`[Test 6] Invalid move rejection: ${pass6 ? 'PASS' : 'FAIL'}`);
  if (pass6) passed++;

  // Test 7: Empty tableau accepts King only
  tableau[4] = []; // Empty
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
  dealNewGame(); // Restore board
  return passed === total;
};

// ----------------------------------------------------------------------------
// 18. BOOTSTRAP
// ----------------------------------------------------------------------------
function applyBoardScale() {
  const board = document.getElementById('gameBoard');
  if (board) {
    board.setAttribute('scale', `${BOARD_SCALE} ${BOARD_SCALE} ${BOARD_SCALE}`);
  }
}

function init() {
  applyBoardScale();
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
