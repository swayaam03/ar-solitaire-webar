/* ============================================================================
   AR KLONDIKE SOLITAIRE — game.js
   ============================================================================
   Architecture overview (useful for your report):

   1. CARD MODEL      — plain JS objects {suit, rank, rankValue, color,
                         faceUp, location, el, frontEl, backEl}. There is no
                         3D engine state duplicated anywhere else; the arrays
                         below (tableau/stock/waste/foundations) are the
                         single source of truth for the game, and renderBoard()
                         is the only place that pushes that state out to the
                         3D scene.

   2. 3D CARDS        — each card is an <a-entity> "wrapper" with two
                         <a-plane> children (front + back). The wrapper's
                         Y rotation is toggled between 0° (front facing the
                         camera) and 180° (back facing the camera) to
                         represent face-up / face-down — this is exactly the
                         technique the original index.html used to flip the
                         sample glTF card, just applied to two flat planes.

   3. TEXTURES        — card faces are generated at runtime onto <canvas>
                         elements and uploaded to three.js as CanvasTextures.
                         This means the game works with zero external image
                         assets. See CONFIG + getFrontTexture/getBackTexture
                         for the one place to swap in your own artwork.

   4. COORDINATE SPACE — all positions are in the local space of the MindAR
                         image-target entity, i.e. "meters" relative to the
                         size of your printed marker. X = right, Y = up the
                         page, Z = out of the page toward the camera. Cards
                         stacked in the same pile are given tiny increasing
                         Z offsets so the raycaster (and your eyes) always
                         pick the top card first.

   5. INTERACTION      — "tap-to-select, tap-to-move". A single global
                         `selected` variable holds the currently lifted
                         card/run. Every clickable object (card faces + the
                         empty "pile slot" markers) has its own click
                         listener that resolves to either onCardClicked() or
                         handlePileClick().
   ========================================================================== */

// ----------------------------------------------------------------------------
// 0. CONFIG — the ONE place to look if you want to use your own card art
// ----------------------------------------------------------------------------
const CONFIG = {
  // Set to true once you have real card images and want to stop using the
  // generated placeholder textures.
  useImageTextures: false,

  // Only used when useImageTextures = true. Files are expected to be named
  // "<RANK><SUIT-INITIAL>.png", e.g. "AS.png" (Ace of Spades), "10H.png"
  // (Ten of Hearts), "KD.png" (King of Diamonds). Change buildImageUrl()
  // below if you want a different naming convention or a texture atlas.
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

// Card footprint, in target-local units. A standard poker card is ~2.5:3.5.
const CARD_WIDTH = 0.11;
const CARD_HEIGHT = 0.154;

// Horizontal spacing between the 7 tableau columns / top-row piles.
const COL_GAP = 0.115;
const TABLEAU_X = [-3, -2, -1, 0, 1, 2, 3].map((n) => n * COL_GAP);

// Vertical cascade: how far down (in Y) each successive tableau card sits.
// Face-down cards show only a sliver; face-up cards show enough to read rank/suit.
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
const PLANE_Z_OFFSET = 0.0015; // front plane at +this, back plane at -this

// How far (in Y and Z) a selected card/run lifts up to show it's selected.
const SELECT_LIFT_Y = 0.012;
const SELECT_LIFT_Z = 0.020;

// ----------------------------------------------------------------------------
// 2. GAME STATE
// ----------------------------------------------------------------------------
let deck = [];              // all 52 card objects, built fresh each new game
let tableau = [[], [], [], [], [], [], []]; // 7 piles, index 0 = bottom card
let stock = [];              // face-down draw pile, index 0 = bottom
let waste = [];              // face-up drawn cards, index 0 = bottom
let foundations = { hearts: [], diamonds: [], clubs: [], spades: [] };

// The current selection, or null. Shape: { card, pile, run }
//   card = the card that was tapped to start the selection
//   pile = {type: 'tableau'|'waste'|'foundation', index}
//   run  = ordered array of card objects being moved (length 1 unless a
//          multi-card tableau sequence was grabbed)
let selected = null;

// ----------------------------------------------------------------------------
// 3. DECK BUILDING / SHUFFLING / DEALING
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
        location: null,   // set during deal, e.g. {type:'tableau', index:2}
        el: null,          // <a-entity> wrapper, set by createCardEntity()
        frontEl: null,
        backEl: null,
      });
    }
  }
  return cards;
}

// Fisher-Yates shuffle.
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

  deck = shuffle(buildDeck());
  tableau = [[], [], [], [], [], [], []];
  stock = [];
  waste = [];
  foundations = { hearts: [], diamonds: [], clubs: [], spades: [] };

  // Standard Klondike deal: column i gets (i+1) cards, only the last is
  // face up. Remaining 24 cards go face down to the stock.
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

  // Create + attach the 3D entity for every card, then snap everything into
  // its starting position instantly (no animation on the initial deal).
  const container = document.getElementById('cardsContainer');
  deck.forEach((card) => container.appendChild(createCardEntity(card)));
  renderBoard(true);
}

function clearBoard() {
  const container = document.getElementById('cardsContainer');
  while (container.firstChild) container.removeChild(container.firstChild);
  const win = document.getElementById('winMessage');
  if (win) win.style.display = 'none';
}

// ----------------------------------------------------------------------------
// 4. 3D CARD ENTITY CREATION
// ----------------------------------------------------------------------------
function createCardEntity(card) {
  const wrapper = document.createElement('a-entity');
  wrapper.id = 'card-' + card.id;
  wrapper.classList.add('card-wrapper');
  wrapper.dataset.cardId = card.id;

  // --- Front plane: shows rank/suit, visible when faceUp ---
  const front = document.createElement('a-plane');
  front.classList.add('clickable', 'card-front');
  front.setAttribute('width', CARD_WIDTH);
  front.setAttribute('height', CARD_HEIGHT);
  front.setAttribute('position', `0 0 ${PLANE_Z_OFFSET}`);
  front.setAttribute('visible', card.faceUp);
  // shader:flat = MeshBasicMaterial -> texture colors render true regardless
  // of the scene's AR lighting, which is what you want for readable cards.
  front.setAttribute('material', 'shader: flat; side: front');

  // --- Back plane: pre-rotated 180°, visible when !faceUp ---
  const back = document.createElement('a-plane');
  back.classList.add('clickable', 'card-back');
  back.setAttribute('width', CARD_WIDTH);
  back.setAttribute('height', CARD_HEIGHT);
  back.setAttribute('rotation', '0 180 0');
  back.setAttribute('position', `0 0 ${-PLANE_Z_OFFSET}`);
  back.setAttribute('visible', !card.faceUp);
  back.setAttribute('material', 'shader: flat; side: front; color: #8B0000');

  wrapper.appendChild(front);
  wrapper.appendChild(back);

  // Textures are applied once each plane's mesh actually exists.
  front.addEventListener('loaded', () => applyTexture(front, getFrontTexture(card)));
  back.addEventListener('loaded', () => applyTexture(back, getBackTexture()));

  // Click handling fallback (manual raycasting handles primary interaction)
  front.addEventListener('click', () => onCardClicked(card));
  back.addEventListener('click', () => onCardClicked(card));

  card.el = wrapper;
  card.frontEl = front;
  card.backEl = back;
  return wrapper;
}

// Uploads a THREE texture onto an <a-plane>'s mesh material.
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

// Tints a card's two faces to indicate selection. Because the material uses
// shader:flat (MeshBasicMaterial, no lighting/emissive), tinting is done by
// multiplying the texture with a colour instead.
function setHighlight(card, on) {
  [card.frontEl, card.backEl].forEach((el) => {
    if (!el) return;
    const mesh = el.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.color.set(on ? 0xffea75 : 0xffffff);
      mesh.material.needsUpdate = true;
    }
  });
}

// ----------------------------------------------------------------------------
// 5. TEXTURE GENERATION (placeholder art) — SWAP POINT for your own artwork
// ----------------------------------------------------------------------------
const frontTextureCache = {};
let backTextureCache = null;

function getFrontTexture(card) {
  const key = card.suit + '_' + card.rank;
  if (frontTextureCache[key]) return frontTextureCache[key];

  let texture;
  if (CONFIG.useImageTextures) {
    // ---- SWAP POINT A: load your own per-card image ----
    // Replace buildCardImageUrl() below to match however you name your
    // files, or point it at a single texture atlas + set UV offsets on
    // texture.offset/texture.repeat instead of loading 52 separate images.
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
    // ---- SWAP POINT B: load your own card-back image ----
    backTextureCache = new THREE.TextureLoader().load(CONFIG.cardBackImage);
  } else {
    backTextureCache = generatePlaceholderBackTexture();
  }
  return backTextureCache;
}

function buildCardImageUrl(card) {
  const suitInitial = card.suit.charAt(0).toUpperCase(); // H, D, C, S
  return `${CONFIG.cardImagePath}${card.rank}${suitInitial}.png`;
}

// Draws a simple but fully readable card face onto a canvas and returns it
// as a THREE.CanvasTexture. This needs no external files at all, which is
// why it's the default. Swap to useImageTextures:true whenever you have
// real artwork ready.
function generatePlaceholderFrontTexture(card) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 358; // matches the ~2.5:3.5 card aspect ratio
  const ctx = canvas.getContext('2d');
  const color = card.color === 'red' ? '#c81e1e' : '#111111';

  // Card face background + border
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

  // Bottom-right rank + suit, rotated 180° (standard playing-card layout)
  ctx.save();
  ctx.translate(canvas.width - 16, canvas.height - 12);
  ctx.rotate(Math.PI);
  ctx.font = 'bold 42px Georgia, serif';
  ctx.fillText(card.rank, 0, 0);
  ctx.font = '34px Georgia, serif';
  ctx.fillText(SUIT_SYMBOLS[card.suit], 0, 46);
  ctx.restore();

  // Big centre suit symbol
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

  // Simple diagonal lattice pattern so the back doesn't read as a flat block
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

// Manual rounded-rect path (kept instead of ctx.roundRect for compatibility
// with older mobile browsers that may be used for the AR camera view).
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
// 6. PILE SLOTS — invisible/outline click targets for empty piles
// ----------------------------------------------------------------------------
// Every pile gets a thin placeholder plane sitting slightly BEHIND where its
// cards would be (smaller Z). When the pile is empty this is what the
// raycaster hits, letting the player tap an empty tableau/foundation spot as
// a move destination. When the pile has cards, the top card sits in front of
// it along the ray and is hit first instead — exactly what we want.
function createPileSlots() {
  const container = document.getElementById('slotsContainer');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  addSlot(container, 'stock', null, STOCK_POS.x, STOCK_POS.y);
  addSlot(container, 'waste', null, WASTE_POS.x, WASTE_POS.y);
  SUITS.forEach((suit, i) => addSlot(container, 'foundation', suit, FOUNDATION_X[i], FOUNDATION_Y));
  for (let c = 0; c < 7; c++) addSlot(container, 'tableau', c, TABLEAU_X[c], TABLEAU_TOP_Y);
}

function addSlot(container, type, id, x, y) {
  const el = document.createElement('a-plane');
  el.classList.add('clickable', 'pile-slot');
  el.dataset.pileType = type;
  if (id !== null && id !== undefined) {
    el.dataset.pileId = id;
  }
  el.setAttribute('width', CARD_WIDTH);
  el.setAttribute('height', CARD_HEIGHT);
  el.setAttribute('position', `${x} ${y} -0.005`);
  el.setAttribute('material', 'shader: flat; color: #ffffff; opacity: 0.15; transparent: true');
  const pile = type === 'foundation' ? { type: 'foundation', suit: id, index: id } : { type, index: id };
  el.addEventListener('click', () => handlePileClick(pile));
  container.appendChild(el);
}

// ----------------------------------------------------------------------------
// 7. LAYOUT / RENDERING — pushes game state out to 3D positions
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

  // Fan the last few waste cards slightly so recent draws are visible.
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

// Ensures proper depth testing and mild baseline polygon offset so the stable
// geometric Z gaps (CARD_Z_STEP = 0.006) strictly govern depth ordering.
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

  if (instant) {
    if (card.frontEl) card.frontEl.setAttribute('visible', faceUp);
    if (card.backEl) card.backEl.setAttribute('visible', !faceUp);
    applyDepthBias(card, Math.round(pos.z / CARD_Z_STEP));
    el.removeAttribute('animation__move');
    el.removeAttribute('animation__flip');
    el.removeAttribute('animation__lift');
    el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
    el.setAttribute('rotation', targetRotation);
  } else {
    // Keep both visible during 3D flip animation for visual smoothness, then hide the occluded face
    if (card.frontEl) card.frontEl.setAttribute('visible', true);
    if (card.backEl) card.backEl.setAttribute('visible', true);
    applyDepthBias(card, Math.round(pos.z / CARD_Z_STEP));
    el.setAttribute('animation__move', `property: position; to: ${pos.x} ${pos.y} ${pos.z}; dur: 350; easing: easeOutQuad`);
    el.setAttribute('animation__flip', `property: rotation; to: ${targetRotation}; dur: 300; easing: easeInOutQuad`);
    setTimeout(() => {
      if (card.frontEl) card.frontEl.setAttribute('visible', card.faceUp);
      if (card.backEl) card.backEl.setAttribute('visible', !card.faceUp);
    }, 320);
  }
}

// ----------------------------------------------------------------------------
// 8. PILE / RUN HELPERS
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

// A "run" is `card` plus every card above it in its tableau column. It's a
// legal run to pick up only if every card in it is face up and the whole
// sequence is alternating-colour, descending rank (standard Klondike rule
// for moving multiple cards at once).
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
// 9. MOVE VALIDATION RULES
// ----------------------------------------------------------------------------
function canPlaceOnTableau(card, destCol) {
  const arr = tableau[destCol];
  if (arr.length === 0) return card.rank === 'K'; // only a King may start an empty column
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
// 10. SELECTION
// ----------------------------------------------------------------------------
function selectCard(card, pile) {
  const run = pile.type === 'tableau' ? getRunFrom(pile.index, card) : [card];
  selected = { card, pile, run };
  run.forEach((c) => {
    const el = c.el;
    const pos = el.getAttribute('position');
    el.dataset.origX = pos.x;
    el.dataset.origY = pos.y;
    el.dataset.origZ = pos.z;
    const targetY = (parseFloat(pos.y) + SELECT_LIFT_Y).toFixed(4);
    const targetZ = (parseFloat(pos.z) + SELECT_LIFT_Z).toFixed(4);
    el.setAttribute('animation__lift', `property: position; to: ${pos.x} ${targetY} ${targetZ}; dur: 150; easing: easeOutQuad`);
    setHighlight(c, true);
  });
}

// Cancels the current selection and animates the run back down.
function deselectCard() {
  if (!selected) return;
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
}

// Used right before a successful move: strips the lift/tint instantly
// (no animate-back) because renderBoard() is about to animate these same
// cards to their real destination anyway.
function clearSelectionForMove(run) {
  run.forEach((c) => {
    c.el.removeAttribute('animation__lift');
    setHighlight(c, false);
  });
}

// ----------------------------------------------------------------------------
// 11. CLICK HANDLERS
// ----------------------------------------------------------------------------
function onCardClicked(card) {
  const pile = card.location;
  if (!pile) return;

  // Tapping anywhere on the stock always means "draw", regardless of
  // whether something else is selected (matches physical solitaire).
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

  if (selected.card === card) {
    deselectCard(); // tapping the already-selected card cancels the selection
    return;
  }

  attemptMove(selected, pile);
}

function handlePileClick(pile) {
  if (pile.type === 'stock') {
    drawFromStock();
    return;
  }
  if (!selected) return; // tapping an empty slot with nothing selected does nothing
  attemptMove(selected, pile);
}

// ----------------------------------------------------------------------------
// 12. MOVE EXECUTION
// ----------------------------------------------------------------------------
function attemptMove(sel, destPile) {
  const { run, pile: srcPile } = sel;

  const destSuit = destPile.suit || destPile.index;
  const srcSuit = srcPile.suit || srcPile.index;

  const isSamePile = destPile.type === srcPile.type && (
    destPile.type === 'foundation'
      ? destSuit === srcSuit
      : destPile.type === 'tableau'
      ? String(destPile.index) === String(srcPile.index)
      : true
  );

  // Tapping back into the pile the run already belongs to = cancel.
  if (isSamePile) {
    deselectCard();
    return;
  }

  let valid = false;
  if (destPile.type === 'foundation' && run.length === 1 && canPlaceOnFoundation(run[0], destSuit)) {
    valid = true;
  } else if (destPile.type === 'tableau' && canPlaceOnTableau(run[0], destPile.index)) {
    valid = true;
  }

  if (valid) {
    clearSelectionForMove(run);
    moveCardsToPile(run, srcPile, destPile);
    selected = null;
    checkAutoFlipTableauTop(srcPile);
    checkWinCondition();
  } else {
    deselectCard(); // invalid destination -> snap back to origin
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

// Standard Klondike rule: once a tableau pile's top card is exposed, it
// automatically turns face up.
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
// 13. STOCK / WASTE
// ----------------------------------------------------------------------------
function drawFromStock() {
  if (selected) deselectCard();

  if (stock.length === 0) {
    if (waste.length === 0) return; // truly nothing left to do
    // Recycle: flip the whole waste pile back into the stock, face down,
    // in reverse order, so the draw order repeats.
    while (waste.length) {
      const c = waste.pop();
      c.faceUp = false;
      c.location = { type: 'stock' };
      stock.push(c);
    }
    renderBoard(false);
    return;
  }

  const card = stock.pop();
  card.faceUp = true;
  card.location = { type: 'waste' };
  waste.push(card);
  renderBoard(false);
}

// ----------------------------------------------------------------------------
// 14. WIN CONDITION
// ----------------------------------------------------------------------------
function checkWinCondition() {
  const won = SUITS.every((s) => foundations[s].length === 13);
  if (won) {
    const win = document.getElementById('winMessage');
    if (win) win.style.display = 'flex';
  }
}

// ----------------------------------------------------------------------------
// 15. MANUAL TAP DETECTION & RAYCASTING
// ----------------------------------------------------------------------------
// We deliberately don't use A-Frame's built-in cursor/raycaster components
// because they depend on synthetic browser click events which MindAR touch
// handling can suppress or distort on mobile devices.
//
// Instead, we manually raycast on pointerdown/pointerup, distinguishing clean
// taps from drags/swipes. Only visible, interactive card faces and valid pile
// slots are candidate meshes, preventing hidden faces or dormant tableau cards
// from intercepting raycasts or stealing clicks.

function getInteractiveTargets() {
  const targets = [];

  // 1. Pile slots:
  // Stock slot is always interactive (allows drawing or recycling waste when stock is empty).
  // Waste, tableau, and foundation slots are interactive only when empty!
  const slots = document.querySelectorAll('.pile-slot');
  slots.forEach((slotEl) => {
    const mesh = slotEl.getObject3D('mesh');
    if (!mesh) return;

    const slotType = slotEl.dataset.pileType;
    const slotId = slotEl.dataset.pileId;
    let isTargetable = false;

    if (slotType === 'stock') {
      isTargetable = true;
    } else if (slotType === 'waste') {
      isTargetable = waste.length === 0;
    } else if (slotType === 'tableau') {
      const col = parseInt(slotId, 10);
      isTargetable = tableau[col] && tableau[col].length === 0;
    } else if (slotType === 'foundation') {
      isTargetable = foundations[slotId] && foundations[slotId].length === 0;
    }

    if (isTargetable) {
      const pile = slotType === 'foundation'
        ? { type: 'foundation', suit: slotId, index: slotId }
        : { type: slotType, index: slotId };
      targets.push({ mesh, el: slotEl, pile });
    }
  });

  // 2. Interactive cards:
  // Face-up cards: frontEl mesh is active and visible.
  // Face-down cards: only stock cards are interactive (tapping stock draws).
  // Face-down tableau cards are not interactive, so they never steal raycast hits.
  deck.forEach((card) => {
    if (!card.el) return;

    if (card.faceUp && card.frontEl) {
      const mesh = card.frontEl.getObject3D('mesh');
      if (mesh && card.frontEl.getAttribute('visible') !== false) {
        targets.push({ mesh, el: card.frontEl, card });
      }
    } else if (!card.faceUp && card.backEl) {
      if (card.location && card.location.type === 'stock') {
        const mesh = card.backEl.getObject3D('mesh');
        if (mesh && card.backEl.getAttribute('visible') !== false) {
          targets.push({ mesh, el: card.backEl, card });
        }
      }
    }
  });

  return targets;
}

function setupManualRaycasting() {
  const scene = document.querySelector('a-scene');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let pointerDownPos = null;
  let pointerDownTime = 0;
  let lastTapTime = 0;

  function onPointerDown(e) {
    if (e.isPrimary === false) return;
    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      return;
    }
    pointerDownPos = { x: e.clientX, y: e.clientY };
    pointerDownTime = performance.now();
  }

  function onPointerUp(e) {
    if (e.isPrimary === false || !pointerDownPos) return;

    const startX = pointerDownPos.x;
    const startY = pointerDownPos.y;
    pointerDownPos = null;

    if (e.target && e.target.closest && (e.target.closest('#newGameBtn') || e.target.closest('#winMessage'))) {
      return;
    }

    const now = performance.now();
    if (now - lastTapTime < 80) return; // Debounce rapid / double events

    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
    const dt = now - pointerDownTime;
    if (dist > 15 || dt > 700) return; // Reject drags, swipes, or long presses
    lastTapTime = now;

    const camera = scene ? scene.camera : null;
    if (!camera) return;

    const canvas = scene ? scene.canvas : null;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top || e.clientY > rect.bottom
    ) {
      return;
    }

    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const interactiveTargets = getInteractiveTargets();
    if (interactiveTargets.length === 0) return;

    const meshes = interactiveTargets.map((t) => t.mesh);
    const hits = raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      const target = interactiveTargets.find((t) => t.mesh === hitMesh);
      if (target) {
        if (target.card) {
          onCardClicked(target.card);
        } else if (target.pile) {
          handlePileClick(target.pile);
        } else if (target.el) {
          target.el.emit('click', {}, false);
        }
      }
    }
  }

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
}

// ----------------------------------------------------------------------------
// 16. BOOTSTRAP
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
