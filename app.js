'use strict';
/* White Elephant — online groups via Supabase (anonymous sign-in + RPC + Realtime). */

const CFG = window.WE_CONFIG || {};
const PALETTE = ['#c0392b', '#e74c3c', '#ff6fa8', '#e67e22', '#f1c40f', '#1e8449', '#16a085',
  '#2e86c1', '#1b2a6b', '#8e44ad', '#ecf0f1', '#2c3e50', '#b9770e', '#d4af37'];
const PATTERNS = [['plain', 'Plain'], ['stripes', 'Stripes'], ['dots', 'Dots'], ['zigzag', 'Zigzag'],
  ['stars', 'Stars'], ['plaid', 'Plaid'], ['checks', 'Checks'], ['snow', 'Snow']];
const BOWS = [['classic', 'Classic'], ['pompom', 'Pom-pom'], ['star', 'Star'], ['none', 'None']];
const ELEPHANT = '<span class="ele" role="img" aria-label="elephant in a Santa hat">🐘<svg class="santa-hat" viewBox="0 0 100 80" aria-hidden="true"><path d="M12 62C28 30 54 6 88 20C74 26 66 42 70 62Z" fill="#d42a2a"/><path d="M40 34C52 22 66 16 80 18" stroke="#a01818" stroke-width="3" fill="none" opacity=".5"/><rect x="6" y="54" width="72" height="17" rx="8.5" fill="#fff"/><circle cx="88" cy="22" r="10" fill="#fff"/></svg></span>';
const TOPPERS = ['', '🎄', '⭐', '❄️', '🎅', '🦌', '🔔', '🍬', '☃️', '🐘', '❤️', '🍪', '🎉', '❓'];

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

let sb = null;          // supabase client
let S = null;           // state from get_state()
let groupId = null;
let channel = null, pollTimer = null, refreshTimer = null;
let lastSeq = null;     // last game event we've shown
let lastPaintKey = '';  // skip repaints when nothing changed
let draft = null;       // gift being edited
let busy = false;
let hostKey = null;     // fetched lazily for the host-link box
const contents = {};    // gift id -> {name, note, img, from} (only ones we're allowed to see)
let bigScreen = localStorage.getItem('we.big') === '1';
let siteInfo = null;       // {groups, max, weeks}
let joinPw = null;         // group password (host only)
let lastActive = null;     // for the "your turn" alert

/* ---------------- small helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const pickR = a => a[Math.floor(Math.random() * a.length)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg, bad = false) {
  $toast.textContent = msg; $toast.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.className = 'toast', 3200);
}
const fail = e => toast((e && e.message) || String(e), true);
async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}
/** run a server action once, then refresh */
async function act(fn) {
  if (busy) return; busy = true;
  try { await fn(); await refresh(true); } catch (e) { fail(e); } finally { busy = false; }
}
const myGroups = {
  list() { try { return JSON.parse(localStorage.getItem('we.groups')) || []; } catch { return []; } },
  save(l) { localStorage.setItem('we.groups', JSON.stringify(l)); },
  add(g) { const l = this.list().filter(x => x.id !== g.id); l.unshift({ ...this.list().find(x => x.id === g.id), ...g }); this.save(l.slice(0, 30)); },
  remove(id) { this.save(this.list().filter(x => x.id !== id)); },
};
function randomWrap(tag = '') {
  const paper = pickR(PALETTE), others = PALETTE.filter(c => c !== paper);
  return { paper, pattern: pickR(PATTERNS)[0], patternColor: pickR(others), ribbon: pickR(others),
    bow: pickR(['classic', 'pompom', 'star']), topper: '', tag };
}
function fmtDate(iso, withTime) {
  if (!iso) return '';
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}
const player = id => (S && S.players.find(p => p.id === id)) || { name: '?' };
const giftById = id => S && S.gifts.find(g => g.id === id);

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
const HEX = /^#[0-9a-fA-F]{6}$/;
/** never trust wrapping data from the server: only known-safe values reach the markup */
function cleanWrap(w) {
  w = w || {};
  const col = (v, d) => (HEX.test(v) ? v : d);
  return {
    paper: col(w.paper, '#c0392b'), patternColor: col(w.patternColor, '#ecf0f1'), ribbon: col(w.ribbon, '#f1c40f'),
    pattern: PATTERNS.some(p => p[0] === w.pattern) ? w.pattern : 'plain',
    bow: BOWS.some(b => b[0] === w.bow) ? w.bow : 'classic',
    topper: String(w.topper || '').slice(0, 8), tag: String(w.tag || '').slice(0, 10),
  };
}
function presentSVG(w) {
  w = cleanWrap(w);
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
const safeImg = u => /^(https?:\/\/|data:image\/(jpeg|png|gif|webp);base64,)/i.test(u || '');
function itemImg(c) {
  return c && safeImg(c.img)
    ? `<img src="${esc(c.img)}" alt="${esc(c.name)}" onerror="this.outerHTML='<div class=&quot;no-img&quot;>🖼️</div>'">`
    : `<div class="no-img">🎁</div>`;
}
async function fileToDataURL(file, max = 800) {
  const src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = src; });
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
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

/* ---------------- routing & sync ---------------- */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (h[0] === 'g' && h[1]) return { view: 'group', code: h[1].toLowerCase(), hostKey: h[2] === 'host' ? h[3] : null, rejoin: h[2] === 'rejoin' ? h[3] : null };
  if (h[0] === 'help') return { view: 'help' };
  return { view: 'home' };
}
let routeSeq = 0;
async function route() {
  leaveGroup();
  const seq = ++routeSeq;
  const r = parseRoute();
  if (r.view === 'help') { renderHelp(); window.scrollTo(0, 0); return; }
  if (r.view === 'home') {
    renderHome();
    try { siteInfo = await rpc('site_info'); if (parseRoute().view === 'home') renderHome(); } catch { }
    return;
  }
  paint('<div class="loading">Loading…</div>');
  if (r.hostKey) {
    try { const id = await rpc('claim_host', { p_code: r.code, p_key: r.hostKey }); myGroups.add({ id, code: r.code, host: true }); toast('You are the host of this group 👑'); }
    catch (e) { fail(e); }
    history.replaceState(null, '', `#/g/${r.code}`);
  }
  if (r.rejoin) {
    try { await rpc('rejoin', { p_code: r.code, p_token: r.rejoin }); toast('Welcome back! You’re reconnected 🎉'); }
    catch (e) { fail(e); }
    history.replaceState(null, '', `#/g/${r.code}`);
  }
  if (seq !== routeSeq) return;
  openGroup(r.code, seq);
}
async function openGroup(code, seq) {
  let info;
  try { info = await rpc('group_info', { p_code: code }); } catch (e) { return renderMessage('Something went wrong', e.message); }
  if (seq !== routeSeq) return;   // the user navigated elsewhere while this was loading
  if (!info) return renderMessage('Invite not found', "That link doesn't match any group. Double-check you copied the whole thing.");
  if (!info.member) return renderJoin(info);
  groupId = info.id;
  subscribe();
  await refresh();
}
async function refresh(force) {
  if (!groupId) return;
  const gidAtStart = groupId;
  let next;
  try { next = await rpc('get_state', { p_group: groupId }); }
  catch (e) {
    if (/not in this group|not found/i.test(e.message)) {
      myGroups.remove(groupId);
      toast(/not found/i.test(e.message) ? 'This group has ended — the host closed it or it expired.' : e.message, true);
      location.hash = '#/';
    }
    else console.warn(e);
    return;
  }
  if (gidAtStart !== groupId) return;
  const paintKey = JSON.stringify(next);
  const changed = paintKey !== lastPaintKey;
  lastPaintKey = paintKey;
  if (next.group.phase === 'lobby') for (const x of next.gifts) if (!x.mine) delete contents[x.id];  // no stale reveals after "play again"
  S = next;
  if (S.group.is_host && hostKey === null) {
    try { const sec = await rpc('host_secrets', { p_group: groupId }); hostKey = sec.host_key; joinPw = sec.join_password || ''; } catch { }
  }
  myGroups.add({ id: S.group.id, code: S.group.code, name: S.group.name, host: S.group.is_host });
  await ensureContents();
  if (changed || force) render();
  handleEvent(S.group.game && S.group.game.event);
  const guidedNow = !!(S.group.game && S.group.game.guided);
  if (wasGuided && !guidedNow && !S.group.is_host && document.getElementById('stage')) closeModal();
  wasGuided = guidedNow;
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }
function subscribe() {
  if (channel) sb.removeChannel(channel);
  clearInterval(pollTimer);
  channel = sb.channel('group-' + groupId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'groups', filter: `id=eq.${groupId}` }, scheduleRefresh)
    .subscribe(status => { if (status === 'SUBSCRIBED') scheduleRefresh(); });
  pollTimer = setInterval(refresh, 8000); // safety net if realtime drops
}
function leaveGroup() {
  if (channel) sb.removeChannel(channel);
  channel = null; clearInterval(pollTimer); groupId = null; S = null; lastSeq = null; lastPaintKey = ''; hostKey = null; joinPw = null; lastActive = null;
  document.title = 'White Elephant 🐘';
  closeModal();
}
async function ensureContents() {
  const g = S.group, rev = g.phase === 'reveal' ? (g.game && g.game.revealed) || [] : [];
  const need = S.gifts.filter(x => (x.mine || rev.includes(x.id)) && !contents[x.id]);
  await Promise.all(need.map(async x => { try { contents[x.id] = await rpc('get_gift', { p_gift: x.id }); } catch { } }));
}
function handleEvent(ev) {
  const seq = ev ? ev.seq : 0;
  if (lastSeq === null || seq <= lastSeq) { lastSeq = seq; return; } // first load or undo: no animation
  lastSeq = seq;
  if (ev.type === 'reveal') showRevealModal(ev.gift);
  else if (ev.text) toast(ev.text);
}
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

/* ---------------- rendering ---------------- */
/** replace #app while keeping any half-typed [data-keep] inputs */
function paint(html) {
  const keep = {}; let focus = null;
  $app.querySelectorAll('[data-keep]').forEach(el => { keep[el.name] = el.value; if (el === document.activeElement) focus = el.name; });
  const openDetails = [...$app.querySelectorAll('details[open]')].map(d => d.className);
  $app.innerHTML = html;
  openDetails.forEach(c => { const d = c && $app.querySelector(`details.${c.split(' ')[0]}`); if (d) d.open = true; });
  for (const [k, v] of Object.entries(keep)) { const el = $app.querySelector(`[data-keep][name="${k}"]`); if (el) el.value = v; }
  if (focus) $app.querySelector(`[data-keep][name="${focus}"]`)?.focus();
}
function setSteps(phase) {
  const isHost = !!(phase && S && S.group.is_host);
  document.body.classList.toggle('is-host', isHost);
  const rb = document.getElementById('rolebar');
  rb.hidden = !isHost;
  rb.innerHTML = isHost ? '<b>👑 HOST VIEW</b><span>You are running this group. Players don’t see the host controls.</span>' : '';
  const steps = [['lobby', 'Lobby'], ['play', 'Play'], ['final', S && (S.group.settings.rounds || 1) > 1 ? 'Swap rounds' : 'Final round'], ['reveal', 'Reveal']];
  document.getElementById('steps').innerHTML = phase
    ? steps.map(([k, l]) => `<span class="${phase === k ? 'on' : ''}">${l}</span>`).join('') +
      (phase !== 'lobby' ? `<button class="screen-btn" data-action="toggle-big" title="Bigger board for screen sharing">📺 ${bigScreen ? 'Normal view' : 'Big screen'}</button>` : '')
    : '';
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.17);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { }
}
function turnAlert() {
  const g = S.group, active = (g.phase === 'play' || g.phase === 'final') && g.game ? g.game.active : null;
  const mine = !!active && active === S.me;
  document.title = mine ? '🎯 YOUR TURN — White Elephant' : 'White Elephant 🐘';
  if (mine && lastActive !== active) { beep(); if (document.hidden) toast('🎯 It’s your turn!'); }
  lastActive = active;
}
function render() {
  if (!S) return;
  turnAlert();
  const p = S.group.phase;
  setSteps(p);
  document.body.classList.toggle('big', bigScreen && p !== 'lobby');
  if (p === 'lobby') renderLobby();
  else if (p === 'reveal') renderReveal();
  else renderPlay();
}
function renderMessage(title, body) {
  setSteps(null);
  paint(`<div class="home"><section class="panel hero"><h2>${esc(title)}</h2><p>${esc(body)}</p><a class="btn" href="#/">← Home</a></section></div>`);
}

/* ---- help ---- */
function renderHelp() {
  setSteps(null); document.body.classList.remove('big');
  document.title = 'How it works — White Elephant';
  const shot = (f, cap) => `<figure class="shot"><a href="help/${f}.webp" target="_blank" rel="noopener"><img src="help/${f}.webp" alt="${cap}" loading="lazy"></a><figcaption>${cap}</figcaption></figure>`;
  paint(`<div class="help">
    <section class="panel hero">
      <h2>${ELEPHANT} How it works</h2>
      <p>A White Elephant gift exchange you play together over a Discord call. Everyone opens the same group in their own browser and the screens stay in sync.</p>
      <ol class="flow">
        <li><b>Set up.</b> The host creates a group and shares the invite link.</li>
        <li><b>Add gifts.</b> Each player joins, adds one gift and designs its wrapping.</li>
        <li><b>Play.</b> On your turn, pick a wrapped present from the pile or steal one someone already has.</li>
        <li><b>Reveal.</b> When every present has an owner, they are unwrapped one by one.</li>
      </ol>
      <p class="muted">Nobody, not even the host, can see what is inside someone else's present until it is unwrapped.</p>
      <p class="row"><button class="btn small" data-action="help-jump" data-id="help-host">👑 I'm hosting</button><button class="btn small" data-action="help-jump" data-id="help-player">🎁 I'm playing</button><button class="btn small" data-action="help-jump" data-id="help-faq">💡 Good to know</button></p>
    </section>

    <section class="panel" id="help-host">
      <h2>👑 If you are the host</h2>
      <h3>1. Create the group</h3>
      <ul>
        <li>On the home page, enter a group name. Add your own name if you are also playing, or leave it blank to host only.</li>
        <li>A group password is optional. If you set one, friends need it to join.</li>
        <li>The site holds a limited number of groups, and every group is deleted automatically 8 weeks after it is created.</li>
      </ul>
      <h3>2. Get everyone into the lobby</h3>
      ${shot('host-lobby', 'The host lobby: invite link, players, your gift and the host controls')}
      <ul>
        <li><b>Gold "HOST VIEW" bar.</b> It appears at the top of every screen while you are the host. Players never see it.</li>
        <li><b>Invite link.</b> Copy it, or use "Copy invite message for Discord", which writes the invitation for you.</li>
        <li><b>Your host link.</b> Under "👑 Your host link (keep secret)". Save it somewhere private. It makes any browser the host, so it is how you get back in from another device. Don't share it.</li>
        <li><b>Players list.</b> 🎁 means a gift is added, ⏳ means still waiting. Use ✕ to remove someone, and 🔄 to make a personal rejoin link for a player who switched device.</li>
        <li><b>Add a gift for someone</b> who can't add their own. You can see the contents of gifts you entered yourself.</li>
        <li><b>Event date.</b> Set it and press Save. Everyone sees it in their own time zone.</li>
      </ul>
      <h3>3. Choose the rules</h3>
      <ul>
        <li><b>Signups open.</b> Turn it off to stop new people joining.</li>
        <li><b>Max steals per gift.</b> After that many steals a present is locked 🔒 to its holder.</li>
        <li><b>Rounds.</b> How many times play goes around the group (1 to 5). Round 1 is the normal pick-or-steal. In each extra round every player, in the same order, may swap with any unlocked present or keep theirs.</li>
        <li><b>No immediate steal-backs.</b> A player who was just robbed can't take the same present straight back.</li>
        <li><b>First player gets a final swap.</b> Whoever went first gets one last swap at the end, since they had nothing to steal on their turn.</li>
        <li><b>Players can't pick or steal the gift they brought,</b> unless it is the last one left.</li>
      </ul>
      <p>"Start the game" stays disabled, with the reason shown next to it, until the group is ready. Starting puts the players in a random order.</p>
      <h3>4. Run the game</h3>
      ${shot('host-play', 'The host view during play, with the gift tracker and the host panel')}
      <ul>
        <li>The banner shows whose turn it is. You can click for any player, which helps if someone is away or having trouble. When it is not your own turn, a gold notice and the button labels ("Pick for Alice") make clear you are acting for someone else.</li>
        <li><b>Undo</b> takes back the last move. <b>Skip to reveal</b> ends play early. <b>Back to lobby</b> resets the game and keeps the players and gifts.</li>
        <li><b>📺 Big screen</b> enlarges the board for sharing your screen on Discord. The turn order, host buttons and play-by-play stay visible beside it.</li>
        <li>The <b>gift tracker</b> shows every hand each present has passed through.</li>
      </ul>
      <h3>5. The reveal and afterwards</h3>
      ${shot('host-results', 'The results after everything is unwrapped')}
      <ul>
        <li>Press "🎁 Unwrap all, one at a time". The first present opens on everyone's screen, and each time you press "Next present ▶" the next one opens. Players wait for you and can't unwrap anything themselves.</li>
        <li>If you would rather let people open their own, skip that button. You can tap any single present, and each player can tap theirs.</li>
        <li>When everything is open, "Copy results for Discord" gives you a list of who got what.</li>
        <li>"Play again" returns to the lobby. "End group now" deletes the group for everyone and frees its slot. It can't be undone.</li>
      </ul>
    </section>

    <section class="panel" id="help-player">
      <h2>🎁 If you are a player</h2>
      <h3>1. Join</h3>
      <ul>
        <li>Open the invite link from your host, type your name, and enter the group password if there is one.</li>
        <li>There is no account. The site remembers you by the browser you joined with, so <b>keep using the same browser on the same device</b>. A private window or another device looks like a new person.</li>
      </ul>
      <h3>2. Add your gift</h3>
      ${shot('player-lobby', 'A player in the lobby: your own gift is visible, the others are only wrapping')}
      <ul>
        <li>Press "+ Add my gift". Give it a name, an optional note, and a picture (upload one or paste an image link).</li>
        <li>Design the wrapping: paper colour, pattern, ribbon, bow, a topper and a tag.</li>
        <li>Everyone sees your wrapping. Only you see what is inside. You can edit or delete it until the game starts.</li>
        <li>Then wait in the lobby. The game starts when the host presses start.</li>
      </ul>
      <h3>3. Your turn</h3>
      ${shot('player-play', 'A player during the game: the pile, the claimed presents and the turn order')}
      <ul>
        <li>When it is your turn the banner says "You're up!", the tab title changes and a short sound plays.</li>
        <li><b>Pick</b> a present from "Under the tree", or <b>steal</b> one from "Claimed". Presents stay wrapped the whole game, so you are choosing by the wrapping.</li>
        <li>If someone steals yours, you go again straight away: pick from the pile or steal a different one.</li>
        <li>A present you can't take is greyed out with the reason, such as locked 🔒 after too many steals, or it is the one you brought.</li>
        <li>If the host set more than one round, play goes around again after everyone has a present. On those turns you swap yours with any unlocked present, or keep it.</li>
        <li>If the host allows it, the first player gets a final swap at the end.</li>
        <li>When it is not your turn there is nothing to do but watch. Your screen updates by itself.</li>
      </ul>
      <h3>4. The reveal</h3>
      ${shot('player-reveal', 'A present being unwrapped, as every player sees it')}
      <ul>
        <li>Usually the host unwraps everything one present at a time. Each present stays on your screen until the host moves on to the next one, and you close the last one yourself.</li>
        <li>If the host leaves it to the players instead, tap your own present to unwrap it. Either way everyone sees the animation at the same moment.</li>
        <li>At the end you can see who got what and who brought it, and copy the results.</li>
      </ul>
    </section>

    <section class="panel" id="help-faq">
      <h2>💡 Good to know</h2>
      <dl class="faq">
        <dt>I closed the tab or my computer restarted.</dt>
        <dd>Nothing is lost. Open the invite link again in the same browser and you are back where you were. The game is stored online, not on anyone's computer.</dd>
        <dt>I'm a player and I switched device or browser, or cleared my browser data.</dt>
        <dd>Ask the host for a personal rejoin link (the 🔄 next to your name). It works once and puts you back in your seat with your gift.</dd>
        <dt>I'm the host and I switched device.</dt>
        <dd>Open your host link on the new device. If you didn't save it, open the group on the original browser and copy it from the lobby. Without either, nobody can host that group.</dd>
        <dt>My screen looks stuck.</dt>
        <dd>Screens normally update within a second or two, and at worst within about 8 seconds. Refreshing the page is always safe.</dd>
        <dt>Can other people see my gift?</dt>
        <dd>They see the wrapping only. The name, note and photo stay hidden from everyone else until it is unwrapped. If the host entered a gift for you, the host can see that one.</dd>
        <dt>How long does a group last?</dt>
        <dd>8 weeks from the day it was created, or until the host ends it. The lobby shows both dates. After that the group, its gifts and its results are deleted.</dd>
      </dl>
      <p><a class="btn" href="#/">← Home</a></p>
    </section>
  </div>`);
}

function renderHome() {
  setSteps(null); document.body.classList.remove('big');
  const list = myGroups.list();
  paint(`<div class="home">
    <section class="panel hero">
      <h2>🎁 Start a gift exchange</h2>
      <p class="muted">Create a group, drop the invite link in Discord, and everyone adds their own gift and wraps it their way.
        What's inside stays secret from everyone (even the host) until the final reveal.</p>
      <form data-form="create">
        <label>Group name<input name="gname" data-keep maxlength="60" required placeholder="e.g. Discord Holiday Swap"></label>
        <label>Your name <span class="muted">(leave blank if you're only hosting, not playing)</span><input name="hname" data-keep maxlength="40" placeholder="Your display name"></label>
        <label>Group password <span class="muted">(optional — friends will need it to join)</span><input name="pw" data-keep minlength="4" maxlength="40" autocomplete="off" placeholder="e.g. eggnog"></label>
        <button class="btn primary big" ${siteInfo && siteInfo.groups >= siteInfo.max ? 'disabled' : ''}>Create group</button>
        ${siteInfo ? `<p class="muted">${siteInfo.groups} of ${siteInfo.max} group slots in use · every group is deleted automatically ${siteInfo.weeks} weeks after it is created${siteInfo.groups >= siteInfo.max ? '<br><b>All slots are full right now.</b> One frees up when a host deletes their group or it expires.' : ''}</p>` : ''}
      </form>
    </section>
    ${list.length ? `<section class="panel"><h2>Your groups</h2><ul class="group-list">${list.map(g => `
      <li><a href="#/g/${esc(g.code)}">${esc(g.name || g.code)}</a>${g.host ? ' <span class="badge">host</span>' : ''}
      <button class="icon-btn" data-action="forget-group" data-id="${esc(g.id)}" title="Remove from this list">✕</button></li>`).join('')}</ul></section>` : ''}
    <p class="center hint">Got an invite link? Just open it. · <a href="#/help">How it works</a></p>
  </div>`);
}

function renderJoin(info) {
  setSteps(null);
  const closed = info.phase !== 'lobby' || !info.signups_open;
  paint(`<div class="home"><section class="panel hero">
    <h2>${ELEPHANT} You're invited to <span class="hl">${esc(info.name)}</span></h2>
    ${info.event_at ? `<p>📅 <b>${esc(fmtDate(info.event_at, true))}</b></p>` : ''}
    ${closed ? `<p class="warn-box">${info.phase !== 'lobby' ? 'This game has already started.' : 'Signups are closed.'}
      If the host already added you, enter the exact same name to claim your spot.</p>`
      : '<p class="muted">Use the name people know you by on Discord. Next you’ll add your gift.</p>'}
    <form data-form="join" data-code="${esc(info.code)}">
      <label>Your name<input name="name" data-keep maxlength="40" required autocomplete="nickname"></label>
      ${info.needs_password ? '<label>🔑 Group password <span class="muted">(ask the host)</span><input name="pw" data-keep maxlength="40" required autocomplete="off"></label>' : ''}
      <button class="btn primary big">Join the group</button>
    </form>
  </section></div>`);
}

function inviteURL(code) { return `${location.origin}${location.pathname}#/g/${code}`; }

function renderLobby() {
  const { group: g, players, gifts, me } = S, host = g.is_host, s = g.settings;
  const mine = gifts.filter(x => x.mine);
  const own = me && (mine.find(x => x.from === me) || (!host && mine[0]));
  const waiting = players.filter(p => !p.has_gift);
  const problems = [];
  if (players.length < 2) problems.push('Need at least 2 players');
  if (gifts.length < players.length) problems.push(`Need ${players.length - gifts.length} more gift${players.length - gifts.length === 1 ? '' : 's'}`);
  const invite = inviteURL(g.code);

  paint(`
  <div class="banner"><p class="who">${esc(g.name)}</p>
    <div class="sub">${players.length} player${players.length === 1 ? '' : 's'} · ${gifts.length} gift${gifts.length === 1 ? '' : 's'} · signups ${g.signups_open ? 'open ✅' : 'closed 🔒'}</div>
    <div class="dates">${g.event_at ? `<span class="evt">📅 Event: <b>${esc(fmtDate(g.event_at, true))}</b></span>` : `<span class="evt muted-light">📅 No event date set${host ? ' yet (set it under Host controls)' : ''}</span>`}
      <span>Started ${esc(fmtDate(g.created_at))}</span><span>Ends ${esc(fmtDate(g.expires_at))} (${Math.max(0, Math.ceil((new Date(g.expires_at) - Date.now()) / 864e5))} days left, then the group is deleted)</span></div></div>
  <div class="lobby">
    <div class="col">
      <section class="panel">
        <h2>🔗 Invite link</h2>
        <div class="copy-row"><input readonly value="${esc(invite)}"><button class="btn primary" data-action="copy" data-text="${esc(invite)}">Copy</button></div>
        <p class="muted">Paste it in Discord. Anyone with the link can join while signups are open.</p>
        ${host ? `<div class="pwrow">🔑 Group password: ${joinPw ? `<code>${esc(joinPw)}</code>` : '<span class="muted">none — anyone with the link can join</span>'}
            <button class="btn small" data-action="change-pw">${joinPw ? 'Change' : 'Set one'}</button></div>
          <div class="row" style="margin-top:10px"><button class="btn" data-action="copy-invite">📋 Copy invite message for Discord</button></div>
          <details class="hostlink"><summary>👑 Your host link <span class="muted">(keep secret)</span></summary>
          ${hostKey ? `<div class="copy-row"><input readonly value="${esc(invite)}/host/${esc(hostKey)}"><button class="btn" data-action="copy" data-text="${esc(invite)}/host/${esc(hostKey)}">Copy</button></div>
          <p class="muted">Open this on any other device to manage the group from there. Don’t share it — whoever opens it becomes the host.</p>` : ''}</details>`
          : (g.has_password ? '<p class="muted">🔑 New players also need the group password — ask the host.</p>' : '')}
      </section>
      <section class="panel">
        <h2>👥 Players <span class="count">${players.length}</span></h2>
        <ul class="plist">${players.map(p => `<li>
          <span class="st" title="${p.has_gift ? 'Gift added' : 'No gift yet'}">${p.has_gift ? '🎁' : '⏳'}</span>
          <span class="nm">${esc(p.name)}${p.id === me ? ' <span class="badge">you</span>' : ''}${!p.joined ? ' <span class="muted">· not connected yet</span>' : ''}</span>
          ${host && p.id !== me ? `<button class="icon-btn" data-action="release-player" data-id="${p.id}" title="Personal rejoin link (they switched device)">🔄</button>` : ''}
          ${host || p.id === me ? `<button class="icon-btn" data-action="remove-player" data-id="${p.id}" title="${p.id === me ? 'Leave group' : 'Remove'}">✕</button>` : ''}
        </li>`).join('') || '<li class="muted">Nobody yet — share the invite link!</li>'}</ul>
        ${host ? `<form data-form="add-player" class="row" style="margin-top:10px"><input name="pname" data-keep maxlength="40" placeholder="Add someone who can't use the link" style="flex:1"><button class="btn">Add</button></form>` : ''}
        <p class="muted">🎁 gift added · ⏳ still needs one${host ? ' · 🔄 makes a personal rejoin link if someone switches device' : ''}</p>
      </section>
    </div>
    <div class="col">
      ${me ? myGiftPanel(own) : ''}
      <section class="panel">
        <h2>🎄 Under the tree <span class="count">${gifts.length}</span></h2>
        ${gifts.length ? `<div class="gift-grid">${gifts.map(x => `<div class="gift-card ${x.mine ? 'mine' : ''}">
            ${presentSVG(x.wrap)}
            ${x.mine ? `<div class="item-name">${esc(contents[x.id]?.name || '')}${x.from && x.from !== me ? ` · for ${esc(player(x.from).name)}` : ''}</div>` : ''}
            ${host || x.mine ? `<div class="card-actions">
              ${x.mine ? `<button class="btn small" data-action="edit-gift" data-id="${x.id}">Edit</button>` : ''}
              <button class="btn small danger" data-action="remove-gift" data-id="${x.id}">Delete</button></div>` : ''}
          </div>`).join('')}</div>` : '<div class="empty">No gifts yet.</div>'}
        ${host ? `<div class="row" style="margin-top:12px"><button class="btn" data-action="add-gift" data-for="">+ Add a gift for someone</button>
          <span class="muted">for people who can’t add their own</span></div>` : ''}
      </section>
      ${host ? `<section class="panel">
        <h2>👑 Host controls</h2>
        <label>📅 Event date &amp; time <span class="muted">(shown to everyone, in their own time zone)</span>
          <span class="row"><input type="datetime-local" name="evt" data-keep value="${toLocalInput(g.event_at)}" style="flex:1;width:auto">
          <button class="btn" data-action="save-event">Save</button>${g.event_at ? '<button class="btn ghost" data-action="clear-event">Clear</button>' : ''}</span></label>
        <label class="toggle"><input type="checkbox" data-setting="signups" ${g.signups_open ? 'checked' : ''}> Signups open</label>
        <label class="inline-num">Max steals per gift <input type="number" name="maxSteals" data-keep min="1" max="20" value="${s.maxSteals}" data-setting="maxSteals"></label>
        <label class="inline-num">Rounds <input type="number" name="rounds" data-keep min="1" max="5" value="${s.rounds || 1}" data-setting="rounds">
          <span class="muted">times around the group. After round 1, each turn is swap-or-keep.</span></label>
        <label class="toggle"><input type="checkbox" data-setting="noStealBack" ${s.noStealBack ? 'checked' : ''}> No immediate steal-backs</label>
        <label class="toggle"><input type="checkbox" data-setting="finalSwap" ${s.finalSwap ? 'checked' : ''}> First player gets a final swap</label>
        <label class="toggle"><input type="checkbox" data-setting="noOwnGift" ${s.noOwnGift !== false ? 'checked' : ''}> Players can't pick or steal the gift they brought <span class="muted">(unless it's the last one left)</span></label>
        ${waiting.length ? `<p class="muted">Still waiting on gifts from: ${waiting.map(p => esc(p.name)).join(', ')}</p>` : ''}
        <div class="start-row">
          ${problems.length ? `<span class="warn">⚠ ${problems.join(' · ')}</span>` : ''}
          <button class="btn primary big" data-action="start" ${problems.length ? 'disabled' : ''}>Start the game 🎉</button>
        </div>
        <div class="end-row"><button class="btn small danger" data-action="delete-group">End group now</button>
          <span class="muted">Deletes the group for everyone and frees up its slot. Otherwise it ends by itself on ${esc(fmtDate(g.expires_at))}.</span></div>
      </section>` : `<section class="panel waiting">⏳ Waiting for the host to start the game…</section>`}
    </div>
  </div>`);
}
function myGiftPanel(x) {
  if (!x) return `<section class="panel your-gift"><h2>🎁 Your gift</h2>
    <div class="empty">You haven't added your gift yet.<br><br><button class="btn primary big" data-action="add-gift" data-for="${S.me}">+ Add my gift</button></div></section>`;
  const c = contents[x.id] || {};
  return `<section class="panel your-gift"><h2>🎁 Your gift</h2>
    <div class="my-gift${safeImg(c.img) ? '' : ' no-photo'}">
      <div class="my-wrap">${presentSVG(x.wrap)}</div>
      ${safeImg(c.img) ? `<div class="my-inside">${itemImg(c)}</div>` : ''}
      <div class="my-info"><b>${esc(c.name || '')}</b>${c.note ? `<p>${esc(c.note)}</p>` : ''}
        <p class="muted">Everyone sees the wrapping. Only you can see what's inside until the reveal.</p>
        <div class="row"><button class="btn small" data-action="edit-gift" data-id="${x.id}">Edit</button>
        <button class="btn small danger" data-action="remove-gift" data-id="${x.id}">Delete</button></div></div>
    </div></section>`;
}

/* ---- play ---- */
function holderMap() { return (S.group.game && S.group.game.holdings) || {}; }
function giftOf(pid) { const h = holderMap(); return Object.keys(h).find(k => h[k] === pid); }
function stealBlock(gid, pid) {
  const st = S.group.game, h = st.holdings[gid], max = S.group.settings.maxSteals;
  if (!h) return 'Not claimed yet';
  if (h === pid) return 'That one is yours';
  if ((st.steals[gid] || 0) >= max) return 'Locked — max steals reached';
  if (S.group.phase === 'play' && S.group.settings.noStealBack && (st.blocked[pid] || []).includes(gid)) return 'No immediate steal-backs';
  return '';
}
function playCard(gid, mode, canAct) {
  const st = S.group.game, x = giftById(gid), holder = st.holdings[gid];
  const steals = st.steals[gid] || 0, max = S.group.settings.maxSteals, final = S.group.phase === 'final';
  let action, why = '', cta;
  const forName = S.group.is_host && st.active && st.active !== S.me ? player(st.active).name : null;   // host acting for someone else
  if (mode === 'pile') { action = 'pick'; cta = forName ? `Pick for ${esc(forName)}` : 'Pick me!'; }
  else { action = final ? 'swap' : 'steal'; cta = forName ? `${final ? 'Swap' : 'Steal'} for ${esc(forName)}` : final ? 'Swap!' : 'Steal!'; why = stealBlock(gid, st.active); }
  if (!canAct) why = why || 'Not your turn';
  const brought = x && x.from && x.from === S.me;   // only ever known for your own gift
  if (!why && brought && st.active === S.me && S.group.settings.noOwnGift !== false) {
    const pileOthers = S.gifts.some(o => o.id !== gid && !st.holdings[o.id]);
    if (mode !== 'pile' || pileOthers) why = "That's the gift you brought";
  }
  const isMine = holder && holder === S.me;
  return `<button class="gift-card ${isMine ? 'mine' : ''}" data-action="${action}" data-id="${gid}" ${why ? 'disabled' : ''} title="${esc(why)}">
    <span class="cta">${cta}</span>
    ${presentSVG(x && x.wrap)}
    ${holder ? `<div class="owner">${esc(player(holder).name)}${isMine ? ' (you)' : ''}</div>
      <div class="pips" title="${steals}/${max} steals">${'●'.repeat(Math.min(steals, max))}${'○'.repeat(Math.max(0, max - steals))}</div>` : ''}
    ${steals >= max ? '<span class="lock" title="Locked">🔒</span>' : ''}
    ${brought ? '<span class="brought" title="Only you can see this">you brought this</span>' : ''}
  </button>`;
}
function renderPlay() {
  const g = S.group, st = g.game, final = g.phase === 'final', host = g.is_host, me = S.me;
  const active = st.active, isMe = active && active === me, canAct = host || isMe;
  const turnPlayer = final ? null : st.order[st.turn];
  const chain = !final && active !== turnPlayer;
  const name = esc(player(active).name);
  const pile = S.gifts.filter(x => !st.holdings[x.id]).map(x => x.id);
  const held = st.order.map(giftOf).filter(Boolean);
  let who, sub;
  // swap-or-keep turns: extra rounds first (queue holds every turn), then the first player's final swap
  const qi = st.qi || 0, nP = st.order.length, R = st.rounds || 1, inRound = final && qi < (R - 1) * nP;
  if (inRound) {
    const rn = 2 + Math.floor(qi / nP);
    who = isMe ? `🔁 Round ${rn} of ${R} — <em>you’re</em> up!` : `🔁 Round ${rn} of ${R}: <em>${name}</em>`;
    sub = `Turn ${qi % nP + 1} of ${nP} — swap with any unlocked gift, or keep yours.`;
  }
  else if (final) { who = isMe ? '🏁 Final swap — <em>your call!</em>' : `🏁 Final round: <em>${name}</em>`; sub = 'Swap with any unlocked gift, or keep yours.'; }
  else if (chain) { who = isMe ? '😱 <em>You</em> got robbed!' : `😱 <em>${name}</em> got robbed!`; sub = 'Pick a new gift from the pile or steal another.'; }
  else { who = isMe ? '🎯 <em>You’re</em> up!' : `<em>${name}</em> is up`; sub = `Turn ${st.turn + 1} of ${st.order.length} — pick from the pile${held.length ? ' or steal' : ''}.`; }
  const proxy = host && !isMe;
  if (!isMe && !host) sub += ` Waiting for ${name}…`;

  paint(`
  <div class="banner"><p class="who">${who}</p><div class="sub">${sub}</div>
    ${proxy ? `<div class="proxy-note">👑 <b>${me ? 'This is not your turn.' : 'You are hosting, not playing.'}</b> Anything you click now is done <b>for ${name}</b>. Only do it if they can’t click themselves.</div>` : ''}</div>
  <div class="play${proxy ? ' proxy' : ''}">
    <div>
      ${final ? '' : `<section class="panel"><h2>🎄 Under the tree <span class="count">${pile.length}</span></h2>
        ${pile.length ? `<div class="gift-grid">${pile.map(id => playCard(id, 'pile', canAct)).join('')}</div>` : '<div class="empty">The pile is empty.</div>'}</section>`}
      <section class="panel"><h2>🙌 Claimed (still wrapped) <span class="count">${held.length}</span></h2>
        ${held.length ? `<div class="gift-grid">${held.map(id => playCard(id, 'held', canAct)).join('')}</div>` : '<div class="empty">Nobody has a gift yet.</div>'}
        ${final && canAct ? `<div class="row" style="justify-content:center;margin-top:16px"><button class="btn primary big" data-action="keep">${isMe ? 'Keep my gift' : `Keep ${name}’s gift for them`} 👍</button></div>` : ''}
      </section>
      ${trackerPanel()}
    </div>
    <aside>
      <section class="panel"><h2>Turn order</h2>
        <ol class="order">${st.order.map((pid, i) => {
          const cur = pid === active, done = (inRound ? i < qi % nP : !final && i < st.turn) && !cur;
          return `<li class="${cur ? 'cur' : ''} ${done ? 'done' : ''}"><span class="n">${i + 1}</span>${cur ? '▶ ' : ''}${esc(player(pid).name)}${pid === me ? ' <span class="badge">you</span>' : ''}${giftOf(pid) ? ' 🎁' : ''}${host && pid !== me && player(pid).joined ? `<button class="icon-btn" style="margin-left:auto" data-action="release-player" data-id="${pid}" title="Personal rejoin link (they switched device)">🔄</button>` : ''}</li>`;
        }).join('')}</ol></section>
      ${host ? `<section class="panel"><h2>👑 Host</h2><div class="controls">
        <button class="btn small" data-action="undo" ${g.can_undo ? '' : 'disabled'}>↶ Undo</button>
        <button class="btn small" data-action="end">Skip to reveal</button>
        <button class="btn small danger" data-action="reset">Back to lobby</button>
        <button class="btn small danger" data-action="delete-group">End group now</button></div></section>` : ''}
      <section class="panel"><h2>📜 Play-by-play</h2><ul class="log">${(st.log || []).slice(0, 40).map(l => `<li>${esc(l)}</li>`).join('')}</ul></section>
    </aside>
  </div>`);
}

/* ---- gift tracker: every gift and who has held it, in order ---- */
function trackerPanel() {
  const st = S.group.game, trail = st.trail || {}, rev = st.revealed || [], max = S.group.settings.maxSteals;
  const rows = S.gifts.slice().sort((a, b) => (trail[b.id] ? 1 : 0) - (trail[a.id] ? 1 : 0)).map(x => {
    const t = trail[x.id] || [], c = rev.includes(x.id) ? contents[x.id] : null, steals = st.steals[x.id] || 0;
    const chain = t.length
      ? t.map((pid, i) => `<span class="chip ${i === t.length - 1 ? 'now' : ''}">${esc(player(pid).name)}</span>`).join('<span class="arrow">→</span>')
      : '<span class="muted">still under the tree</span>';
    return `<div class="trk-row">
      <div class="trk-gift">${presentSVG(x.wrap)}</div>
      <div class="trk-body">
        ${c ? `<div class="trk-item">${safeImg(c.img) ? `<img src="${esc(c.img)}" alt="">` : ''}<b>${esc(c.name)}</b>${c.from ? `<span class="muted">from ${esc(player(c.from).name)}</span>` : ''}</div>` : ''}
        <div class="trk-chain">${chain}</div>
      </div>
      <div class="trk-steals">${steals ? `😈 ×${steals}` : ''}${steals >= max ? ' 🔒' : ''}</div>
    </div>`;
  }).join('');
  return `<section class="panel tracker"><h2>🧭 Gift tracker <span class="muted">who has held each gift</span></h2>${rows}</section>`;
}

/* ---- reveal ---- */
function revealList() {
  const st = S.group.game;
  const held = st.order.map(pid => ({ pid, gid: giftOf(pid) })).filter(x => x.gid);
  const extra = S.gifts.filter(x => !st.holdings[x.id]).map(x => ({ pid: null, gid: x.id }));
  return held.concat(extra);
}
function renderReveal() {
  const g = S.group, st = g.game, host = g.is_host, rev = st.revealed || [];
  const list = revealList(), next = list.find(x => !rev.includes(x.gid));
  const guided = !!st.guided;   // host is unwrapping everything one at a time; players wait
  const canOpen = x => host || (!guided && x.pid && x.pid === S.me);
  const myNext = list.find(x => !rev.includes(x.gid) && x.pid === S.me);
  paint(`
  <div class="banner">
    <p class="who">${next ? '🎁 The big <em>reveal</em>!' : '🎉 All <em>revealed</em>!'}</p>
    <div class="sub">${next ? (host ? (guided ? 'Press “Next present” to unwrap them one at a time. Everyone is waiting for you.' : 'Press “Unwrap all” to open them one at a time for everyone, or tap any single present.')
      : guided ? 'The host is unwrapping the presents one at a time. Sit back and watch…' : myNext ? 'Tap your present to unwrap it when it’s your turn!' : 'Watch the gifts get unwrapped…') : 'Happy holidays, everyone!'}</div>
    <div class="row" style="justify-content:center;margin-top:14px">
      ${next && host ? (guided ? `<button class="btn primary big" data-action="reveal" data-id="${next.gid}">Next present ▶${next.pid ? ` — ${esc(player(next.pid).name)}` : ''}</button>`
        : '<button class="btn primary big" data-action="unwrap-all">🎁 Unwrap all, one at a time</button>') : ''}
      ${host && g.can_undo && !rev.length ? '<button class="btn" data-action="undo">↶ Undo</button>' : ''}
      ${!next ? '<button class="btn primary big" data-action="copy-results">📋 Copy results for Discord</button>' : ''}
      ${host && !next ? '<button class="btn" data-action="reset">Play again (back to lobby)</button>' : ''}
      ${host ? '<button class="btn danger" data-action="delete-group">End group now</button>' : ''}
    </div>
  </div>
  <div class="reveal-grid">${list.map(x => {
    const gf = giftById(x.gid), c = contents[x.gid], who = x.pid ? esc(player(x.pid).name) + (x.pid === S.me ? ' (you)' : '') : '<span class="muted">Unclaimed</span>';
    if (rev.includes(x.gid) && c) return `<div class="revealed-card">${itemImg(c)}<div class="item">${esc(c.name)}</div>
      <div class="muted">${who}${c.from ? ` · from ${esc(player(c.from).name)}` : ''}</div></div>`;
    return `<button class="gift-card" data-action="reveal" data-id="${x.gid}" ${canOpen(x) ? '' : 'disabled'}>
      <span class="cta">Unwrap!</span>${presentSVG(gf && gf.wrap)}<div class="owner">${who}</div></button>`;
  }).join('')}</div>
  ${trackerPanel()}`);
}
let wasGuided = false;   // players: when the host finishes a guided reveal, their pop-up closes too
function revealModalFooter(gid) {
  const st = S.group.game, rev = st.revealed || [];
  const next = revealList().find(x => x.gid !== gid && !rev.includes(x.gid));
  if (!st.guided) return '<button class="btn primary next-btn" data-action="close-modal">Nice! 🎉</button>';
  const follow = t => `<div class="next-btn wait-note">⏳ ${t} <button class="link-btn" data-action="close-modal">close</button></div>`;
  if (!next) return S.group.is_host ? '<button class="btn primary next-btn" data-action="finish-reveal">That’s all of them! 🎉</button>'
    : '<div class="next-btn"><div class="wait-note">That’s the last one!</div><button class="btn primary" data-action="close-modal">Close 🎉</button></div>';
  if (S.group.is_host) return `<div class="next-btn"><button class="btn primary big" data-action="reveal" data-id="${next.gid}">Next present ▶${next.pid ? ` — ${esc(player(next.pid).name)}` : ''}</button>
    <div class="wait-note">Everyone is waiting for you to press Next.</div></div>`;
  return follow('Waiting for the host to unwrap the next present…');
}
function showRevealModal(gid) {
  const gf = giftById(gid), c = contents[gid];
  if (!gf || !c) return;
  const holder = S.group.game.holdings[gid];
  draft = null;
  $modal.innerHTML = `<div class="modal-card reveal-stage" id="stage">
    <div class="reveal-owner">${holder ? `${esc(player(holder).name)} unwraps…` : 'An unclaimed gift…'}</div>
    <div class="reveal-stack">
      <div class="reveal-box">${presentSVG(gf.wrap)}</div>
      <div class="reveal-item">${itemImg(c)}<h2>${esc(c.name)}</h2>${c.note ? `<p>${esc(c.note)}</p>` : ''}${c.from ? `<p class="muted">from ${esc(player(c.from).name)}</p>` : ''}</div>
    </div>
    ${revealModalFooter(gid)}
  </div>`;
  $modal.classList.add('show');
  const stage = document.getElementById('stage');
  setTimeout(() => stage.classList.add('shake'), 80);
  setTimeout(() => { stage.classList.add('open'); confetti(); }, 950);
}

/* ---------------- gift editor ---------------- */
async function openEditor(gid, forPlayer) {
  if (gid) {
    let c = contents[gid];
    if (!c) { try { c = contents[gid] = await rpc('get_gift', { p_gift: gid }); } catch (e) { return fail(e); } }
    draft = { id: gid, name: c.name, note: c.note, img: c.img, from: c.from || '', wrap: cleanWrap(giftById(gid).wrap), _new: false };
  } else {
    draft = { id: null, name: '', note: '', img: '', from: forPlayer || '', wrap: randomWrap(`#${S.gifts.length + 1}`), _new: true };
  }
  renderEditor(); $modal.classList.add('show');
}
function swatches(field, value) {
  return `<div class="swatches">${PALETTE.map(c => `<button class="swatch ${c === value ? 'on' : ''}" style="background:${c}" data-action="wrap-set" data-field="${field}" data-value="${c}" title="${c}"></button>`).join('')}
    <input type="color" data-wrap="${field}" value="${value}" title="Custom color"></div>`;
}
function renderEditor() {
  const w = draft.wrap = cleanWrap(draft.wrap), isUrl = draft.img && !draft.img.startsWith('data:'), host = S.group.is_host;
  const forSelf = draft.from && draft.from === S.me;
  $modal.innerHTML = `<div class="modal-card">
    <header><h2>${draft._new ? (forSelf || !host ? '🎁 Add your gift' : '🎁 Add a gift') : '✏️ Edit gift'}</h2><button class="icon-btn" data-action="close-modal" title="Close">✕</button></header>
    <div class="editor-grid">
      <section>
        <h3>What's inside <span class="muted">(secret until the reveal)</span></h3>
        <label>Item name<input data-field="name" maxlength="120" value="${esc(draft.name)}" placeholder="e.g. Bacon-scented candle"></label>
        <label>Description <span class="muted">(optional)</span><textarea data-field="note" maxlength="500" placeholder="Shown at the reveal">${esc(draft.note)}</textarea></label>
        ${host ? `<label>Gift is from<select data-field="from"><option value="">— nobody in particular —</option>${S.players.map(p => `<option value="${p.id}" ${p.id === draft.from ? 'selected' : ''}>${esc(p.name)}${p.id === S.me ? ' (you)' : ''}</option>`).join('')}</select></label>` : ''}
        <h3>Picture</h3>
        <div class="img-row">
          <div class="img-preview" id="img-preview">${draft.img ? `<img src="${esc(draft.img)}" alt="" onerror="this.outerHTML='Couldn’t load that image'">` : 'No picture yet'}</div>
          <div class="img-inputs">
            <label class="btn file-btn">📷 Upload a photo<input type="file" accept="image/*" data-file="img" hidden></label>
            <label>…or paste an image URL<input type="url" data-field="imgUrl" value="${isUrl ? esc(draft.img) : ''}" placeholder="https://…/photo.jpg"></label>
            ${draft.img ? '<button class="btn small ghost" data-action="clear-img">Remove picture</button>' : ''}
            <p class="muted small">Tip: on Amazon etc., right-click the product photo → “Copy image address”.</p>
          </div>
        </div>
      </section>
      <section>
        <h3>Wrapping <span class="muted">(what everyone sees)</span></h3>
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
  'help-jump'(d) { document.getElementById(d.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  'forget-group': d => { myGroups.remove(d.id); renderHome(); },
  'copy': d => navigator.clipboard.writeText(d.text).then(() => toast('Copied! 📋'), () => toast('Copy failed — select the text and copy it manually', true)),
  'remove-player': d => {
    const self = d.id === S.me;
    if (!confirm(self ? 'Leave this group? Your gift will be removed too.' : `Remove ${player(d.id).name}? Their gift will be removed too.`)) return;
    act(async () => { await rpc('remove_player', { p_player: d.id }); if (self && !S.group.is_host) { myGroups.remove(groupId); location.hash = '#/'; } });
  },
  'add-gift': d => openEditor(null, d.for),
  'edit-gift': d => openEditor(d.id),
  'remove-gift': d => { if (confirm('Delete this gift?')) act(async () => { await rpc('delete_gift', { p_gift: d.id }); delete contents[d.id]; }); },
  'close-modal': closeModal,
  'wrap-set': d => { draft.wrap[d.field] = d.value; renderEditor(); },
  'random-wrap': () => { draft.wrap = { ...randomWrap(draft.wrap.tag), topper: draft.wrap.topper }; renderEditor(); },
  'clear-img': () => { draft.img = ''; renderEditor(); },
  'save-gift': () => {
    if (!draft.name.trim()) return toast('Give the item a name first', true);
    const d = draft;
    act(async () => {
      const id = await rpc('save_gift', { p_group: groupId, p_gift: d.id, p_wrap: d.wrap, p_name: d.name.trim(), p_note: d.note || '', p_img: d.img || '', p_from: d.from || null });
      delete contents[id];
      closeModal(); toast(d._new ? 'Gift added 🎁' : 'Gift updated');
    });
  },
  'start': () => { if (confirm('Start the game? Signups close and gifts get locked in.')) act(() => rpc('start_game', { p_group: groupId })); },
  'pick': d => act(() => rpc('game_action', { p_group: groupId, p_action: 'pick', p_gift: d.id })),
  'steal': d => act(() => rpc('game_action', { p_group: groupId, p_action: 'steal', p_gift: d.id })),
  'swap': d => { if (confirm('Swap for this gift?')) act(() => rpc('game_action', { p_group: groupId, p_action: 'swap', p_gift: d.id })); },
  'keep': () => act(() => rpc('game_action', { p_group: groupId, p_action: 'keep' })),
  'undo': () => act(() => rpc('game_action', { p_group: groupId, p_action: 'undo' })),
  'end': () => { if (confirm('End the game now and go straight to the reveal?')) act(() => rpc('game_action', { p_group: groupId, p_action: 'end' })); },
  'reset': () => { if (confirm('Go back to the lobby? The current game is wiped (players and gifts stay).')) act(() => rpc('reset_game', { p_group: groupId })); },
  'unwrap-all': () => act(async () => {
    const rev = S.group.game.revealed || [], next = revealList().find(x => !rev.includes(x.gid));
    await rpc('set_guided_reveal', { p_group: groupId, p_on: true });
    if (next) await rpc('game_action', { p_group: groupId, p_action: 'reveal', p_gift: next.gid });
  }),
  'finish-reveal': () => { closeModal(); rpc('set_guided_reveal', { p_group: groupId, p_on: false }).then(() => refresh(true)).catch(() => { }); },
  'reveal': d => act(() => rpc('game_action', { p_group: groupId, p_action: 'reveal', p_gift: d.id })),
  'delete-group': () => {
    if (!confirm(`End "${S.group.name}" now?

This deletes the group, its players, gifts and results for everyone, and frees up the slot. It cannot be undone.`)) return;
    act(async () => { await rpc('delete_group', { p_group: groupId }); myGroups.remove(groupId); toast('Group ended'); location.hash = '#/'; });
  },
  'save-event': () => {
    const el = $app.querySelector('[name=evt]'), d = el && el.value ? new Date(el.value) : null;
    if (!d || isNaN(d)) return toast('Pick a date and time first', true);
    act(async () => { await rpc('set_event', { p_group: groupId, p_event: d.toISOString() }); toast('Event date saved 📅'); });
  },
  'clear-event': () => act(async () => { await rpc('set_event', { p_group: groupId, p_event: null }); const el = $app.querySelector('[name=evt]'); if (el) el.value = ''; }),
  'change-pw': () => {
    const next = prompt('Group password friends need to join (4–40 characters).\nLeave blank for no password.', joinPw || '');
    if (next === null) return;
    act(async () => { await rpc('set_group_password', { p_group: groupId, p_password: next.trim() }); joinPw = next.trim(); toast(next.trim() ? 'Password updated 🔑' : 'Password removed'); });
  },
  'copy-invite': () => {
    const g = S.group;
    actions.copy({ text: [`🐘 You're invited to **${g.name}** — a White Elephant gift exchange!`,
      g.event_at ? `📅 ${fmtDate(g.event_at, true)}` : '',
      `🔗 Join and add your gift: ${inviteURL(g.code)}`,
      joinPw ? `🔑 Password: ${joinPw}` : ''].filter(Boolean).join('\n') });
  },
  'copy-results': () => {
    const lines = revealList().map(x => {
      const c = contents[x.gid] || {};
      return `• ${x.pid ? player(x.pid).name : 'Unclaimed'} → ${c.name || '?'}${c.from ? ` (from ${player(c.from).name})` : ''}`;
    });
    actions.copy({ text: `🐘 ${S.group.name} — results\n${lines.join('\n')}` });
  },
  'release-player': d => {
    const name = player(d.id).name;
    if (!confirm(`Make a personal rejoin link for ${name}?\n\nUse this if they switched device or browser and can't get back in. Their old device is signed out of the group, and you get a one-time link to send them privately.`)) return;
    act(async () => {
      const tok = await rpc('host_release_player', { p_player: d.id });
      const link = `${inviteURL(S.group.code)}/rejoin/${tok}`;
      try { await navigator.clipboard.writeText(link); } catch { }
      prompt(`Send this one-time link to ${name} in a private message (it's also on your clipboard). Whoever opens it takes ${name}'s seat.`, link);
    });
  },
  'toggle-big': () => { bigScreen = !bigScreen; localStorage.setItem('we.big', bigScreen ? '1' : '0'); render(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener('submit', e => {
  const f = e.target, kind = f.dataset.form; if (!kind) return;
  e.preventDefault();
  const v = name => (f.elements[name]?.value || '').trim();
  if (kind === 'create') {
    act(async () => {
      const r = await rpc('create_group', { p_name: v('gname'), p_host_name: v('hname') || null, p_password: v('pw') || null });
      myGroups.add({ id: r.id, code: r.code, name: v('gname'), host: true });
      hostKey = r.host_key;
      f.reset(); location.hash = `#/g/${r.code}`;
    });
  } else if (kind === 'join') {
    act(async () => { await rpc('join_group', { p_code: f.dataset.code, p_name: v('name'), p_password: f.elements.pw ? f.elements.pw.value.trim() : null }); f.reset(); await route(); });
  } else if (kind === 'add-player') {
    act(async () => { await rpc('host_add_player', { p_group: groupId, p_name: v('pname') }); f.reset(); })
      .then(() => $app.querySelector('[name=pname]')?.focus());
  }
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
  if (el.dataset.setting && S) {
    const k = el.dataset.setting, s = { ...S.group.settings };
    if (k === 'signups') return act(() => rpc('update_group', { p_group: groupId, p_signups: el.checked }));
    s[k] = el.type === 'checkbox' ? el.checked : Math.max(1, Math.min(+el.max || 20, parseInt(el.value, 10) || 1));
    return act(() => rpc('update_group', { p_group: groupId, p_settings: s }));
  }
  if (el.dataset.file === 'img' && el.files[0] && draft) {
    try { draft.img = await fileToDataURL(el.files[0]); renderEditor(); }
    catch (err) { fail(err); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $modal.classList.contains('show')) closeModal(); });

/* ---------------- boot ---------------- */
(async function init() {
  if (!CFG.url || !CFG.key || !window.supabase) {
    return renderMessage('Almost ready', 'The Supabase connection is not configured yet (config.js).');
  }
  sb = window.supabase.createClient(CFG.url, CFG.key);
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) return renderMessage('Could not connect', error.message + ' — make sure anonymous sign-ins are enabled in Supabase.');
  }
  route();
})();
