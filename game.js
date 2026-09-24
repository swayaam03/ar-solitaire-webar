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
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const SUIT_SYMBOLS = { hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663', spades: '\u2660' };
const SUIT_COLORS = { hearts: 'red', diamonds: 'red', clubs: 'black', spades: 'black' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUES = RANKS.reduce((map, r, i) => { map[r] = i + 1; return map; }, {});

// Card footprint, in target-local units. A standard poker card is ~2.5:3.5.
const CARD_WIDTH = 0.13;
const CARD_HEIGHT = 0.182;

// Horizontal spacing between the 7 tableau columns / top-row piles.
const COL_GAP = 0.16;
const TABLEAU_X = [-3, -2, -1, 0, 1, 2, 3].map((n) => n * COL_GAP);

// Vertical cascade: how far down (in Y) each successive tableau card sits.
// Face-down cards show only a sliver; face-up cards show enough to read.
const TABLEAU_TOP_Y = -0.02;
const TABLEAU_FACEDOWN_STEP = 0.018;
const TABLEAU_FACEUP_STEP = 0.045;

// Top row: Stock | Waste | (gap) | Foundation x4
const TOP_ROW_Y = 0.30;
const STOCK_POS = { x: TABLEAU_X[0], y: TOP_ROW_Y };
const WASTE_POS = { x: TABLEAU_X[1], y: TOP_ROW_Y };
const FOUNDATION_X = [TABLEAU_X[3], TABLEAU_X[4], TABLEAU_X[5], TABLEAU_X[6]];
const FOUNDATION_Y = TOP_ROW_Y;

// Z-depth given to each card within a pile, so the top card of any pile is
// always physically closest to the camera (and therefore the one the
// raycaster hits first). Kept larger than the front/back plane offset below
// so neighbouring cards' planes never interleave in depth. These are large
// enough to survive typical AR-camera depth-buffer precision at a marker's
// viewing distance; on top of this we also apply an explicit polygonOffset
// per layer (see applyDepthBias) so stacking order never relies solely on
// floating-point geometry, which is what caused stacked cards to flicker/
// bleed into each other on-device.
const CARD_Z_STEP = 0.012;
const PLANE_Z_OFFSET = 0.003; // front plane at +this, back plane at -this

// How far (in Y) a selected card/run lifts up to show it's selected.
const SELECT_LIFT = 0.025;

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

  // --- Front plane: shows rank/suit, faces +Z when wrapper rotation = 0 ---
  const front = document.createElement('a-plane');
  front.classList.add('clickable', 'card-front');
  front.setAttribute('width', CARD_WIDTH);
  front.setAttribute('height', CARD_HEIGHT);
  front.setAttribute('position', `0 0 ${PLANE_Z_OFFSET}`);
  // shader:flat = MeshBasicMaterial -> texture colors render true regardless
  // of the scene's AR lighting, which is what you want for readable cards.
  front.setAttribute('material', 'shader: flat; side: front');

  // --- Back plane: pre-rotated 180° so it faces -Z when wrapper rotation = 0
  //     (i.e. hidden). When the wrapper flips to 180°, this plane's world
  //     rotation becomes 0° and IT is the one facing the camera. ---
  const back = document.createElement('a-plane');
  back.classList.add('clickable', 'card-back');
  back.setAttribute('width', CARD_WIDTH);
  back.setAttribute('height', CARD_HEIGHT);
  back.setAttribute('rotation', '0 180 0');
  back.setAttribute('position', `0 0 ${-PLANE_Z_OFFSET}`);
  back.setAttribute('material', 'shader: flat; side: front; color: #8B0000');

  wrapper.appendChild(front);
  wrapper.appendChild(back);

  // Textures are applied once each plane's mesh actually exists.
  front.addEventListener('loaded', () => applyTexture(front, getFrontTexture(card)));
  back.addEventListener('loaded', () => applyTexture(back, getBackTexture()));

  // Click handling: both faces of a card resolve to the same game logic.
  front.addEventListener('click', () => onCardClicked(card));
  back.addEventListener('click', () => onCardClicked(card));

  card.el = wrapper;
  card.frontEl = front;
  card.backEl = back;
  return wrapper;
}

// Uploads a THREE texture onto an <a-plane>'s mesh material. Retries if the
// mesh isn't ready yet (loaded fires when the entity is attached, but the
// mesh material is created synchronously by the material component so in
// practice one attempt is almost always enough — the retry is just a safety
// net for slow devices).
function applyTexture(planeEl, texture) {
  const mesh = planeEl.getObject3D('mesh');
  if (mesh && mesh.material) {
    mesh.material.map = texture;
    mesh.material.color.set(0xffffff);
    mesh.material.polygonOffset = true; // baseline; per-layer value set by applyDepthBias
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
    const mesh = el.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.color.set(on ? 0xffe066 : 0xffffff);
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
  addSlot(container, 'stock', null, STOCK_POS.x, STOCK_POS.y);
  addSlot(container, 'waste', null, WASTE_POS.x, WASTE_POS.y);
  SUITS.forEach((suit, i) => addSlot(container, 'foundation', suit, FOUNDATION_X[i], FOUNDATION_Y));
  for (let c = 0; c < 7; c++) addSlot(container, 'tableau', c, TABLEAU_X[c], TABLEAU_TOP_Y);
}

function addSlot(container, type, index, x, y) {
  const el = document.createElement('a-plane');
  el.classList.add('clickable', 'pile-slot');
  el.setAttribute('width', CARD_WIDTH);
  el.setAttribute('height', CARD_HEIGHT);
  el.setAttribute('position', `${x} ${y} -0.01`);
  el.setAttribute('material', 'shader: flat; color: #ffffff; opacity: 0.10; transparent: true');
  el.addEventListener('click', () => handlePileClick({ type, index }));
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
    const fan = fromTop < 3 ? (2 - fromTop) * 0.018 : 0;
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

// Biases the depth-test result for a card's two faces so pile stacking
// order is resolved deterministically by the GPU, instead of relying only
// on the (very small) real Z gaps between cards. `layer` is the card's
// index within its pile (0 = bottom). Without this, stacked cards can
// z-fight and flicker/bleed into each other, especially at the oblique
// viewing angles typical of handheld AR.
function applyDepthBias(card, layer) {
  [card.frontEl, card.backEl].forEach((el) => {
    const mesh = el.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.polygonOffset = true;
      mesh.material.polygonOffsetFactor = -layer;
      mesh.material.polygonOffsetUnits = -layer * 4;
    }
  });
}

function setCardTransform(card, pos, faceUp, instant) {
  const el = card.el;
  if (!el) return;
  const targetRotation = faceUp ? '0 0 0' : '0 180 0';

  applyDepthBias(card, Math.round(pos.z / CARD_Z_STEP));

  if (instant) {
    el.removeAttribute('animation__move');
    el.removeAttribute('animation__flip');
    el.removeAttribute('animation__lift');
    el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
    el.setAttribute('rotation', targetRotation);
  } else {
    el.setAttribute('animation__move', `property: position; to: ${pos.x} ${pos.y} ${pos.z}; dur: 350; easing: easeOutQuad`);
    el.setAttribute('animation__flip', `property: rotation; to: ${targetRotation}; dur: 300; easing: easeInOutQuad`);
  }
}

// ----------------------------------------------------------------------------
// 8. PILE / RUN HELPERS
// ----------------------------------------------------------------------------
function getPileArray(pile) {
  if (pile.type === 'tableau') return tableau[pile.index];
  if (pile.type === 'foundation') return foundations[pile.index];
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
  if (arr.length === 0) return card.rank === 'A';
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
    el.dataset.origY = pos.y;
    el.setAttribute('animation__lift', `property: position.y; to: ${pos.y + SELECT_LIFT}; dur: 150; easing: easeOutQuad`);
    setHighlight(c, true);
  });
}

// Cancels the current selection and animates the run back down.
function deselectCard() {
  if (!selected) return;
  selected.run.forEach((c) => {
    const el = c.el;
    const origY = parseFloat(el.dataset.origY);
    el.setAttribute('animation__lift', `property: position.y; to: ${origY}; dur: 150; easing: easeOutQuad`);
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

  if (!selected) {
    if (!card.faceUp) return; // can't pick up a face-down card
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

  // Tapping back into the pile the run already belongs to = cancel.
  if (destPile.type === srcPile.type && String(destPile.index) === String(srcPile.index)) {
    deselectCard();
    return;
  }

  let valid = false;
  if (destPile.type === 'foundation' && run.length === 1 && canPlaceOnFoundation(run[0], destPile.index)) {
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
  run.forEach((c) => {
    c.location = { type: destPile.type, index: destPile.index };
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
// 15. MANUAL TAP DETECTION
// ----------------------------------------------------------------------------
// We deliberately don't use A-Frame's built-in cursor/raycaster components
// (see the comment on <a-camera> in index.html) because they depend on the
// browser synthesizing a "click" after a touch, which MindAR's own touch
// handling often eats on mobile. Instead we raycast by hand on "pointerup",
// a single low-level event that covers touch, mouse, and pen uniformly and
// isn't affected by that suppression. Whichever mesh is hit gets a normal
// A-Frame "click" event emitted on it, so all the existing
// addEventListener('click', ...) handlers on cards and pile slots work
// completely unchanged.
function setupManualRaycasting() {
  const scene = document.querySelector('a-scene');
  const canvas = scene.canvas;
  if (!canvas) return;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  canvas.addEventListener('pointerup', (event) => {
    const camera = scene.camera;
    if (!camera) return;

    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const meshes = Array.from(document.querySelectorAll('.clickable'))
      .map((el) => el.getObject3D('mesh'))
      .filter(Boolean);

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      const hitEl = hits[0].object.el; // A-Frame back-reference to the entity
      if (hitEl) hitEl.emit('click', {}, false);
    }
  });
}

// ----------------------------------------------------------------------------
// 16. BOOTSTRAP
// ----------------------------------------------------------------------------
function init() {
  createPileSlots();
  setupManualRaycasting();
  const newGameBtn = document.getElementById('newGameBtn');
  if (newGameBtn) newGameBtn.addEventListener('click', dealNewGame);
  dealNewGame();
}

const sceneEl = document.querySelector('a-scene');
if (sceneEl.hasLoaded) {
  init();
} else {
  sceneEl.addEventListener('loaded', init);
}
