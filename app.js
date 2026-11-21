'use strict';
/* White Elephant — single-device party host app. All data lives in this browser (localStorage). */

const STORE_KEY = 'whiteElephant.v1';
const PALETTE = ['#c0392b', '#e74c3c', '#ff6fa8', '#e67e22', '#f1c40f', '#1e8449', '#16a085',
  '#2e86c1', '#1b2a6b', '#8e44ad', '#ecf0f1', '#2c3e50', '#b9770e', '#d4af37'];
const PATTERNS = [['plain', 'Plain'], ['stripes', 'Stripes'], ['dots', 'Dots'], ['zigzag', 'Zigzag'],
  ['stars', 'Stars'], ['plaid', 'Plaid'], ['checks', 'Checks'], ['snow', 'Snow']];
const BOWS = [['classic', 'Classic'], ['pompom', 'Pom-pom'], ['star', 'Star'], ['none', 'None']];
const TOPPERS = ['', '🎄', '⭐', '❄️', '🎅', '🦌', '🔔', '🍬', '☃️', '🐘', '❤️', '🍪', '🎉', '❓'];

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

let state = load() || freshState();
let undoStack = [];
let peek = false;
let draft = null;

/* ---------------- helpers ---------------- */
function freshState() {
  return { phase: 'setup', settings: { maxSteals: 3, noStealBack: true, finalSwap: true }, players: [], gifts: [], game: null };
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (s && Array.isArray(s.players)) return s; } catch { }
  return null;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); return true; }
  catch { toast('Browser storage is full — use image URLs or smaller photos.', true); return false; }
}
function commit() { save(); render(); }
const uid = () => Math.random().toString(36).slice(2, 10);
const pickR = a => a[Math.floor(Math.random() * a.length)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const player = id => state.players.find(p => p.id === id);
const gift = id => state.gifts.find(g => g.id === id);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
let toastTimer;
function toast(msg, bad = false) {
  $toast.textContent = msg; $toast.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.className = 'toast', 2800);
}
function randomWrap(tag = '') {
  const paper = pickR(PALETTE);
  const others = PALETTE.filter(c => c !== paper);
  return { paper, pattern: pickR(PATTERNS)[0], patternColor: pickR(others), ribbon: pickR(others),
    bow: pickR(['classic', 'pompom', 'star']), topper: '', tag };
}

/* ---------------- present SVG ---------------- */
function patternDef(kind, bg, fg, id) {
  const P = (w, h, body, extra = '') => `<pattern id="${id}" width="${w}" height="${h}" patternUnits="userSpaceOnUse" ${extra}><rect width="${w}" height="${h}" fill="${bg}"/>${body}</pattern>`;
  switch (kind) {
    case 'stripes': return P(18, 18, `<rect width="7" height="18" fill="${fg}"/>`, 'patternTransform="rotate(45)"');
    case 'dots': return P(20, 20, `<circle cx="5" cy="5" r="3.2" fill="${fg}"/><circle cx="15" cy="15" r="3.2" fill="${fg}"/>`);
    case 'zigzag': return P(24, 14, `<polyline points="0,10 6,4 12,10 18,4 24,10" fill="none" stroke="${fg}" stroke-width="3"/>`);
    case 'stars': return P(30, 30, `<text x="3" y="13" font-size="11" fill="${fg}">★</text><text x="18" y="28" font-size="9" fill="${fg}">★</text>`);
    case 'plaid': return P(30, 30, `<rect y="10" width="30" height="9" fill="${fg}" opacity=".55"/><rect x="10" width="9" height="30" fill="${fg}" opacity=".55"/><rect y="24" width="30" height="2" fill="${fg}" opacity=".7"/><rect x="24" width="2" height="30" fill="${fg}" opacity=".7"/>`);
    case 'checks': return P(24, 24, `<rect width="12" height="12" fill="${fg}"/><rect x="12" y="12" width="12" height="12" fill="${fg}"/>`);
    case 'snow': return P(34, 34, `<text x="2" y="12" font-size="11" fill="${fg}">❄</text><text x="19" y="29" font-size="8" fill="${fg}">❄</text><circle cx="26" cy="8" r="1.6" fill="${fg}"/><circle cx="9" cy="26" r="1.4" fill="${fg}"/>`);
    default: return '';
  }
}
function bowSVG(kind, c) {
  const s = 'stroke="rgba(0,0,0,.25)" stroke-width="1.5"';
  if (kind === 'classic') return `
    <path d="M100 66 L86 92 L94 92 L100 72Z" fill="${c}" ${s}/><path d="M100 66 L114 92 L106 92 L100 72Z" fill="${c}" ${s}/>
    <path d="M100 64 C82 30 50 38 60 60 C66 72 90 68 100 64Z" fill="${c}" ${s}/>
    <path d="M100 64 C118 30 150 38 140 60 C134 72 110 68 100 64Z" fill="${c}" ${s}/>
    <ellipse cx="100" cy="64" rx="9" ry="8" fill="${c}" ${s}/>`;
  if (kind === 'pompom') return [-75, -45, -15, 15, 45, 75, 0].map(a =>
    `<ellipse cx="100" cy="44" rx="8" ry="20" fill="${c}" ${s} transform="rotate(${a} 100 64)"/>`).join('') +
    `<circle cx="100" cy="62" r="8" fill="${c}" ${s}/>`;
  if (kind === 'star') {
    const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 10 : 24, a = Math.PI / 5 * i - Math.PI / 2; pts.push(`${(100 + r * Math.cos(a)).toFixed(1)},${(44 + r * Math.sin(a)).toFixed(1)}`); }
    return `<polygon points="${pts.join(' ')}" fill="${c}" ${s}/>`;
  }
  return '';
}
function presentSVG(w) {
  const id = 'p' + uid();
  const fill = w.pattern && w.pattern !== 'plain' ? `url(#${id}-pat)` : w.paper;
  const topperY = w.bow === 'none' ? 58 : (w.bow === 'classic' ? 36 : 26);
  const tag = (w.tag || '').slice(0, 10);
  return `<svg class="present" viewBox="0 -6 200 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="wrapped present">
  <defs>${patternDef(w.pattern, w.paper, w.patternColor, id + '-pat')}
    <linearGradient id="${id}-sh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
  </defs>
  <ellipse cx="100" cy="196" rx="80" ry="7" fill="#000" opacity=".15"/>
  <g class="box">
    <rect x="30" y="90" width="140" height="102" rx="6" fill="${fill}"/>
    <rect x="30" y="90" width="140" height="102" rx="6" fill="url(#${id}-sh)"/>
    <rect x="91" y="90" width="18" height="102" fill="${w.ribbon}"/>
    <rect x="91" y="90" width="18" height="102" fill="url(#${id}-sh)" opacity=".5"/>
  </g>
  <g class="lid">
    <rect x="22" y="66" width="156" height="30" rx="5" fill="${fill}"/>
    <rect x="22" y="66" width="156" height="30" rx="5" fill="url(#${id}-sh)"/>
    <rect x="24" y="92" width="152" height="4" fill="#000" opacity=".15"/>
    <rect x="91" y="66" width="18" height="30" fill="${w.ribbon}"/>
    ${bowSVG(w.bow, w.ribbon)}
    ${w.topper ? `<text x="100" y="${topperY}" text-anchor="middle" font-size="26">${esc(w.topper)}</text>` : ''}
  </g>
  ${tag ? `<g class="tagg" transform="translate(136 128) rotate(10)">
    <path d="M0 13 L10 0 H58 V26 H10Z" fill="#fffbe6" stroke="#a8977a" stroke-width="1.5"/>
    <circle cx="10" cy="13" r="2.5" fill="#a8977a"/>
    <text x="35" y="17.5" text-anchor="middle" font-size="${tag.length > 6 ? 9 : 12}" font-weight="700" fill="#4a3b2a" font-family="system-ui,sans-serif">${esc(tag)}</text></g>` : ''}
</svg>`;
}
function itemImg(g) {
  return g.img
    ? `<img src="${esc(g.img)}" alt="${esc(g.name)}" onerror="this.outerHTML='<div class=&quot;no-img&quot;>🖼️</div>'">`
    : `<div class="no-img">🎁</div>`;
}
async function fileToDataURL(file, max = 800) {
  const src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('bad image')); i.src = src; });
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

/* ---------------- game logic ---------------- */
const G = () => state.game;
const giftOf = pid => Object.keys(G().holdings).find(gid => G().holdings[gid] === pid);
function snapshot() { undoStack.push(JSON.stringify({ phase: state.phase, game: state.game })); if (undoStack.length > 100) undoStack.shift(); }
function log(msg) { G().log.unshift(msg); }
function stealBlock(gid, pid) {
  const g = G(), h = g.holdings[gid];
  if (!h) return 'Not claimed yet';
  if (h === pid) return 'That one is yours';
  if ((g.steals[gid] || 0) >= state.settings.maxSteals) return 'Locked — max steals reached';
  if (state.phase === 'play' && state.settings.noStealBack && (g.blocked[pid] || []).includes(gid)) return "No immediate steal-backs";
  return '';
}
function startGame() {
  const order = shuffle(state.players.map(p => p.id));
  state.game = { order, turnIndex: 0, active: order[0], holdings: {}, steals: {}, blocked: {}, log: [], revealed: {} };
  state.phase = 'play'; undoStack = [];
  log(`🎲 Order shuffled — ${player(order[0]).name} goes first!`);
  commit();
}
function endTurn() {
  const g = G(); g.blocked = {}; g.turnIndex++;
  if (g.turnIndex < g.order.length) { g.active = g.order[g.turnIndex]; return; }
  if (state.settings.finalSwap && g.order.length > 1) {
    state.phase = 'final'; g.active = g.order[0];
    log(`🏁 Final round: ${player(g.order[0]).name} may swap or keep.`);
  } else goReveal();
}
function goReveal() { state.phase = 'reveal'; log('🎁 Time for the big reveal!'); }
function pickGift(gid) {
  const g = G(); snapshot();
  g.holdings[gid] = g.active;
  log(`${player(g.active).name} picked a gift (${gift(gid).wrap.tag || 'untagged'}).`);
  endTurn(); commit();
}
function stealGift(gid) {
  const g = G(), why = stealBlock(gid, g.active); if (why) return toast(why, true);
  snapshot();
  const victim = g.holdings[gid];
  g.holdings[gid] = g.active;
  g.steals[gid] = (g.steals[gid] || 0) + 1;
  (g.blocked[victim] = g.blocked[victim] || []).push(gid);
  const locked = g.steals[gid] >= state.settings.maxSteals;
  log(`😈 ${player(g.active).name} stole ${gift(gid).wrap.tag || 'a gift'} from ${player(victim).name}${locked ? ' — now LOCKED 🔒' : ''}.`);
  g.active = victim;
  commit();
}
function finalSwap(gid) {
  const g = G(), me = g.order[0], why = stealBlock(gid, me); if (why) return toast(why, true);
  snapshot();
  const mine = giftOf(me), other = g.holdings[gid];
  g.holdings[gid] = me; if (mine) g.holdings[mine] = other;
  g.steals[gid] = (g.steals[gid] || 0) + 1;
  log(`🔁 ${player(me).name} swapped with ${player(other).name}!`);
  goReveal(); commit();
}
function undo() {
  const s = undoStack.pop(); if (!s) return;
  const { phase, game } = JSON.parse(s); state.phase = phase; state.game = game;
  toast('Undone'); commit();
}

/* ---------------- rendering ---------------- */
function render() {
  const steps = [['setup', 'Setup'], ['play', 'Play'], ['final', 'Final round'], ['reveal', 'Reveal']];
  document.getElementById('steps').innerHTML = steps.map(([k, l]) => `<span class="${state.phase === k ? 'on' : ''}">${l}</span>`).join('');
  if (state.phase === 'setup') renderSetup();
  else if (state.phase === 'play' || state.phase === 'final') renderPlay();
  else renderReveal();
}

function renderSetup() {
  const { players, gifts, settings } = state;
  const problems = [];
  if (players.length < 2) problems.push('Add at least 2 players');
  if (gifts.length < players.length) problems.push(`Need ${players.length - gifts.length} more gift${players.length - gifts.length === 1 ? '' : 's'}`);
  $app.innerHTML = `
  <div class="setup">
    <section class="panel">
      <h2>👥 Players <span class="count">${players.length}</span></h2>
      <form data-form="add-player" class="row">
        <input name="name" placeholder="Name — or several, comma-separated" autocomplete="off" style="flex:1">
        <button class="btn primary">Add</button>
      </form>
      <ul class="chips">${players.map(p => `<li>${esc(p.name)}<button class="icon-btn" data-action="remove-player" data-id="${p.id}" title="Remove">✕</button></li>`).join('')}</ul>
      ${players.length ? '' : '<p class="muted">Turn order gets shuffled when the game starts.</p>'}
    </section>

    <section class="panel gifts-panel">
      <h2>🎁 Gifts <span class="count">${gifts.length}</span></h2>
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <button class="btn primary" data-action="add-gift">+ Add a gift</button>
        <label class="toggle" style="margin:0"><input type="checkbox" data-toggle="peek" ${peek ? 'checked' : ''}> Peek inside (host only 🙈)</label>
      </div>
      ${gifts.length ? `<div class="gift-grid">${gifts.map(g => `
        <div class="gift-card">
          ${presentSVG(g.wrap)}
          ${peek ? `<div class="row" style="justify-content:center">${g.img ? `<img class="thumb" src="${esc(g.img)}" alt="">` : ''}<span class="item-name">${esc(g.name)}</span></div>` : ''}
          ${g.from ? `<div class="muted">from ${esc(g.from)}</div>` : ''}
          <div class="card-actions">
            <button class="btn small" data-action="edit-gift" data-id="${g.id}">Edit</button>
            <button class="btn small danger" data-action="remove-gift" data-id="${g.id}">Delete</button>
          </div>
        </div>`).join('')}</div>`
      : '<div class="empty">No gifts yet. Each gift gets a name, a photo (upload or URL), and custom wrapping paper. The contents stay hidden until the final reveal.</div>'}
    </section>

    <section class="panel">
      <h2>⚙️ Rules</h2>
      <label class="inline-num">Max steals per gift <input type="number" min="1" max="20" value="${settings.maxSteals}" data-setting="maxSteals"></label>
      <label class="toggle"><input type="checkbox" data-setting="noStealBack" ${settings.noStealBack ? 'checked' : ''}> No immediate steal-backs</label>
      <label class="toggle"><input type="checkbox" data-setting="finalSwap" ${settings.finalSwap ? 'checked' : ''}> First player gets a final swap</label>
      <h3>Save / load</h3>
      <div class="row">
        <button class="btn small" data-action="export">⬇ Export</button>
        <label class="btn small" style="margin:0">⬆ Import<input type="file" accept=".json,application/json" data-file="import" hidden></label>
        <button class="btn small danger" data-action="reset-all">Clear everything</button>
      </div>
      <p class="muted">Everything is saved in this browser automatically. Use Export to move it to another device.</p>
    </section>

    <div class="start-bar">
      ${problems.length ? `<span class="warn">⚠ ${problems.join(' · ')}</span>` : ''}
      <button class="btn primary big" data-action="start" ${problems.length ? 'disabled' : ''}>Start the game 🎉</button>
    </div>
  </div>`;
}

function giftCardPlay(gid, mode) {
  const g = G(), gf = gift(gid), owner = g.holdings[gid] ? player(g.holdings[gid]) : null;
  const steals = g.steals[gid] || 0, max = state.settings.maxSteals;
  const locked = steals >= max;
  let action = '', why = '', cta = '';
  if (mode === 'pile') { action = state.phase === 'play' ? 'pick' : ''; cta = 'Pick me!'; why = state.phase === 'play' ? '' : 'Pile is closed in the final round'; }
  else {
    const me = state.phase === 'final' ? g.order[0] : g.active;
    why = stealBlock(gid, me);
    action = state.phase === 'final' ? 'swap' : 'steal';
    cta = state.phase === 'final' ? 'Swap!' : 'Steal!';
  }
  const isMine = owner && owner.id === (state.phase === 'final' ? g.order[0] : g.active);
  return `<button class="gift-card ${isMine ? 'mine' : ''}" data-action="${action}" data-id="${gid}" ${why || !action ? 'disabled' : ''} title="${esc(why)}">
    <span class="cta">${cta}</span>
    ${presentSVG(gf.wrap)}
    ${owner ? `<div class="owner">${esc(owner.name)}</div><div class="pips" title="${steals}/${max} steals">${'●'.repeat(Math.min(steals, max))}${'○'.repeat(Math.max(0, max - steals))}</div>` : ''}
    ${locked ? '<span class="lock" title="Locked">🔒</span>' : ''}
  </button>`;
}

function renderPlay() {
  const g = G(), final = state.phase === 'final';
  const active = player(g.active);
  const turnPlayer = final ? null : player(g.order[g.turnIndex]);
  const chain = !final && g.active !== turnPlayer.id;
  const pile = state.gifts.filter(x => !g.holdings[x.id]).map(x => x.id);
  const held = g.order.map(giftOf).filter(Boolean);
  let who, sub;
  if (final) { who = `🏁 <em>${esc(active.name)}</em>, final swap!`; sub = 'Swap your gift with any unlocked gift — or keep what you have.'; }
  else if (chain) { who = `😱 <em>${esc(active.name)}</em> got robbed!`; sub = 'Pick a new gift from the pile or steal someone else’s.'; }
  else { who = `<em>${esc(active.name)}</em>, you're up!`; sub = `Turn ${g.turnIndex + 1} of ${g.order.length} — pick from the pile${held.length ? ' or steal a gift' : ''}.`; }

  $app.innerHTML = `
  <div class="banner"><p class="who">${who}</p><div class="sub">${sub}</div></div>
  <div class="play">
    <div>
      ${final ? '' : `<section class="panel"><h2>🎄 Under the tree <span class="count">${pile.length}</span></h2>
        ${pile.length ? `<div class="gift-grid">${pile.map(id => giftCardPlay(id, 'pile')).join('')}</div>` : '<div class="empty">The pile is empty.</div>'}</section>`}
      <section class="panel"><h2>🙌 Claimed — still wrapped <span class="count">${held.length}</span></h2>
        ${held.length ? `<div class="gift-grid">${held.map(id => giftCardPlay(id, 'held')).join('')}</div>` : '<div class="empty">Nobody has a gift yet.</div>'}
        ${final ? `<div class="row" style="justify-content:center;margin-top:16px"><button class="btn primary big" data-action="keep">Keep my gift 👍</button></div>` : ''}
      </section>
    </div>
    <aside>
      <section class="panel">
        <h2>Turn order</h2>
        <ol class="order">${g.order.map((pid, i) => {
          const cur = pid === g.active, done = !final && i < g.turnIndex && !cur;
          return `<li class="${cur ? 'cur' : ''} ${done ? 'done' : ''}"><span class="n">${i + 1}</span>${cur ? '▶ ' : ''}${esc(player(pid).name)}${giftOf(pid) ? ' 🎁' : ''}</li>`;
        }).join('')}</ol>
      </section>
      <section class="panel">
        <div class="controls">
          <button class="btn small" data-action="undo" ${undoStack.length ? '' : 'disabled'}>↶ Undo</button>
          <button class="btn small" data-action="force-reveal">Skip to reveal</button>
          <button class="btn small danger" data-action="abandon">Back to setup</button>
        </div>
      </section>
      <section class="panel"><h2>📜 Play-by-play</h2><ul class="log">${g.log.slice(0, 40).map(l => `<li>${esc(l)}</li>`).join('')}</ul></section>
    </aside>
  </div>`;
}

function revealOrder() {
  const g = G();
  const held = g.order.map(pid => ({ pid, gid: giftOf(pid) })).filter(x => x.gid);
  const extra = state.gifts.filter(x => !g.holdings[x.id]).map(x => ({ pid: null, gid: x.id }));
  return held.concat(extra);
}
function renderReveal() {
  const g = G(), list = revealOrder();
  const next = list.find(x => !g.revealed[x.gid]);
  $app.innerHTML = `
  <div class="banner">
    <p class="who">${next ? '🎁 The big <em>reveal</em>!' : '🎉 All <em>revealed</em>!'}</p>
    <div class="sub">${next ? 'Tap a present to unwrap it, or go in order.' : 'Happy holidays, everyone.'}</div>
    <div class="row" style="justify-content:center;margin-top:14px">
      ${next ? `<button class="btn primary big" data-action="reveal" data-id="${next.gid}">Unwrap next${next.pid ? ` — ${esc(player(next.pid).name)}` : ''}</button>`
      : `<button class="btn primary big" data-action="play-again">Play again with same gifts</button>`}
      <button class="btn" data-action="undo" ${undoStack.length && !Object.keys(g.revealed).length ? '' : 'hidden'}>↶ Undo</button>
      <button class="btn" data-action="abandon">Back to setup</button>
    </div>
  </div>
  <div class="reveal-grid">${list.map(({ pid, gid }) => {
    const gf = gift(gid), who = pid ? esc(player(pid).name) : '<span class="muted">Unclaimed</span>';
    if (g.revealed[gid]) return `<div class="revealed-card">${itemImg(gf)}<div class="item">${esc(gf.name)}</div><div class="muted">${who}${gf.from ? ` · from ${esc(gf.from)}` : ''}</div></div>`;
    return `<button class="gift-card" data-action="reveal" data-id="${gid}"><span class="cta">Unwrap!</span>${presentSVG(gf.wrap)}<div class="owner">${who}</div></button>`;
  }).join('')}</div>`;
}

function showRevealModal(gid) {
  const g = G(), gf = gift(gid), pid = g.holdings[gid], owner = pid ? player(pid) : null;
  $modal.innerHTML = `<div class="modal-card reveal-stage" id="stage">
    <div class="reveal-owner">${owner ? `${esc(owner.name)} unwraps…` : 'An unclaimed gift…'}</div>
    <div class="reveal-stack">
      <div class="reveal-box">${presentSVG(gf.wrap)}</div>
      <div class="reveal-item">${itemImg(gf)}<h2>${esc(gf.name)}</h2>${gf.note ? `<p>${esc(gf.note)}</p>` : ''}${gf.from ? `<p class="muted">from ${esc(gf.from)}</p>` : ''}</div>
    </div>
    <button class="btn primary next-btn" data-action="close-reveal">Nice! 🎉</button>
  </div>`;
  $modal.classList.add('show');
  const stage = document.getElementById('stage');
  setTimeout(() => stage.classList.add('shake'), 80);
  setTimeout(() => { stage.classList.add('open'); confetti(); }, 950);
  g.revealed[gid] = true; save();
}
function confetti() {
  const colors = ['#c0392b', '#f1c40f', '#1e8449', '#2e86c1', '#ff6fa8', '#fff'];
  for (let i = 0; i < 130; i++) {
    const d = document.createElement('i'); d.className = 'confetti';
    d.style.left = Math.random() * 100 + 'vw'; d.style.background = pickR(colors);
    d.style.animationDuration = 2 + Math.random() * 2.2 + 's'; d.style.animationDelay = Math.random() * .5 + 's';
    d.style.setProperty('--drift', Math.random() * 240 - 120 + 'px');
    document.body.appendChild(d); setTimeout(() => d.remove(), 5000);
  }
}

/* ---------------- gift editor ---------------- */
function openEditor(gid) {
  const src = gid ? gift(gid) : { id: uid(), name: '', note: '', from: '', img: '', wrap: randomWrap(`#${state.gifts.length + 1}`) };
  draft = JSON.parse(JSON.stringify(src)); draft._new = !gid;
  renderEditor(); $modal.classList.add('show');
}
function swatches(field, value) {
  return `<div class="swatches">${PALETTE.map(c => `<button class="swatch ${c === value ? 'on' : ''}" style="background:${c}" data-action="wrap-set" data-field="${field}" data-value="${c}" title="${c}"></button>`).join('')}
    <input type="color" data-wrap="${field}" value="${value}" title="Custom color"></div>`;
}
function renderEditor() {
  const w = draft.wrap, isUrl = draft.img && !draft.img.startsWith('data:');
  $modal.innerHTML = `<div class="modal-card">
    <header><h2>${draft._new ? '🎁 Add a gift' : '✏️ Edit gift'}</h2><button class="icon-btn" data-action="close-modal" title="Close">✕</button></header>
    <div class="editor-grid">
      <section>
        <h3>What's inside</h3>
        <label>Item name<input data-field="name" value="${esc(draft.name)}" placeholder="e.g. Bacon-scented candle"></label>
        <label>Description <span class="muted">(optional)</span><textarea data-field="note" placeholder="Shown at the reveal">${esc(draft.note)}</textarea></label>
        <label>From <span class="muted">(optional)</span><input data-field="from" value="${esc(draft.from)}" list="player-names" placeholder="Who brought it?"></label>
        <datalist id="player-names">${state.players.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
        <h3>Picture</h3>
        <div class="img-row">
          <div class="img-preview" id="img-preview">${draft.img ? `<img src="${esc(draft.img)}" alt="" onerror="this.outerHTML='Couldn’t load that image'">` : 'No picture yet'}</div>
          <div class="img-inputs">
            <label class="btn file-btn">📷 Upload a photo<input type="file" accept="image/*" data-file="img" hidden></label>
            <label>…or paste an image URL<input type="url" data-field="imgUrl" value="${isUrl ? esc(draft.img) : ''}" placeholder="https://…/photo.jpg"></label>
            ${draft.img ? '<button class="btn small ghost" data-action="clear-img">Remove picture</button>' : ''}
          </div>
        </div>
      </section>
      <section>
        <h3>Wrapping <span class="muted">(this is all players see until the reveal)</span></h3>
        <div class="wrap-preview" id="wrap-preview">${presentSVG(w)}</div>
        <div class="row" style="justify-content:center;margin-top:6px"><button class="btn small" data-action="random-wrap">🎲 Surprise me</button></div>
        <div class="ctl"><div class="lbl">Paper</div>${swatches('paper', w.paper)}</div>
        <div class="ctl"><div class="lbl">Pattern</div><div class="choice">${PATTERNS.map(([k, l]) => `<button class="${w.pattern === k ? 'on' : ''}" data-action="wrap-set" data-field="pattern" data-value="${k}">
          <svg width="34" height="22"><defs>${patternDef(k, w.paper, w.patternColor, 'mini-' + k)}</defs><rect width="34" height="22" rx="4" fill="${k === 'plain' ? w.paper : `url(#mini-${k})`}" stroke="rgba(0,0,0,.15)"/></svg>${l}</button>`).join('')}</div></div>
        ${w.pattern !== 'plain' ? `<div class="ctl"><div class="lbl">Pattern color</div>${swatches('patternColor', w.patternColor)}</div>` : ''}
        <div class="ctl"><div class="lbl">Ribbon & bow</div>${swatches('ribbon', w.ribbon)}</div>
        <div class="ctl"><div class="lbl">Bow style</div><div class="choice">${BOWS.map(([k, l]) => `<button class="${w.bow === k ? 'on' : ''}" data-action="wrap-set" data-field="bow" data-value="${k}">${l}</button>`).join('')}</div></div>
        <div class="ctl"><div class="lbl">Topper</div><div class="choice emoji">${TOPPERS.map(t => `<button class="${w.topper === t ? 'on' : ''}" data-action="wrap-set" data-field="topper" data-value="${t}" title="${t || 'None'}">${t || '∅'}</button>`).join('')}</div></div>
        <label>Gift tag <span class="muted">(up to 10 characters)</span><input data-wrap="tag" maxlength="10" value="${esc(w.tag)}" placeholder="#1, 🎄, Fragile…"></label>
      </section>
    </div>
    <footer><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="save-gift">Save gift</button></footer>
  </div>`;
}
function refreshPreviews() {
  const wp = document.getElementById('wrap-preview'); if (wp) wp.innerHTML = presentSVG(draft.wrap);
  const ip = document.getElementById('img-preview');
  if (ip) ip.innerHTML = draft.img ? `<img src="${esc(draft.img)}" alt="" onerror="this.outerHTML='Couldn’t load that image'">` : 'No picture yet';
}
function closeModal() { $modal.classList.remove('show'); $modal.innerHTML = ''; draft = null; }

/* ---------------- events ---------------- */
const actions = {
  'remove-player': d => { state.players = state.players.filter(p => p.id !== d.id); commit(); },
  'add-gift': () => openEditor(),
  'edit-gift': d => openEditor(d.id),
  'remove-gift': d => { if (confirm('Delete this gift?')) { state.gifts = state.gifts.filter(g => g.id !== d.id); commit(); } },
  'close-modal': closeModal,
  'wrap-set': d => { draft.wrap[d.field] = d.value; renderEditor(); },
  'random-wrap': () => { draft.wrap = { ...randomWrap(draft.wrap.tag), topper: draft.wrap.topper }; renderEditor(); },
  'clear-img': () => { draft.img = ''; renderEditor(); },
  'save-gift': () => {
    if (!draft.name.trim()) return toast('Give the item a name first', true);
    const { _new, ...g } = draft; g.name = g.name.trim();
    const i = state.gifts.findIndex(x => x.id === g.id);
    if (i >= 0) state.gifts[i] = g; else state.gifts.push(g);
    if (!save()) { if (i < 0) state.gifts.pop(); return; }
    closeModal(); render(); toast(_new ? 'Gift added 🎁' : 'Gift updated');
  },
  'start': startGame,
  'pick': d => pickGift(d.id),
  'steal': d => stealGift(d.id),
  'swap': d => finalSwap(d.id),
  'keep': () => { snapshot(); log(`👍 ${player(G().order[0]).name} kept their gift.`); goReveal(); commit(); },
  'undo': undo,
  'force-reveal': () => { if (confirm('End the game now and go to the reveal?')) { snapshot(); goReveal(); commit(); } },
  'abandon': () => { if (confirm('Abandon this game and return to setup? Players and gifts are kept.')) { state.phase = 'setup'; state.game = null; undoStack = []; commit(); } },
  'reveal': d => showRevealModal(d.id),
  'close-reveal': () => { closeModal(); render(); },
  'play-again': () => { state.phase = 'setup'; state.game = null; undoStack = []; commit(); },
  'export': () => {
    const blob = new Blob([JSON.stringify({ players: state.players, gifts: state.gifts, settings: state.settings }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'white-elephant.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'reset-all': () => { if (confirm('Delete ALL players and gifts?')) { state = freshState(); undoStack = []; commit(); } },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !el.dataset.action) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener('submit', e => {
  if (e.target.dataset.form !== 'add-player') return;
  e.preventDefault();
  const input = e.target.elements.name;
  const names = input.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const existing = new Set(state.players.map(p => p.name.toLowerCase()));
  let dup = 0;
  for (const n of names) { if (existing.has(n.toLowerCase())) { dup++; continue; } existing.add(n.toLowerCase()); state.players.push({ id: uid(), name: n }); }
  if (dup) toast(`Skipped ${dup} duplicate name${dup > 1 ? 's' : ''}`, true);
  commit();
  document.querySelector('[data-form="add-player"] input')?.focus();
});
document.addEventListener('input', e => {
  const el = e.target; if (!draft) return;
  if (el.dataset.field === 'imgUrl') { draft.img = el.value.trim(); refreshPreviews(); }
  else if (el.dataset.field) draft[el.dataset.field] = el.value;
  else if (el.dataset.wrap) { draft.wrap[el.dataset.wrap] = el.value; refreshPreviews(); }
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.wrap && el.type === 'color' && draft) { renderEditor(); return; }
  if (el.dataset.toggle === 'peek') { peek = el.checked; render(); return; }
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    state.settings[k] = el.type === 'checkbox' ? el.checked : Math.max(1, parseInt(el.value, 10) || 1);
    commit(); return;
  }
  if (el.dataset.file === 'img' && el.files[0] && draft) {
    try { draft.img = await fileToDataURL(el.files[0]); renderEditor(); }
    catch { toast('Could not read that image', true); }
    return;
  }
  if (el.dataset.file === 'import' && el.files[0]) {
    try {
      const data = JSON.parse(await el.files[0].text());
      if (!Array.isArray(data.players) || !Array.isArray(data.gifts)) throw 0;
      state = { ...freshState(), players: data.players, gifts: data.gifts, settings: { ...freshState().settings, ...data.settings } };
      undoStack = []; commit(); toast('Imported!');
    } catch { toast('That file is not a White Elephant export', true); }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $modal.classList.contains('show')) {
    if (draft) closeModal(); else { closeModal(); render(); }
  }
});

render();
