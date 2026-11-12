// Shared pet state: used by both the content script and the popup.
// Needs decay with real time, computed lazily from the last saved timestamp.
// One handle for the extension APIs in every browser: Firefox and Safari (and Chrome 148+)
// provide the promise-based `browser`; older Chrome only `chrome`. Guarded so the website
// demo, which has neither, can load this file too.
const ext = globalThis.browser || globalThis.chrome || {};

// Put the extension's own fixed markup (drawings, styles) into an element. Parsing it
// with DOMParser instead of assigning innerHTML keeps store linters happy; nothing that
// comes from a page or from storage is ever passed in here.
function petSetMarkup(el, markup) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, 'text/html');
  el.replaceChildren(...doc.head.childNodes, ...doc.body.childNodes);
}

const PET_DEFAULTS = {
  name: 'Mochi',
  hunger: 80,   // 100 = full
  happy: 80,
  energy: 80,
  skin: 'cat',
  enabled: true,
  chatter: 'chatty',   // 'chatty' | 'quiet' (only answers you) | 'silent'
  snoozeUntil: 0,      // timestamp; hidden everywhere until then
  hiddenSites: [],     // hostnames where the pet stays hidden
  goodies: false,      // Goodies pack bought; set only by the background worker from ExtensionPay
  outfit: '',          // key of PET_OUTFITS, or '' for none
  tryOn: null,         // { kind: 'skin'|'outfit', id, until }: a timed preview of a Goodies pack item
  tryLog: { day: '', n: 0 },   // try-ons used today
  treasures: {},
  lastFound: {},       // treasure kind -> day it was last found ('Tue Nov 11 2026')
  born: 0,
  lastTick: 0,
};

const PET_RATES = { hunger: 20, happy: 12, energy: 15 }; // points per hour
const PET_MAX_AWAY_HOURS = 6;   // time away beyond this does not drain the pet further
const PET_FLOOR = 15;           // time alone never drains tummy or joy below this

const petClamp = (n) => Math.max(0, Math.min(100, n));
const petHas = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

// Everything read from storage goes through here, so a bad or stale value can
// never reach the drawing code or the popup's HTML.
function normalizePet(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const p = Object.assign({}, PET_DEFAULTS, src);
  if (!petHas(PET_SKINS, p.skin)) p.skin = PET_DEFAULTS.skin;
  p.name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 16) : PET_DEFAULTS.name;
  for (const k of ['hunger', 'happy', 'energy']) p[k] = Number.isFinite(p[k]) ? petClamp(p[k]) : PET_DEFAULTS[k];
  for (const k of ['born', 'lastTick', 'snoozeUntil']) p[k] = Number.isFinite(p[k]) ? p[k] : 0;
  p.enabled = p.enabled !== false;
  p.goodies = p.goodies === true;
  const tr = src.tryOn;
  p.tryOn = !p.goodies && tr && typeof tr === 'object' && petTryable(tr.kind, tr.id) && Number.isFinite(tr.until)
    && tr.until > Date.now() && tr.until <= Date.now() + PET_TRY_MS + 5000 ? { kind: tr.kind, id: tr.id, until: tr.until } : null;
  const tl = src.tryLog;
  p.tryLog = tl && typeof tl === 'object' && typeof tl.day === 'string' && Number.isSafeInteger(tl.n)
    ? { day: tl.day.slice(0, 20), n: Math.max(0, tl.n) } : { day: '', n: 0 };
  if (typeof PET_OUTFITS !== 'object' || !petHas(PET_OUTFITS, p.outfit) || !p.goodies) p.outfit = '';
  if (PET_SKINS[p.skin].premium && !p.goodies) p.skin = PET_DEFAULTS.skin;
  if (!['chatty', 'quiet', 'silent'].includes(p.chatter)) p.chatter = 'chatty';
  p.hiddenSites = Array.isArray(p.hiddenSites)
    ? [...new Set(p.hiddenSites.filter((h) => typeof h === 'string' && h.length < 254))].slice(0, 500) : [];
  const t = {};
  if (src.treasures && typeof src.treasures === 'object') {
    for (const k of Object.keys(PET_TREASURES)) {
      const n = src.treasures[k];
      if (Number.isSafeInteger(n) && n > 0) t[k] = n;
    }
  }
  p.treasures = t;
  const lf = {};
  if (src.lastFound && typeof src.lastFound === 'object') {
    for (const k of Object.keys(PET_TREASURES)) if (typeof src.lastFound[k] === 'string') lf[k] = src.lastFound[k].slice(0, 20);
  }
  p.lastFound = lf;
  return p;
}

async function loadPet() {
  const { pet } = await ext.storage.local.get('pet');
  const p = normalizePet(pet);
  const now = Date.now();
  if (!pet || !p.born) {
    // first run: write the pet now so its birthday is the same everywhere
    p.born = p.born || now;
    p.lastTick = now;
    await ext.storage.local.set({ pet: p });
    return p;
  }
  const hrs = Math.min(PET_MAX_AWAY_HOURS, Math.max(0, (now - p.lastTick) / 3.6e6));
  const drain = (v, amount) => Math.max(v - amount, Math.min(v, PET_FLOOR));
  p.hunger = drain(p.hunger, PET_RATES.hunger * hrs);
  p.happy = drain(p.happy, PET_RATES.happy * hrs * (p.hunger < 20 ? 2 : 1));
  p.energy = petClamp(p.energy + PET_RATES.energy * hrs);
  p.lastTick = now;
  return p;
}

async function savePet(p) {
  p.lastTick = Date.now();
  await ext.storage.local.set({ pet: p });
  return p;
}

// Changes made from the same page or popup run one after another, so two quick
// actions never read the same old state and overwrite each other.
let petQueue = Promise.resolve();
function changePet(fn) {
  const run = petQueue.then(async () => {
    const p = await loadPet();
    fn(p);
    // the same clean-up as on load: clamps stats, and drops premium choices without the pack
    return savePet(normalizePet(p));
  });
  petQueue = run.catch(() => {});
  return run;
}

// Every change to the pet is one of these named actions. Pages and the popup ask the
// background worker to run them (petDo); the worker runs them one at a time, so two
// tabs can never overwrite each other's changes. Arguments are checked here.
// ---------- try-on: a one-minute preview of a Goodies pack animal or outfit ----------
const PET_TRY_MS = 60000;
const PET_TRIES_PER_DAY = 5;
function petTryable(kind, id) {
  if (kind === 'skin') return petHas(PET_SKINS, id) && PET_SKINS[id].premium === true;
  return kind === 'outfit' && typeof PET_OUTFITS === 'object' && petHas(PET_OUTFITS, id);
}
function petTryActive(p) { return !!(p && p.tryOn && p.tryOn.until > Date.now() && !p.goodies); }
function petTriesLeft(p) {
  return p.tryLog.day === new Date().toDateString() ? Math.max(0, PET_TRIES_PER_DAY - p.tryLog.n) : PET_TRIES_PER_DAY;
}
// What the pet is wearing right now: its own animal and outfit, or the one it's trying on.
function petLook(p) {
  const t = petTryActive(p) ? p.tryOn : null;
  return { skin: t && t.kind === 'skin' ? t.id : p.skin, outfit: t && t.kind === 'outfit' ? t.id : p.outfit };
}

// A treat or toy is usable if it exists and is free, or the Goodies pack is owned.
function petGoodieOK(p, group, kind) {
  return typeof PET_GOODIES === 'object' && petHas(PET_GOODIES[group], kind)
    && (!PET_GOODIES[group][kind].premium || p.goodies === true);
}
function petEat(p, kind) {
  const t = petGoodieOK(p, 'treats', kind) ? PET_GOODIES.treats[kind] : { hunger: 25, happy: 5 };
  p.hunger += t.hunger; p.happy += t.happy;
}

const PET_OPS = {
  pat: (p) => { p.happy += 4; },
  ate: (p, kind) => petEat(p, kind),
  feedByHand: (p, kind) => petEat(p, kind),
  ballDone: (p, kind) => { p.happy += petHas(PET_GOODIES.toys, kind) && petGoodieOK(p, 'toys', kind) && kind !== 'ball' ? 20 : 15; p.energy -= 10; },
  playByHand: (p) => { p.happy += 10; p.energy -= 8; },
  nap: (p) => { p.energy += 4; },
  treasure: (p, kind) => {
    if (!petHas(PET_TREASURES, kind)) return;
    p.treasures = Object.assign({}, p.treasures, { [kind]: (p.treasures[kind] || 0) + 1 });
    p.lastFound = Object.assign({}, p.lastFound, { [kind]: new Date().toDateString() });
    p.happy += 6;
  },
  rename: (p, name) => { if (typeof name === 'string') p.name = name.trim().slice(0, 16) || PET_DEFAULTS.name; },
  skin: (p, id) => { if (petHas(PET_SKINS, id) && (!PET_SKINS[id].premium || p.goodies)) p.skin = id; },
  outfit: (p, id) => { if (id === '' || (p.goodies && petHas(PET_OUTFITS, id))) p.outfit = id; },
  tryOn: (p, arg) => {
    const [kind, id] = Array.isArray(arg) ? arg : [];
    if (p.goodies || !petTryable(kind, id) || petTriesLeft(p) === 0) return;
    const today = new Date().toDateString();
    p.tryLog = { day: today, n: (p.tryLog.day === today ? p.tryLog.n : 0) + 1 };
    p.tryOn = { kind, id, until: Date.now() + PET_TRY_MS };
  },
  tryOff: (p) => { p.tryOn = null; },
  enabled: (p, on) => { p.enabled = on === true; },
  chatter: (p, v) => { if (['chatty', 'quiet', 'silent'].includes(v)) p.chatter = v; },
  snooze: (p, on) => { p.snoozeUntil = on === true ? Date.now() + 3600e3 : 0; },
  hideSite: (p, arg) => {
    const [host, hide] = Array.isArray(arg) ? arg : [];
    if (typeof host !== 'string' || !host || host.length > 253) return;
    const rest = p.hiddenSites.filter((h) => h !== host);
    p.hiddenSites = hide === true ? [...rest, host] : rest;
  },
};

// Ask the background worker to apply an action; resolves with the updated pet.
async function petDo(op, arg) {
  const res = await ext.runtime.sendMessage({ type: 'pet:op', op, arg });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Page Pet background did not answer');
  return normalizePet(res.pet);
}

function petMood(p) {
  if (p.hunger < 20) return 'hungry';
  if (p.energy < 20) return 'sleepy';
  if (p.happy < 30) return 'sad';
  if (p.happy > 60 && p.hunger > 30) return 'happy';
  return 'okay';
}

// ---------- the creature: smooth, shaded SVG animals ----------
// Drawn facing right on an 88x66 stage (ground at y=63); the page script mirrors
// it to walk left. Light comes from the upper left on every animal. Fur parts get a
// soft noise filter so edges look furry, not vector-clean.
const PET_W = 88, PET_H = 66;
const INK = '#1a1418';

// Mouth shapes, centred on the mouth position. Every line mouth runs out and back
// along the same curve, so it encloses no area: the fill only shows on the two
// open mouths (a grin for happy, a round "oh" for open).
const PET_MOUTHS = {
  happy: 'M-3.7-.1Q-1.85 1.5 0 .3Q1.85 1.5 3.7-.1Q2.7 4.3 0 4.3Q-2.7 4.3-3.7-.1Z',
  okay: 'M-2.8.6Q-1.4 1.9 0 .5Q1.4 1.9 2.8.6Q1.4 1.9 0 .5Q-1.4 1.9-2.8.6',
  sad: 'M-2.8 2.2Q0 .1 2.8 2.2Q0 .1-2.8 2.2',
  open: 'M-2.3.5Q0-.3 2.3.5Q2.3 4.9 0 4.9Q-2.3 4.9-2.3.5Z',
  sleep: 'M-1.8 1Q0 1.8 1.8 1Q0 1.8-1.8 1',
};

// body: [cx, cy, rx, ry]   head: [cx, cy, rx, ry]   mz: muzzle [rx, ry]
const PET_SKINS = {
  cat: {
    name: 'Cat', sound: 'meow', hue: 30,
    fur: '#d98a3d', dark: '#a05a1e', light: '#f5ba76', belly: '#f7e3c8', muzzle: '#fbeede', nose: '#e58a9a', inner: '#f0a7b0',
    iris: '#9ab53f', slit: true, paw: '#f7e3c8',
    body: [38, 41, 19, 10], head: [63, 27, 11.5, 10.5], mz: [6.2, 4.6], legW: 5,
    ears: 'pointed', tail: 'long', whiskers: true, stripes: true, ruff: true,
  },
  dog: {
    name: 'Dog', sound: 'woof!', hue: 36,
    fur: '#c69257', dark: '#8a5d30', light: '#e6bd88', belly: '#f1dfc2', muzzle: '#f4e6cf', nose: '#2a2024', earColor: '#7a4f28',
    iris: '#4a2d18', paw: '#f1dfc2',
    body: [38, 40, 21, 11.5], head: [64, 26, 12.5, 11.5], mz: [7.6, 5.6], noseR: 2.9, legW: 6.5,
    ears: 'floppy', tail: 'wag', patch: true,
  },
  rabbit: {
    name: 'Rabbit', sound: '*thump*', hue: 340,
    fur: '#ebe5de', dark: '#aa9e92', light: '#ffffff', belly: '#ffffff', muzzle: '#ffffff', nose: '#e79aa8', inner: '#f2b3be',
    iris: '#3a2616', paw: '#ffffff', whisker: '#a89c90',
    body: [38, 48, 18, 12.5], head: [60, 36, 10.5, 10], mz: [5.8, 4.4], legW: 5.5,
    ears: 'long', tail: 'puff', whiskers: true, hop: true, haunch: true,
  },
  fox: {
    name: 'Fox', sound: 'yip!', hue: 18,
    fur: '#d9692a', dark: '#96400f', light: '#f39350', belly: '#f6efe6', muzzle: '#fbf6ee', nose: '#231a1c', inner: '#f6efe6',
    iris: '#c08a2a', slit: true, paw: '#2a1f1f', legColor: '#3a2a26',
    body: [38, 41, 19.5, 10], head: [63, 27, 11.5, 10.5], mz: [7.2, 5.2], legW: 5,
    ears: 'tall', tail: 'bushy', whiskers: true, ruff: '#f6efe6', stockings: true,
  },
  bear: {
    name: 'Bear', sound: 'grr', hue: 25,
    fur: '#7b4f30', dark: '#4a2c18', light: '#a57550', belly: '#8a5c3a', muzzle: '#d9b98f', nose: '#1f1719', inner: '#c49a74',
    iris: '#2a1a10', paw: '#5a3820',
    body: [37, 39, 23, 15], head: [65, 26, 13.5, 12.5], mz: [7, 5.4], noseR: 2.7, legW: 9,
    ears: 'round', tail: 'stub',
  },
  panda: {
    name: 'Panda', sound: '*munch*', hue: 160,
    fur: '#f3f1ec', dark: '#b5aea2', light: '#ffffff', belly: '#ffffff', muzzle: '#ffffff', nose: '#1c1a1d', earColor: '#1f1d21', inner: '#3a373d',
    iris: '#5a4636', paw: '#1f1d21', legColor: '#1f1d21', neckColor: '#1f1d21',
    body: [37, 39, 23, 15], head: [65, 26, 13.5, 12.5], mz: [6.6, 5], noseR: 2.5, legW: 9,
    ears: 'round', tail: 'stub', band: true, eyePatch: true,
  },
  pig: {
    name: 'Pig', sound: 'oink', hue: 345,
    fur: '#f2a7b6', dark: '#c9748a', light: '#fdd0d9', belly: '#f7bcc8', nose: '#a8546a', earColor: '#e58fa3',
    iris: '#3a2616', paw: '#a85a70', snout: '#e88ea2',
    body: [37, 42, 22, 14.5], head: [64, 29, 12.5, 11.5], mz: [0, 0], legW: 6.5,
    ears: 'fold', tail: 'curl', smooth: true,
  },
  frog: {
    name: 'Frog', sound: 'ribbit', hue: 120, kind: 'frog', hop: true,
    fur: '#5aa846', dark: '#2f6e2c', light: '#a6dc74', belly: '#e9f1bd', iris: '#e0b33a', paw: '#4f9a3e',
    body: [40, 51, 20.5, 11.5], head: [60, 44, 13, 9.5],
  },
  // Goodies pack animals
  redpanda: {
    name: 'Red panda', sound: 'squeak!', hue: 14, premium: true,
    fur: '#c4532a', dark: '#7d2a10', light: '#e8874c', belly: '#3a2420', muzzle: '#fbf3ea', nose: '#231a1c', inner: '#fbf3ea',
    iris: '#3a2214', paw: '#2a1d1b', legColor: '#3a2420', earColor: '#8a3416',
    body: [38, 41, 19.5, 10.5], head: [63, 27, 12, 10.8], mz: [6.6, 4.8], legW: 5.5,
    ears: 'soft', tail: 'ringed', ruff: '#fbf3ea', brows: true, tears: '#8a3416',
  },
  lamb: {
    name: 'Lamb', sound: 'baa', hue: 40, premium: true,
    fur: '#f6f0e4', dark: '#c7b79f', light: '#ffffff', belly: '#ffffff', muzzle: '#e8c9b2', nose: '#c97f86', inner: '#f0a7b0',
    iris: '#2e1f18', paw: '#5a4036', legColor: '#c9a28a', faceColor: '#d9b49a', earColor: '#d9b49a',
    body: [37, 40, 20, 12], head: [63, 28, 11, 10.5], mz: [5.2, 3.8], legW: 4.6,
    ears: 'lamb', tail: 'puff', wool: true,
  },
};

function petDefs(id, s, bodyBox, headBox) {
  const grad = (n, [cx, cy, rx, ry]) => `<radialGradient id="${id}-${n}" gradientUnits="userSpaceOnUse" cx="${cx - rx * 0.25}" cy="${cy - ry * 0.7}" r="${Math.max(rx, ry) * 1.7}">
      <stop offset="0" stop-color="${s.light}"/><stop offset=".45" stop-color="${s.fur}"/><stop offset="1" stop-color="${s.dark}"/></radialGradient>`;
  const clip = (n, [cx, cy, rx, ry]) => `<clipPath id="${id}-c${n}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/></clipPath>`;
  return `<defs>
    ${grad('b', bodyBox)}${grad('h', headBox)}${clip('b', bodyBox)}${clip('h', headBox)}
    <linearGradient id="${id}-l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.fur}"/><stop offset="1" stop-color="${s.dark}"/></linearGradient>
    <filter id="${id}-f" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="${s.smooth ? 0.5 : 0.95}" numOctaves="2" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="${s.smooth ? 0.6 : 1.8}" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>`;
}

function petEye(x, y, s, r = 3.2) {
  return `<g class="p-eye"><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.1}" fill="${s.iris}" stroke="${INK}" stroke-width=".7"/>
    <ellipse cx="${x}" cy="${y + r * 0.46}" rx="${r * 0.62}" ry="${r * 0.4}" fill="#fff" opacity=".2"/>
    <g class="p-pupil"><ellipse cx="${x}" cy="${y}" rx="${s.slit ? r * 0.36 : r * 0.7}" ry="${r * 0.82}" fill="#0e0b0d"/></g>
    <circle cx="${x - r * 0.33}" cy="${y - r * 0.42}" r="${r * 0.32}" fill="#fff"/><circle cx="${x + r * 0.36}" cy="${y + r * 0.4}" r="${r * 0.15}" fill="#fff" opacity=".85"/></g>`;
}

// the nightcap, sized to a head (shown only while .night is set)
function petCap(hx, hy, hrx, hry) {
  return `<g class="p-cap">
        <path d="M${hx + 3} ${hy - hry - 3}q-10 -7 -${hrx + 3} 3" fill="none" stroke="#4b4fa8" stroke-width="4.2" stroke-linecap="round"/>
        <path d="M${hx - hrx * 0.78} ${hy - hry * 0.58}Q${hx + 1} ${hy - hry - 10} ${hx + hrx * 0.78} ${hy - hry * 0.58}Q${hx} ${hy - hry * 1.02} ${hx - hrx * 0.78} ${hy - hry * 0.58}Z" fill="#5a5fc4"/>
        <path d="M${hx - hrx * 0.3} ${hy - hry - 2.5}Q${hx + 1} ${hy - hry - 6} ${hx + hrx * 0.45} ${hy - hry * 0.9}" fill="none" stroke="#8a8fe6" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>
        <path d="M${hx - hrx * 0.8} ${hy - hry * 0.56}Q${hx} ${hy - hry * 1.04} ${hx + hrx * 0.8} ${hy - hry * 0.56}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="${hx - hrx}" cy="${hy - hry}" r="2.8" fill="#fff"/>
      </g>`;
}

function drawQuad(id, s, outfit) {
  const [bx, by, brx, bry] = s.body, [hx, hy, hrx, hry] = s.head, lw = s.legW, G = 63;
  const fx = hx + 1.5;                       // face is turned slightly toward the walking direction
  const B = 'url(#§-b)', Hd = 'url(#§-h)';
  const farFill = s.legColor || s.dark;
  // A leg is drawn on its own layer: just the shape, the rig adds the wrapper that swings.
  // Legs taper from a thick top to a slim ankle; a near leg is painted with the body's own
  // gradient, so it grows out of the torso without a seam and darkens toward the ground.
  const legShape = (x, far, hind) => {
    const top = by - 1, ya = G - 2.4, wt = lw * 0.6, wa = lw * 0.4, mid = (top + ya) / 2;
    const back = hind ? 1.4 : 0.3;          // hind legs have a rounder thigh on the rear edge
    const long = hind && s.haunch;           // rabbits stand on long hind feet
    const pawFill = far ? farFill : s.paw;
    const d = `M${x - wt} ${top}H${x + wt}Q${x + wt + 0.3} ${mid} ${x + wa} ${ya}H${x - wa}Q${x - wt - back} ${mid} ${x - wt} ${top}Z`;
    // fox: the near legs keep body colour at the top and pull on dark stockings below the belly
    const stocking = !far && s.stockings
      ? `<clipPath id="§-k"><rect x="${x - lw * 2}" y="${by + bry * 0.8}" width="${lw * 4}" height="${G}"/></clipPath><path d="${d}" fill="${s.legColor}" clip-path="url(#§-k)"/>` : '';
    return `<path d="${d}" fill="${far ? farFill : (s.stockings ? B : (s.legColor || B))}"/>${stocking}
      <ellipse cx="${x + (long ? 3 : 1)}" cy="${G - 1.8}" rx="${wa + (long ? 4.2 : 1.5)}" ry="2" fill="${pawFill}"/>
      ${far || s.smooth || long ? '' : `<path d="M${x + 0.4} ${G - 2.9}v1.3M${x + 2.1} ${G - 2.7}v1.2" stroke="${s.dark}" stroke-width=".5" stroke-linecap="round" opacity=".45"/>`}
      ${s.smooth && !far ? `<path d="M${x + 1} ${G - 3.4}v2.6" stroke="${s.fur}" stroke-width=".7" stroke-linecap="round" opacity=".7"/>` : ''}`;
  };
  const hind = bx - brx * 0.58, fore = bx + brx * 0.62;
  const tx = bx - brx + 2.5, ty = by - 2;

  // fox brush: a plume that sweeps back and up, white tip clipped to it
  const plume = `M${tx + 2} ${ty - 2.5}C${tx - 5} ${ty - 9} ${tx - 15} ${ty - 9} ${tx - 18.5} ${ty - 3}C${tx - 19} ${ty + 1.5} ${tx - 15} ${ty + 5} ${tx - 8} ${ty + 4.5}C${tx - 3} ${ty + 4} ${tx} ${ty + 3} ${tx + 2} ${ty + 2}Z`;
  const tail = {
    long: `<path d="M${tx} ${ty}q-11 0-11-14q0-7 4-9" fill="none" stroke="${B}" stroke-width="4.4" stroke-linecap="round"/>
           <path d="M${tx - 10.8} ${ty - 8}l2.2-.3M${tx - 10.4} ${ty - 13.5}l2.3 .4M${tx - 8} ${ty - 1.8}l.6-2" fill="none" stroke="${s.dark}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>`,
    wag: `<path d="M${tx} ${ty}q-8-3-8-13" fill="none" stroke="${B}" stroke-width="4.6" stroke-linecap="round"/>`,
    puff: `<circle cx="${tx - 1}" cy="${ty + 2}" r="5.4" fill="${s.light}"/><circle cx="${tx - 0.2}" cy="${ty + 3.4}" r="3.6" fill="${s.fur}" opacity=".55"/>`,
    bushy: `<clipPath id="§-tc"><path d="${plume}"/></clipPath><path d="${plume}" fill="${B}"/>
            <g clip-path="url(#§-tc)"><ellipse cx="${tx - 18}" cy="${ty - 1}" rx="6.5" ry="8" transform="rotate(-25 ${tx - 18} ${ty - 1})" fill="${s.belly}"/></g>`,
    ringed: `<clipPath id="§-tc"><path d="${plume}"/></clipPath><path d="${plume}" fill="${B}"/>
            <g clip-path="url(#§-tc)" fill="none" stroke="${s.dark}" stroke-width="2.6" opacity=".75">${[4, 9.5, 15].map((d) => `<path d="M${tx - d + 1.5} ${ty - 10}q-2.5 7 0 15"/>`).join('')}</g>`,
    stub: `<circle cx="${tx}" cy="${ty + 2}" r="4" fill="${s.fur}"/>`,
    curl: `<path d="M${tx + 1} ${ty}c-5-1-7-6-3.5-7.5c3.5-1.3 4 3.5 .5 3.5" fill="none" stroke="${s.dark}" stroke-width="2" stroke-linecap="round"/>`,
  }[s.tail];

  const ear = (k) => {
    const X = (d) => hx + k * d;
    const earFill = s.earColor || s.fur;
    switch (s.ears) {
      case 'pointed': return `<path d="M${X(3.5)} ${hy - 8}L${X(10.5)} ${hy - 19}L${X(12.5)} ${hy - 4}Z" fill="${earFill}" stroke="${earFill}" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M${X(6.5)} ${hy - 8.5}L${X(10)} ${hy - 15.5}L${X(11)} ${hy - 6.5}Z" fill="${s.inner}"/>`;
      case 'tall': return `<path d="M${X(3)} ${hy - 8}L${X(10.5)} ${hy - 22}L${X(12.8)} ${hy - 4}Z" fill="${earFill}" stroke="${earFill}" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M${X(8.8)} ${hy - 17}L${X(10.5)} ${hy - 22}L${X(11.6)} ${hy - 15}Z" fill="${s.legColor}" stroke="${s.legColor}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M${X(6.2)} ${hy - 8.5}L${X(9.8)} ${hy - 15}L${X(11)} ${hy - 6.5}Z" fill="${s.inner}"/>`;
      case 'long': return `<ellipse cx="${X(4.6)}" cy="${hy - 19}" rx="3.7" ry="11.5" transform="rotate(${k * 9} ${X(4.6)} ${hy - 9})" fill="${earFill}"/>
        <ellipse cx="${X(4.6)}" cy="${hy - 19}" rx="1.8" ry="8.5" transform="rotate(${k * 9} ${X(4.6)} ${hy - 9})" fill="${s.inner}"/>`;
      case 'round': return `<circle cx="${X(9.8)}" cy="${hy - 9.6}" r="5.2" fill="${earFill}"/><circle cx="${X(9.6)}" cy="${hy - 9.2}" r="2.6" fill="${s.inner}"/>`;
      case 'fold': return `<path d="M${X(4.5)} ${hy - 10}L${X(11)} ${hy - 11.5}L${X(15)} ${hy - 3.5}L${X(10)} ${hy - 5}Z" fill="${earFill}" stroke="${earFill}" stroke-width="2.4" stroke-linejoin="round"/>`;
      case 'soft': return `<path d="M${X(2.5)} ${hy - 7}Q${X(6)} ${hy - 19.5} ${X(10.5)} ${hy - 17.5}Q${X(14.5)} ${hy - 14} ${X(12.8)} ${hy - 3}Z" fill="${s.inner}"/>
        <path d="M${X(5)} ${hy - 7.5}Q${X(7.2)} ${hy - 16} ${X(10)} ${hy - 15}Q${X(12.6)} ${hy - 12.5} ${X(11.4)} ${hy - 5.5}Z" fill="${earFill}"/>`;
      case 'lamb': return `<ellipse cx="${X(hrx + 1)}" cy="${hy - 4}" rx="5" ry="2.4" transform="rotate(${k * 22} ${X(hrx + 1)} ${hy - 4})" fill="${earFill}"/>
        <ellipse cx="${X(hrx + 1.6)}" cy="${hy - 4}" rx="3" ry="1.1" transform="rotate(${k * 22} ${X(hrx + 1)} ${hy - 4})" fill="${s.inner}"/>`;
      case 'floppy': return `<ellipse cx="${X(12)}" cy="${hy + 2}" rx="4.6" ry="9.5" transform="rotate(${k * -10} ${X(12)} ${hy - 6})" fill="${earFill}"/>`;
    }
    return '';
  };
  const earsBack = s.ears === 'floppy' ? '' : ear(-1) + ear(1);
  const earsFront = s.ears === 'floppy' ? ear(-1) + ear(1) : '';

  // cheek fluff: two soft tufts flaring out below the eyes (cat in its own fur, fox in white)
  const ruff = s.ruff ? [-1, 1].map((k) => {
    const X = (d) => hx + k * d;
    return `<path d="M${X(hrx - 4)} ${hy - 1}Q${X(hrx + 1.5)} ${hy + 1} ${X(hrx + 3.2)} ${hy + 5.5}Q${X(hrx + 0.6)} ${hy + 5.2} ${X(hrx + 1.4)} ${hy + 8}Q${X(hrx - 2)} ${hy + 8.2} ${X(hrx - 5)} ${hy + 7}Z" fill="${s.ruff === true ? Hd : s.ruff}"/>`;
  }).join('') : '';

  // lamb: a cloud of wool curls around the body outline
  const wool = s.wool ? Array.from({ length: 13 }, (_, i) => {
    const t = (i / 13) * Math.PI * 2;
    return `<circle cx="${(bx + brx * 0.9 * Math.cos(t)).toFixed(2)}" cy="${(by + bry * 0.86 * Math.sin(t)).toFixed(2)}" r="4.4" fill="${B}"/>`;
  }).join('') : '';
  const bodyMarks = [
    s.wool ? '' : `<ellipse cx="${bx + 2}" cy="${by + bry * 0.62}" rx="${brx * 0.8}" ry="${bry * 0.45}" fill="${s.belly}" opacity=".9"/>`,
    s.stripes ? [-11, -4, 3, 10].map((d) => `<path d="M${bx + d} ${by - bry}q3 6 0 ${bry + 1}" fill="none" stroke="${s.dark}" stroke-width="2" stroke-linecap="round" opacity=".55"/>`).join('') : '',
    s.band ? `<path d="M${bx + brx - 18} ${by - bry - 1}Q${bx + brx - 9} ${by - 2} ${bx + brx - 13} ${by + bry + 1}H${bx + brx + 2}V${by - bry - 1}Z" fill="${s.legColor}"/>` : '',
  ].join('');

  const ex = [fx - 5.9, fx + 5.9], ey = hy - 2.4;
  const headMarks = [
    s.faceColor ? `<ellipse cx="${fx + 0.5}" cy="${hy + 2.6}" rx="${hrx * 0.86}" ry="${hry * 0.84}" fill="${s.faceColor}"/>` : '',
    s.brows ? ex.map((x) => `<ellipse cx="${x - 0.4}" cy="${ey - 5}" rx="2.3" ry="1.4" fill="${s.muzzle}"/>`).join('') : '',
    s.stripes ? [-3.2, 0, 3.2].map((d) => `<path d="M${fx + d} ${hy - hry + 1}l${d * 0.08} 4.2" stroke="${s.dark}" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>`).join('') : '',
    s.patch ? `<ellipse cx="${ex[1] + 1}" cy="${ey - 0.5}" rx="5.6" ry="6.2" fill="${s.earColor}" opacity=".85"/>` : '',
    s.eyePatch ? ex.map((x, i) => `<ellipse cx="${x}" cy="${ey + 0.6}" rx="4.7" ry="5.9" transform="rotate(${i ? -22 : 22} ${x} ${ey})" fill="${s.earColor}"/>`).join('') : '',
    s.mz[0] ? `<ellipse cx="${fx}" cy="${hy + 5.2}" rx="${s.mz[0]}" ry="${s.mz[1]}" fill="${s.muzzle}"/>` : '',
    s.tears ? ex.map((x, i) => `<path d="M${x + (i ? -0.8 : 0.8)} ${ey + 3.2}Q${x + (i ? 0.2 : -0.2)} ${hy + 4.6} ${fx + (i ? 4.4 : -4.4)} ${hy + 7.4}" fill="none" stroke="${s.tears}" stroke-width="1.8" stroke-linecap="round" opacity=".9"/>`).join('') : '',
  ].join('');

  const nr = s.noseR || 2.2;
  const snoutY = hy + 3.4;
  const nose = s.snout
    ? `<ellipse cx="${fx}" cy="${snoutY}" rx="5.6" ry="4" fill="${s.snout}" stroke="${s.dark}" stroke-width=".5"/>
       <ellipse cx="${fx - 0.6}" cy="${snoutY - 1.8}" rx="2.6" ry=".9" fill="#fff" opacity=".35"/>
       <ellipse cx="${fx - 1.9}" cy="${snoutY + 0.2}" rx="1" ry="1.5" fill="${s.nose}"/><ellipse cx="${fx + 1.9}" cy="${snoutY + 0.2}" rx="1" ry="1.5" fill="${s.nose}"/>`
    : `<path d="M${fx - nr} ${hy + 1.6}q${nr} -1.3 ${nr * 2} 0q-.2 ${nr * 0.9} -${nr} ${nr * 1.05}q-${nr * 0.8} -.2 -${nr} -${nr * 1.05}z" fill="${s.nose}"/>
       <ellipse cx="${fx - nr * 0.3}" cy="${hy + 1.7}" rx="${nr * 0.35}" ry=".4" fill="#fff" opacity=".45"/>`;
  const mouthY = s.snout ? snoutY + 4.3 : hy + 1.6 + nr * 1.05 + 0.5;
  const whiskers = s.whiskers ? [-1, 1].map((k) => [-1, 1.2].map((dy) =>
    `<path d="M${fx + k * 4.5} ${hy + 5 + dy}l${k * 8} ${dy * 1.2 - 0.5}" stroke="${s.whisker || '#fff'}" stroke-width=".45" stroke-linecap="round" opacity=".75"/>`).join('')).join('') : '';

  // Each moving part is its own layer (a div holding a small SVG). The browser paints a
  // layer once and then only moves it, so the fur filter is not recomputed every frame.
  const fur = (name, inner) => petLayer(`${id}-${name}`, s, inner, true);
  const part = (cls, ox, oy, html) => `<div class="p-part ${cls}" style="transform-origin:${ox}px ${oy}px">${html}</div>`;
  const legPart = (x, cls, far, name, isHind) => part(`p-leg ${cls}`, x, by + 1, fur(name, legShape(x, far, isHind)));
  const neck = `<ellipse cx="${(bx + brx * 0.7 + hx) / 2}" cy="${(by - bry * 0.4 + hy + hry * 0.6) / 2}" rx="8.5" ry="9.5" fill="${s.neckColor || B}"/>`;
  // the near haunch: a rounded thigh the hind leg grows out of (big and low on a rabbit)
  const hip = s.haunch
    ? `<ellipse cx="${hind + 2.5}" cy="${by + 2}" rx="${lw + 5}" ry="${bry * 0.82}" fill="${B}"/>
       <path d="M${hind - 4} ${by - 4}q5-3.5 10 0" fill="none" stroke="${s.light}" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>`
    : (s.band
      // panda: the black of the hind leg climbs up over the haunch and fades into the white back
      ? `<path d="M${hind - lw * 0.62} ${by + bry}C${hind - lw - 1} ${by + 2} ${hind - 3} ${by - bry * 0.55} ${hind + 3} ${by - bry * 0.3}C${hind + lw} ${by - 1} ${hind + lw * 0.8} ${by + 6} ${hind + lw * 0.62} ${by + bry}Z" fill="${s.legColor}"/>`
      : `<ellipse cx="${hind + 1.5}" cy="${by + 2}" rx="${lw + 2.6}" ry="${bry * 0.72}" fill="${B}"/>`);
  // lamb: a woolly topknot over the brow
  const tuft = s.wool ? [-6, -2, 2, 6].map((d, i) => `<circle cx="${fx + d}" cy="${hy - hry + 2.6 - (i % 3 ? 1.2 : 0)}" r="${i % 3 ? 3.6 : 3}" fill="${Hd}"/>`).join('') : '';
  const look = { hx, hy, hrx, hry, ex, ey, er: 3.2, bow: [fx + 6.5, hy - hry + 1.2, 18], crown: [hx, hy + 0.4, hrx + 0.4, hry + 0.4, 208, 332],
    back: hx - hrx + 1.2, neck: [(bx + brx * 0.7 + hx) / 2 + 0.5, hy + hry - 0.5] };
  const face = `<svg class="p-layer" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" overflow="visible" xmlns="http://www.w3.org/2000/svg">
      ${[-1, 1].map((k) => `<ellipse cx="${fx + k * 8.6}" cy="${hy + 3.6}" rx="2.5" ry="1.5" fill="#ff7d9c" opacity=".38"/>`).join('')}
      ${whiskers}${nose}
      <g transform="translate(${fx} ${mouthY})"><path class="p-mouth" d="${PET_MOUTHS.okay}"/></g>
      <g class="p-eyes">${petEye(ex[0], ey, s)}${petEye(ex[1], ey, s)}</g>
      <g class="p-lids">${ex.map((x) => `<path d="M${x - 3.2} ${ey}q3.2 2.5 6.4 0"/>`).join('')}</g>
      ${petCap(hx, hy, hrx, hry)}
    </svg>`;
  return `<div class="pet-svg pet-rig">
    <svg class="p-layer" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" overflow="visible"><ellipse class="p-shadow" cx="${bx + 8}" cy="${G + 0.5}" rx="${brx + 14}" ry="2.6"/></svg>
    <div class="p-body">
      ${part('p-tail', tx, ty, fur('tail', tail))}
      ${legPart(hind + 4, 'leg-b', true, 'l1', true)}${legPart(fore + 3.5, 'leg-a', true, 'l2', false)}
      ${part('', 0, 0, fur('torso', `${wool}<ellipse cx="${bx}" cy="${by}" rx="${brx}" ry="${bry}" fill="${B}"/>${neck}<g clip-path="url(#§-cb)">${bodyMarks}</g>${hip}`))}
      ${legPart(hind, 'leg-a', false, 'l3', true)}${legPart(fore, 'leg-b', false, 'l4', false)}
      ${petOutfitNeck(outfit, look)}
      <div class="p-part p-headwrap" style="transform-origin:${hx}px ${hy + hry}px">
        <div class="p-part p-head" style="transform-origin:${hx}px ${hy + hry}px">
          ${fur('head', `${earsBack}<ellipse cx="${hx}" cy="${hy}" rx="${hrx}" ry="${hry}" fill="${Hd}"/>${ruff}<g clip-path="url(#§-ch)">${headMarks}</g>${tuft}${earsFront}`)}
          ${face}
          ${petOutfitHead(outfit, look)}
        </div>
      </div>
    </div>
  </div>`;
}

// One layer: a full-stage SVG with its own gradients and (for fur) the fur filter.
// Each layer gets unique ids, so many pets and the popup's previews never clash.
let petLayerCount = 0;
function petLayer(id, s, inner, furry) {
  const uid = `${id}-${(++petLayerCount).toString(36)}`;
  return `<svg class="p-layer" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" overflow="visible" xmlns="http://www.w3.org/2000/svg">
    ${petDefs(uid, s, s.body, s.head)}<g${furry ? ` filter="url(#${uid}-f)"` : ''}>${inner.replaceAll('§', uid)}</g></svg>`;
}

// The frog is built on the same rig as the others (layers, joints, nightcap); its skin
// gets the gentle "smooth" filter and a wet sheen instead of fur.
function drawFrog(id, s0, outfit) {
  const s = Object.assign({ smooth: true }, s0);
  const [bx, by, brx, bry] = s.body, [hx, hy, hrx, hry] = s.head, G = 63;
  const B = 'url(#§-b)', Hd = 'url(#§-h)';
  const ex = [hx - 6.2, hx + 6.2], ey = hy - 9;
  const skin = (name, inner) => petLayer(`${id}-${name}`, s, inner, true);
  const look = { hx, hy, hrx, hry, ex, ey, er: 3.7, bow: [hx, hy - 16.2, 0], crown: [hx, hy - 9, 12.6, 8.6, 214, 326],
    back: hx - hrx + 0.5, neck: [hx + 1, hy + hry - 2.4] };
  const part = (cls, ox, oy, html) => `<div class="p-part ${cls}" style="transform-origin:${ox}px ${oy}px">${html}</div>`;
  // a webbed foot: a pad with three round toe tips fanning forward
  const foot = (x, y, len, fill) => `<ellipse cx="${x + len / 2}" cy="${y}" rx="${len / 2 + 1}" ry="1.7" fill="${fill}"/>
      ${[[-1.3, 0.2], [0, 0.6], [1.3, 0.2]].map(([dy, dx]) => `<circle cx="${x + len + 0.6 + dx}" cy="${y + dy}" r="1.05" fill="${fill}"/>`).join('')}`;
  const hindX = bx - brx * 0.42, armX = hx - 3;

  const torso = `<ellipse cx="${bx}" cy="${by}" rx="${brx}" ry="${bry}" fill="${B}"/>
    <g clip-path="url(#§-cb)">
      <ellipse cx="${bx + 5}" cy="${by + bry * 0.75}" rx="${brx * 0.8}" ry="${bry * 0.5}" fill="${s.belly}" opacity=".95"/>
      ${[[bx - 9, by - 7, 2.3], [bx - 1, by - 9.5, 1.7], [bx - 15, by - 1, 1.5], [bx + 6, by - 7.5, 1.3]].map(([x, y, r]) =>
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${s.dark}" opacity=".42"/>`).join('')}
      <ellipse cx="${bx - 6}" cy="${by - bry + 3}" rx="8" ry="2.2" transform="rotate(-10 ${bx - 6} ${by - bry + 3})" fill="#fff" opacity=".3"/>
    </g>`;
  // near hind leg: folded thigh on the flank, long webbed foot along the ground
  const hindLeg = `<ellipse cx="${hindX}" cy="${by + 2}" rx="10.5" ry="7.2" transform="rotate(-22 ${hindX} ${by + 2})" fill="${B}"/>
    <path d="M${hindX - 8} ${by + 1}q5-5 13-4" fill="none" stroke="${s.light}" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>
    ${foot(hindX - 9, G - 1.6, 14, s.paw)}`;
  const arm = `<path d="M${armX - 2} ${hy + 4}H${armX + 2}Q${armX + 2.6} ${hy + 11} ${armX + 2.4} ${G - 2.4}H${armX - 0.6}Q${armX - 1.4} ${hy + 11} ${armX - 2} ${hy + 4}Z" fill="${B}"/>
    ${foot(armX - 1, G - 1.6, 3.5, s.paw)}`;
  const head = `<ellipse cx="${hx}" cy="${hy}" rx="${hrx}" ry="${hry}" fill="${Hd}"/>
    ${ex.map((x) => `<circle cx="${x}" cy="${ey}" r="5.6" fill="${Hd}"/>`).join('')}
    <g clip-path="url(#§-ch)"><ellipse cx="${hx + 1.5}" cy="${hy + hry * 0.72}" rx="${hrx * 0.8}" ry="${hry * 0.42}" fill="${s.belly}" opacity=".95"/>
      <ellipse cx="${hx - 4}" cy="${hy - hry + 2.6}" rx="5" ry="1.4" fill="#fff" opacity=".28"/></g>`;
  const face = `<svg class="p-layer" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" overflow="visible" xmlns="http://www.w3.org/2000/svg">
      ${ex.map((x) => `<ellipse cx="${x + 0.8}" cy="${hy - 1.3}" rx="2.4" ry="1.3" fill="#f7a8bb" opacity=".8"/>`).join('')}
      <circle cx="${hx + 9.8}" cy="${hy - 2.8}" r=".6" fill="${s.dark}"/><circle cx="${hx + 11.8}" cy="${hy - 2.3}" r=".6" fill="${s.dark}"/>
      <g transform="translate(${hx + 2} ${hy + 1.6}) scale(2.2 1)"><path class="p-mouth" vector-effect="non-scaling-stroke" d="${PET_MOUTHS.okay}"/></g>
      ${petCap(hx - 0.4, hy - 2, 6.5, 8.5)}
      <g class="p-eyes">${petEye(ex[0], ey, s, 3.7)}${petEye(ex[1], ey, s, 3.7)}</g>
      <g class="p-lids">${ex.map((x) => `<path d="M${x - 3.6} ${ey}q3.6 2.6 7.2 0"/>`).join('')}</g>
    </svg>`;
  return `<div class="pet-svg pet-rig">
    <svg class="p-layer" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" overflow="visible"><ellipse class="p-shadow" cx="${bx + 4}" cy="${G + 0.5}" rx="${brx + 11}" ry="2.6"/></svg>
    <div class="p-body">
      ${part('', 0, 0, skin('torso', torso))}
      ${part('p-leg leg-a', hindX, by + 2, skin('l1', hindLeg))}
      ${part('p-leg leg-b', armX, hy + 5, skin('l2', arm))}
      <div class="p-part p-headwrap" style="transform-origin:${hx}px ${hy + hry}px">
        <div class="p-part p-head" style="transform-origin:${hx}px ${hy + hry}px">
          ${skin('head', head)}
          ${face}
          ${petOutfitHead(outfit, look)}
        </div>
      </div>
      ${petOutfitNeck(outfit, look)}
    </div>
  </div>`;
}

// petModel(skinId) draws the bare animal; a known outfitId dresses it.
function petModel(skinId, outfitId) {
  const id = petHas(PET_SKINS, skinId) ? skinId : PET_DEFAULTS.skin;
  const s = PET_SKINS[id];
  const outfit = petHas(PET_OUTFITS, outfitId) ? outfitId : '';
  return s.kind === 'frog' ? drawFrog('pp-' + id, s, outfit) : drawQuad('pp-' + id, s, outfit);
}

// ---------- outfits ----------
// Flat, unfiltered drawings in their own layers. Head items live inside .p-head so they
// tilt and nod with it; the scarf lives on the body. No ids, so any number can coexist.
const PET_OUTFITS = { bow: { name: 'Bow' }, scarf: { name: 'Scarf' }, crown: { name: 'Flower crown' }, glasses: { name: 'Round glasses' } };

const petBow = (x, y, rot, k = 1) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${k})" stroke="#a8345a" stroke-width=".6" stroke-linejoin="round">
    <path d="M-1 .6L-2.6 4.4L-.6 3.6ZM1 .6L2.4 4.6L.4 3.6Z" fill="#e0507c"/>
    <path d="M0 0C-1.6-3.4-5.8-3.2-5.6 0C-5.8 3.2-1.6 3.4 0 0ZM0 0C1.6-3.4 5.8-3.2 5.6 0C5.8 3.2 1.6 3.4 0 0Z" fill="#f2668f"/>
    <path d="M-4.2-1.2q.8-1.2 2-1M2.2-2.2q1.3-.2 2 1" fill="none" stroke="#fff" stroke-width=".7" stroke-linecap="round" opacity=".75"/>
    <ellipse cx="0" cy="0" rx="1.5" ry="1.7" fill="#e0507c"/></g>`;

const PET_CROWN_COLORS = ['#f7a8c4', '#ffe07a', '#c9a8f5', '#ffffff'];
function petCrown(cx, cy, ax, ay, a0, a1, n = 6, r = 1) {
  const rad = (deg) => deg * Math.PI / 180;
  const at = (deg) => [cx + ax * Math.cos(rad(deg)), cy + ay * Math.sin(rad(deg))];
  const f = (v) => v.toFixed(2);
  const ang = (t) => a0 + (a1 - a0) * t;
  const leaves = Array.from({ length: n - 1 }, (_, i) => {
    const a = ang((i + 0.5) / (n - 1)), [x, y] = at(a);
    return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${1.7 * r}" ry="${0.8 * r}" transform="rotate(${f(a + 90)} ${f(x)} ${f(y)})" fill="#6fb24a"/>`;
  }).join('');
  const flowers = Array.from({ length: n }, (_, i) => {
    const [x, y] = at(ang(i / (n - 1)));
    const petals = [0, 72, 144, 216, 288].map((a) => `<circle cx="${f(x + 1.15 * r * Math.cos(rad(a + i * 20)))}" cy="${f(y + 1.15 * r * Math.sin(rad(a + i * 20)))}" r="${1.05 * r}"/>`).join('');
    return `<g fill="${PET_CROWN_COLORS[i % PET_CROWN_COLORS.length]}" stroke="#7a4a5a" stroke-opacity=".35" stroke-width=".3">${petals}</g><circle cx="${f(x)}" cy="${f(y)}" r="${0.75 * r}" fill="${i % 2 ? '#f29a3a' : '#f7c531'}"/>`;
  }).join('');
  return `<path d="M${at(a0).map(f).join(' ')}A${ax} ${ay} 0 0 1 ${at(a1).map(f).join(' ')}" fill="none" stroke="#4f8f36" stroke-width="${0.9 * r}" stroke-linecap="round"/>${leaves}${flowers}`;
}

// round frames around both eyes; a light lens tint, glints at the rim, never over the pupils
function petGlasses(ex, ey, R, back, w = 1.1) {
  const [a, b] = ex;
  return `<g fill="none" stroke-linecap="round">
    ${ex.map((x) => `<circle cx="${x}" cy="${ey}" r="${R}" fill="#fff" fill-opacity=".1" stroke="#3a2440" stroke-width="${w}"/>
      <path d="M${x + R * 0.36} ${ey - R * 0.7}a${R * 0.78} ${R * 0.78} 0 0 1 ${R * 0.38} ${R * 0.32}" stroke="#fff" stroke-width="${w * 0.6}" opacity=".8"/>`).join('')}
    <path d="M${a + R} ${ey - R * 0.15}Q${(a + b) / 2} ${ey - R * 0.75} ${b - R} ${ey - R * 0.15}" stroke="#3a2440" stroke-width="${w}"/>
    ${back === null ? '' : `<path d="M${a - R} ${ey - R * 0.2}L${back} ${ey - R * 0.55}" stroke="#3a2440" stroke-width="${w}"/>`}</g>`;
}

// a striped knit scarf: band round the neck, knot at the throat, two fringed ends
function petScarf(nx, ny, k = 1) {
  const band = `M${nx - 8 * k} ${ny - 2.4 * k}Q${nx} ${ny + 3.6 * k} ${nx + 8.6 * k} ${ny - 1.4 * k}`;
  const t1 = `M${nx + 3.6 * k} ${ny + 0.6 * k}L${nx + 2.8 * k} ${ny + 9.6 * k}H${nx + 6.4 * k}L${nx + 6.8 * k} ${ny + 1.2 * k}Z`;
  const t2 = `M${nx + 5.8 * k} ${ny + 0.8 * k}L${nx + 8.8 * k} ${ny + 8.4 * k}L${nx + 11.6 * k} ${ny + 7.2 * k}L${nx + 8.4 * k} ${ny}Z`;
  const fringe = (x, y, dx) => [0, 1, 2].map((i) => `M${x + i * dx * k} ${y}v${1.3 * k}`).join('');
  return `<g stroke-linejoin="round" stroke-linecap="round">
    <path d="${t2}" fill="#c43f50" stroke="#8e2a3a" stroke-width=".6"/>
    <path d="${band}" fill="none" stroke="#8e2a3a" stroke-width="${5.6 * k}"/>
    <path d="${band}" fill="none" stroke="#e25563" stroke-width="${4.4 * k}"/>
    <path d="${band}" fill="none" stroke="#fff2d6" stroke-width="${4.4 * k}" stroke-linecap="butt" stroke-dasharray="${1.3 * k} ${2.9 * k}"/>
    <path d="${t1}" fill="#e25563" stroke="#8e2a3a" stroke-width=".6"/>
    <path d="M${nx + 3.4 * k} ${ny + 4 * k}H${nx + 6.6 * k}M${nx + 3.2 * k} ${ny + 6.6 * k}H${nx + 6.5 * k}" stroke="#fff2d6" stroke-width="${1.1 * k}"/>
    <path d="${fringe(nx + 3.4 * k, ny + 9.8 * k, 1.3)}${fringe(nx + 9.2 * k, ny + 8.4 * k, 1.2)}" stroke="#c43f50" stroke-width=".7"/>
    <ellipse cx="${nx + 5.6 * k}" cy="${ny + 0.9 * k}" rx="${2.3 * k}" ry="${1.9 * k}" fill="#d64a5a" stroke="#8e2a3a" stroke-width=".6"/></g>`;
}

const petOutfitLayer = (cls, inner) => `<svg class="p-layer p-outfit${cls ? ' ' + cls : ''}" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" overflow="visible" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

// head items, drawn above the face inside .p-head (bow and crown give way to the nightcap)
function petOutfitHead(outfit, L) {
  if (outfit === 'bow') return petOutfitLayer('p-outfit-top', petBow(L.bow[0], L.bow[1], L.bow[2]));
  if (outfit === 'crown') return petOutfitLayer('p-outfit-top', petCrown(...L.crown));
  if (outfit === 'glasses') return petOutfitLayer('', petGlasses(L.ex, L.ey, L.er * 1.42, L.back));
  return '';
}

// the scarf: a plain part on the body, so it bobs with the body and not with the head
function petOutfitNeck(outfit, L) {
  if (outfit !== 'scarf') return '';
  return `<div class="p-part">${petOutfitLayer('', petScarf(L.neck[0], L.neck[1]))}</div>`;
}

// the outfit on its own, for the popup picker (24x24)
function petOutfitIcon(id) {
  const svg = (inner) => `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  if (id === 'bow') return svg(petBow(12, 12, 0, 1.75));
  if (id === 'crown') return svg(petCrown(12, 16.5, 8.4, 8, 192, 348, 5, 1.8));
  if (id === 'glasses') return svg(petGlasses([6.8, 17.2], 12.5, 4.4, null, 1.6));
  if (id === 'scarf') return svg(petScarf(11, 7, 0.95));
  return '';
}

// ---------- goodies: treats and toys ----------
// Inked like the bubble: one dark outline (#23182e), flat fills, a white glint upper left.
// `svg` is the 18x18 drawing used on the page; `icon` is the same drawing on a 24x24 tile.
const PET_GOODS_INK = '#23182e';
function petGood(attrs, inner) {
  return {
    svg: `<svg viewBox="0 0 18 18" width="18" height="18" ${attrs}>${inner}</svg>`,
    icon: `<svg viewBox="0 0 24 24" width="24" height="24"><g transform="translate(2 2) scale(1.111)" ${attrs}>${inner}</g></svg>`,
  };
}
const PET_GOODS_ART = {
  // a cookie with a bite out of the top right (first drawn for the page by content.js)
  cookie: petGood(`stroke="${PET_GOODS_INK}" stroke-linejoin="round" stroke-linecap="round"`, `<path d="M11.775 1.925A7.600 7.600 0 1 0 16.075 6.225A3.400 3.400 0 0 1 11.775 1.925Z" fill="#e6aa62" stroke-width="1.500"/>
    <path d="M3.700 8.500A5.400 5.400 0 0 1 6.800 3.900" fill="none" stroke="#f8d7a0" stroke-width="1.200"/>
    <g fill="#6b3d1c" stroke="none"><ellipse cx="6.500" cy="7" rx="1.500" ry="1.200"/><ellipse cx="11.200" cy="10.300" rx="1.500" ry="1.200"/><ellipse cx="6.800" cy="12.300" rx="1.300" ry="1.100"/><ellipse cx="13" cy="7.300" rx="1" ry=".9"/></g>`),
  cupcake: petGood(`stroke="${PET_GOODS_INK}" stroke-linejoin="round" stroke-linecap="round"`, `<path d="M3.6 9.6h10.8l-1.5 7H5.1z" fill="#7cc4e8" stroke-width="1.5"/>
    <path d="M7.2 10.4l.4 5.4M10.8 10.4l-.4 5.4" fill="none" stroke="#4a8fb8" stroke-width="1"/>
    <path d="M3.2 10.4C1.6 10.2 1.8 7.4 3.9 7.4C3.6 5 6.4 4.2 7.8 5.4C8.4 3.4 11.6 3.6 12 5.8C14.4 5.4 15.6 8 14.6 9.2C16 10.6 14.6 11.2 13.4 10.4Z" fill="#f7a8c4" stroke-width="1.5"/>
    <path d="M4.6 7.8q.4-1.4 1.8-1.6" fill="none" stroke="#fff" stroke-width="1.1" opacity=".85"/>
    <g stroke-width="1" fill="none"><path d="M6.4 8.6l1-.4" stroke="#f7c531"/><path d="M10.2 7.4l.8.6" stroke="#7c6cf2"/><path d="M12 9.2l1-.2" stroke="#5cc8f2"/></g>
    <circle cx="10.4" cy="3.4" r="1.7" fill="#e0405a" stroke-width="1.2"/>`),
  fish: petGood(`stroke="${PET_GOODS_INK}" stroke-linejoin="round" stroke-linecap="round"`, `<path d="M16.6 9C14.6 3.6 8.4 3.4 5.6 7.6L1.8 4.2C2.6 7 2.6 11 1.8 13.8L5.6 10.4C8.4 14.6 14.6 14.4 16.6 9Z" fill="#8ec0e8" stroke-width="1.5"/>
    <path d="M6.6 11C9.4 13.6 13.6 13.4 15.6 10.4" fill="none" stroke="#e4f2fb" stroke-width="1.2"/>
    <path d="M10 6.4q1.6 2.6 0 5.2" fill="none" stroke="#5a8fb8" stroke-width="1"/>
    <path d="M7.4 6.8q1.4-1 3-1.2" fill="none" stroke="#fff" stroke-width="1.1" opacity=".85"/>
    <circle cx="13" cy="8" r="1" fill="${PET_GOODS_INK}" stroke="none"/>`),
  // the yellow ball (first drawn for the page by content.js)
  ball: petGood(`stroke="${PET_GOODS_INK}" stroke-linecap="round"`, `<circle cx="9" cy="9" r="8.100" fill="#f2c230" stroke-width="1.500"/>
    <path d="M3.200 3.700C6.600 6.200 6.600 11.800 3.200 14.300M14.800 3.700C11.400 6.200 11.400 11.800 14.800 14.300" fill="none" stroke="#fff6c9" stroke-width="1.300"/>
    <ellipse cx="6" cy="5" rx="1.500" ry=".9" transform="rotate(-35 6 5)" fill="#fff" stroke="none" opacity=".7"/>`),
  frisbee: petGood(`stroke="${PET_GOODS_INK}" stroke-linejoin="round" stroke-linecap="round"`, `<g transform="rotate(-14 9 9)">
    <path d="M1.2 8.6v1.6c0 2.6 3.5 4.6 7.8 4.6s7.8-2 7.8-4.6V8.6" fill="#c94a2e" stroke-width="1.5"/>
    <ellipse cx="9" cy="8.6" rx="7.8" ry="4.6" fill="#ff7a59" stroke-width="1.5"/>
    <ellipse cx="9" cy="8.6" rx="4.6" ry="2.4" fill="none" stroke="#ffc2a8" stroke-width="1.2"/>
    <path d="M3.6 7q1.2-1.6 3.6-2.1" fill="none" stroke="#fff" stroke-width="1.1" opacity=".85"/></g>`),
  yarn: petGood(`stroke="${PET_GOODS_INK}" stroke-linejoin="round" stroke-linecap="round"`, `<path d="M13.8 13.6q2.6 1.4 1.4 3.4" fill="none" stroke-width="2.6"/><path d="M13.8 13.6q2.6 1.4 1.4 3.4" fill="none" stroke="#c58af5" stroke-width="1.1"/>
    <circle cx="8.6" cy="8.6" r="7.4" fill="#c58af5" stroke-width="1.5"/>
    <g fill="none" stroke="#8a4fc0" stroke-width="1"><path d="M3 6.4q5.6 1.4 9.6 7.6"/><path d="M5 3q5.4 3 7.8 10.6"/><path d="M2.2 10.6q6.4-.6 11.6-5.4"/><path d="M8.6 15.8q1.4-6 6.4-8.6"/></g>
    <path d="M4 5.6q1.2-1.8 3.2-2.4" fill="none" stroke="#fff" stroke-width="1.1" opacity=".85"/>`),
};
const PET_GOODIES = {
  treats: {
    cookie: Object.assign({ name: 'Cookie', premium: false, hunger: 25, happy: 5 }, PET_GOODS_ART.cookie),
    cupcake: Object.assign({ name: 'Cupcake', premium: true, hunger: 30, happy: 15 }, PET_GOODS_ART.cupcake),
    fish: Object.assign({ name: 'Fish', premium: true, hunger: 40, happy: 8 }, PET_GOODS_ART.fish),
  },
  toys: {
    ball: Object.assign({ name: 'Ball', premium: false, gravity: 1500 }, PET_GOODS_ART.ball),
    frisbee: Object.assign({ name: 'Frisbee', premium: true, gravity: 700 }, PET_GOODS_ART.frisbee),
    yarn: Object.assign({ name: 'Yarn', premium: true, gravity: 1500 }, PET_GOODS_ART.yarn),
  },
};

const PET_SVG_CSS = `
.pet-svg { display:block; overflow:visible; }
.pet-rig { position:relative; width:${PET_W}px; height:${PET_H}px; }
.pet-rig .p-body, .p-part { position:absolute; left:0; top:0; width:${PET_W}px; height:${PET_H}px; }
/* every moving part gets its own compositor layer: painted once, then only moved */
.p-part, .pet-rig .p-body { will-change: transform; }
.p-headwrap { transform: scale(1.16); }
.p-layer { position:absolute; left:0; top:0; overflow:visible; }
.p-shadow { fill: rgba(0,0,0,.22); }
.p-mouth { fill:#6e2a3c; stroke:${INK}; stroke-width:1; stroke-linecap:round; stroke-linejoin:round; }
.p-lids { display:none; fill:none; stroke:${INK}; stroke-width:1.1; stroke-linecap:round; }
.p-cap { display:none; }
.night .p-cap { display:block; }
.night .p-outfit-top { display:none; }
.asleep .p-eyes { display:none; }
.asleep .p-lids { display:block; }
/* idle: slow sway. walking: swings behind the stride. loved: fast wag */
.p-tail { animation: pet-tail 3.2s cubic-bezier(.45,0,.55,1) infinite; }
.walking .p-tail { animation: pet-tail-walk var(--gait, .64s) cubic-bezier(.45,0,.55,1) -.12s infinite; }
.loved .p-tail { animation: pet-wag .26s cubic-bezier(.45,0,.55,1) infinite; }
.asleep .p-tail { animation: none; }
/* gait: a quick lifted swing forward (first 36%), then the planted foot travels back at ground speed */
.walking .leg-a, .walking .leg-b { animation: pet-leg var(--gait, .64s) infinite; }
.walking .leg-b { animation-delay: calc(var(--gait, .64s) / -2); }
@keyframes pet-leg {
  0% { transform: rotate(18deg); animation-timing-function: cubic-bezier(.3,0,.5,1); }
  18% { transform: rotate(0deg) translateY(-2.4px); animation-timing-function: cubic-bezier(.2,.6,.4,1); }
  36% { transform: rotate(-20deg); animation-timing-function: linear; }
  100% { transform: rotate(18deg); }
}
@keyframes pet-tail { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(7deg); } }
@keyframes pet-tail-walk { 0%,100% { transform: rotate(-9deg); } 50% { transform: rotate(10deg); } }
@keyframes pet-wag { 0%,100% { transform: rotate(-14deg); } 50% { transform: rotate(16deg); } }
`;

// Little gifts the pet digs up and brings you; counts are kept in pet.treasures.
const PET_TREASURES = {
  star: { how: 'dig', hint: 'Dug up now and then', name: 'Star', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2.4l2.8 6.1 6.7.8-5 4.6 1.4 6.6L12 17.2l-5.9 3.3 1.4-6.6-5-4.6 6.7-.8z" fill="#f7c531" stroke="#b9860b" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 6.2l-1.5 3.3" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
  heart: { how: 'dig', hint: 'Dug up now and then', name: 'Heart', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 20.5C5 15 3 11.5 3 8.5a4.5 4.5 0 0 1 9-2 4.5 4.5 0 0 1 9 2c0 3-2 6.5-9 12z" fill="#f0668f" stroke="#b33a62" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.8 9.2a2.6 2.6 0 0 1 2.2-2.4" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
  gem: { how: 'dig', hint: 'Dug up now and then', name: 'Gem', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 4h12l4 6-10 11L2 10z" fill="#5cc8f2" stroke="#2386b0" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 4h3l-2 6H2z" fill="#fff" opacity=".45"/><path d="M12 21l5-11h5z" fill="#2386b0" opacity=".25"/><path d="M2 10h20M9 4l-2 6 5 11 5-11-2-6" fill="none" stroke="#2386b0" stroke-width=".8" stroke-linejoin="round"/></svg>` },
  flower: { how: 'dig', hint: 'Dug up now and then', name: 'Flower', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><g fill="#c58af5" stroke="#8a4fc0" stroke-width="1.2">${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="12" cy="6.6" rx="3.5" ry="4.4" transform="rotate(${a} 12 12)"/>`).join('')}</g><circle cx="12" cy="12" r="3.2" fill="#f7c531" stroke="#b9860b" stroke-width="1.2"/><path d="M10.6 4.6a2 2 0 0 1 1.6-1" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
  bookmark: { how: 'earned', hint: 'Read a long page all the way to the end', name: 'Bookmark', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 2.5h10v18.5l-5-4-5 4z" fill="#ef7d57" stroke="#a9441f" stroke-width="1.2" stroke-linejoin="round"/><path d="M14 2.5v18.5l3-2.4V2.5z" fill="#a9441f" opacity=".2"/><path d="M9.4 5.4v5" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
  note: { how: 'earned', hint: 'Play some music while it is around', name: 'Music note', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M9.5 17.5V5.2l10-2.2v12.5" fill="none" stroke="#4b3fc0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="M9.5 8.4l10-2.2" stroke="#4b3fc0" stroke-width="2"/><ellipse cx="7" cy="17.5" rx="3.2" ry="2.5" fill="#7c6cf2" stroke="#4b3fc0" stroke-width="1.2"/><ellipse cx="17" cy="15.5" rx="3.2" ry="2.5" fill="#7c6cf2" stroke="#4b3fc0" stroke-width="1.2"/><path d="M5.2 17a1.8 1.8 0 0 1 1.6-1.2M15.2 15a1.8 1.8 0 0 1 1.6-1.2" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
  moon: { how: 'earned', hint: 'Keep browsing after 11pm', name: 'Moon', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 2.8a9 9 0 1 0 6.2 13.9A7.2 7.2 0 0 1 15 2.8z" fill="#ffd866" stroke="#b58b14" stroke-width="1.2" stroke-linejoin="round"/><circle cx="9" cy="13" r="1.3" fill="#e8bd3a"/><circle cx="12.5" cy="17.2" r=".9" fill="#e8bd3a"/><path d="M5.4 10.4a7.4 7.4 0 0 1 3.2-4.2" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
  pencil: { how: 'earned', hint: 'Type up a storm in a text box', name: 'Pencil', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><g transform="rotate(40 12 12)"><rect x="9" y="1.5" width="6" height="2.8" rx=".6" fill="#f08aa5" stroke="#a83a5e" stroke-width="1.2"/><rect x="9" y="4.3" width="6" height="12.7" fill="#f7c531" stroke="#a87a0b" stroke-width="1.2"/><path d="M13 4.3v12.7" stroke="#a87a0b" stroke-width=".8" opacity=".5"/><path d="M9 17h6l-3 5.2z" fill="#f2d4a8" stroke="#a87a0b" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.1 20.4h1.8l-.9 1.6z" fill="#2a2024"/><path d="M10.6 6.2v8" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></g></svg>` },
  teacup: { how: 'earned', hint: 'Take the stretch break it suggests', name: 'Teacup', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 2.8c-1 1.5 1 2.2 0 3.7M12 2.8c-1 1.5 1 2.2 0 3.7" fill="none" stroke="#8aa39c" stroke-width="1.2" stroke-linecap="round"/><path d="M17 10.5h1.4a2.6 2.6 0 0 1 0 5.2H16.4" fill="none" stroke="#2f7a68" stroke-width="1.2"/><path d="M3.5 9h13.5v3.8a6.2 6.2 0 0 1-6.2 6.2h-1.1a6.2 6.2 0 0 1-6.2-6.2z" fill="#9fd8c9" stroke="#2f7a68" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 11v1.8a4 4 0 0 0 1.2 2.8" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/><path d="M2.8 21.2h16.5" stroke="#2f7a68" stroke-width="1.4" stroke-linecap="round"/></svg>` },
  sun: { how: 'earned', hint: 'Come back after a few hours away', name: 'Sun', svg: `<svg viewBox="0 0 24 24" width="22" height="22"><g stroke="#f0a43a" stroke-width="2" stroke-linecap="round"><path d="M12 2.3v2.6M12 19.1v2.6M2.3 12h2.6M19.1 12h2.6M5.1 5.1l1.9 1.9M17 17l1.9 1.9M5.1 18.9L7 17M17 7l1.9-1.9"/></g><circle cx="12" cy="12" r="4.8" fill="#ffc35a" stroke="#c4761a" stroke-width="1.2"/><path d="M9.2 11.2a3 3 0 0 1 2-2.2" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".7"/></svg>` },
};
