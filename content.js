// Page Pet content script: draws the pet on the page and runs its behaviour.
(() => {
  if (window.__pagePetRan === true) return;
  window.__pagePetRan = true;
  if (!(document instanceof HTMLDocument)) return;     // XML, SVG and other non-HTML documents

  const W = PET_W, H = PET_H;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- lifecycle ----------
  // When the extension is updated, reloaded or removed, this copy is cut off from it.
  // Notice that, stop every timer and remove the pet instead of throwing errors forever.
  const timers = [];
  const alive = () => { try { return !!ext.runtime?.id; } catch { return false; } };
  function teardown() {
    if (dead) return;
    dead = true;
    timers.forEach(clearInterval);
    host.remove();
  }
  function every(fn, ms) {
    timers.push(setInterval(() => { if (!alive()) teardown(); else if (!dead) fn(); }, ms));
  }
  // Storage calls that fail quietly (and tear down) if the extension has gone away.
  // On failure they never resolve, so follow-up code does not run on stale data.
  const settle = (pr) => pr.catch(() => { if (!alive()) teardown(); return new Promise(() => {}); });
  const petAct = (op, arg) => settle(petDo(op, arg));
  const petLoad = () => settle(loadPet());

  // ---------- small drawn shapes (same ink outline as the bubble and the pet) ----------
  const INK_C = '#23182e';
  const ICON_STYLE = `fill="currentColor" stroke="${INK_C}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"`;
  const ICONS = {
    heart: { color: '#ff5c8a', svg: `<svg viewBox="0 0 16 16" ${ICON_STYLE}><path d="M8 14.2C3.2 10.8 1.6 8.500 1.600 5.800A3.400 3.400 0 0 1 8 4.300a3.400 3.400 0 0 1 6.400 1.500c0 2.700-1.600 5-6.400 8.400z"/><path d="M4.200 6.200q.2-1.300 1.400-1.500" fill="none" stroke="#fff" stroke-width="1.100" opacity=".8"/></svg>` },
    spark: { color: '#f7c531', svg: `<svg viewBox="0 0 16 16" ${ICON_STYLE}><path d="M8 1.400Q8.800 7.200 14.600 8Q8.800 8.800 8 14.600Q7.200 8.800 1.400 8Q7.200 7.200 8 1.400z"/></svg>` },
    note: { color: '#7c5cff', svg: `<svg viewBox="0 0 16 16" ${ICON_STYLE}><path d="M8.300 11V2.200q.4 2.400 3.500 3.100q.8 1.600-.2 3q.2-1.500-3.300-2.400" /><ellipse cx="5.800" cy="11.800" rx="3" ry="2.300" transform="rotate(-20 5.800 11.800)"/></svg>` },
    notes: { color: '#7c5cff', svg: `<svg viewBox="0 0 16 16" ${ICON_STYLE}><path d="M5.300 11.200V4l8.200-1.600v8.400" fill="none"/><path d="M5.300 4l8.200-1.600v2.800L5.300 6.800z"/><ellipse cx="3.400" cy="11.600" rx="2.500" ry="2" transform="rotate(-20 3.400 11.600)"/><ellipse cx="11.600" cy="10.300" rx="2.500" ry="2" transform="rotate(-20 11.600 10.300)"/></svg>` },
    z: { color: '#9aa8ff', svg: `<svg viewBox="0 0 16 16" fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="M3.800 4.200h8.400L3.800 12h8.400" stroke="${INK_C}" stroke-width="4.200"/><path d="M3.800 4.200h8.400L3.800 12h8.400" stroke="currentColor" stroke-width="1.900"/></svg>` },
  };
  const BALL_SVG = `<svg viewBox="0 0 18 18" stroke="${INK_C}" stroke-linecap="round"><circle cx="9" cy="9" r="8.100" fill="#f2c230" stroke-width="1.500"/>
    <path d="M3.200 3.700C6.600 6.200 6.600 11.800 3.200 14.300M14.800 3.700C11.400 6.200 11.400 11.800 14.800 14.300" fill="none" stroke="#fff6c9" stroke-width="1.300"/>
    <ellipse cx="6" cy="5" rx="1.500" ry=".9" transform="rotate(-35 6 5)" fill="#fff" stroke="none" opacity=".7"/></svg>`;
  // a cookie with a bite out of the top right
  const COOKIE_SVG = `<svg viewBox="0 0 18 18" stroke="${INK_C}" stroke-linejoin="round" stroke-linecap="round"><path d="M11.775 1.925A7.600 7.600 0 1 0 16.075 6.225A3.400 3.400 0 0 1 11.775 1.925Z" fill="#e6aa62" stroke-width="1.500"/>
    <path d="M3.700 8.500A5.400 5.400 0 0 1 6.800 3.900" fill="none" stroke="#f8d7a0" stroke-width="1.200"/>
    <g fill="#6b3d1c" stroke="none"><ellipse cx="6.500" cy="7" rx="1.500" ry="1.200"/><ellipse cx="11.200" cy="10.300" rx="1.500" ry="1.200"/><ellipse cx="6.800" cy="12.300" rx="1.300" ry="1.100"/><ellipse cx="13" cy="7.300" rx="1" ry=".9"/></g></svg>`;

  // ---------- DOM (shadow root keeps page styles out) ----------
  // A random tag name each load and a closed shadow root: the page cannot find the
  // pet by name, read what it says, restyle it, or click it from script.
  const host = document.createElement('pet-' + Math.random().toString(36).slice(2, 10));
  for (const [k, v] of Object.entries({ all: 'initial', position: 'fixed', left: '0', top: '0', width: '0', height: '0',
    'z-index': '2147483647', 'pointer-events': 'none', display: 'block' })) host.style.setProperty(k, v, 'important');
  host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'closed' });
  petSetMarkup(root, `
<style>
${PET_SVG_CSS}
.pet, .ball, .treat, .heart { position:fixed; left:0; top:0; will-change:transform; }
.pet { width:${W}px; height:${H}px; pointer-events:auto; cursor:grab; touch-action:none; user-select:none; -webkit-user-select:none; }
.pet.held { cursor:grabbing; }
.pet { z-index:2; }   /* its speech bubble stays above the floating icons */
/* standing on a button or link it can't get off: fade and let clicks pass straight through */
.pet.ghost { opacity:.42; pointer-events:none; transition-duration:.3s; }
.pet { transition: opacity .18s ease-in; }
/* a dashed outline marks the fade as "click-through", not a glitch */
.pet::after { content:''; position:absolute; left:6px; right:4px; top:12px; bottom:0; box-sizing:border-box;
  border:1.5px dashed #23182e; border-radius:22px 22px 10px 10px; box-shadow:0 0 0 1.5px rgba(255,255,255,.75);
  opacity:0; transition:opacity .15s ease-in; pointer-events:none; }
.pet.ghost::after { opacity:1; transition-duration:.3s; }
.pet { --gait: .64s; }
.pet.running { --gait: .34s; }
.pet.hops { --gait: .5s; }
:host(.paused) * { animation-play-state: paused !important; }
/* turning round is a quick flip, not a jump cut */
.flip { width:100%; height:100%; transition: transform .2s cubic-bezier(.3,0,.2,1); }
.pet-svg { transform-origin: 50% 96%; transition: transform .14s ease-out; }
.p-body { transform-origin: 44px 62px; }
/* the body bobs twice per stride and leans into a run; the head follows a beat behind */
.walking .p-body { animation: walk-bob calc(var(--gait) / 2) ease-in-out infinite; }
.running .p-body { animation-name: run-bob; }
.walking .p-head { animation: head-bob var(--gait) ease-in-out -.08s infinite; }
/* rabbits and frogs hop instead of walking */
.hops.walking .p-body { animation: hop var(--gait) infinite; }
.hops.walking .p-leg, .hops.walking .p-head { animation: none; }
/* squash and stretch: stretched in the air, squashed on landing, squished by a pat */
.falling .pet-svg { transform: scale(.93, 1.09); }
.land .pet-svg { animation: land .34s cubic-bezier(.2,.7,.3,1); }
.pat .pet-svg { animation: pat .38s cubic-bezier(.2,.7,.3,1); }
.eat .p-head { animation: munch .3s ease-in-out infinite; }
.idle .p-body, .eat .p-body { animation: breathe 2.6s ease-in-out infinite; }
.asleep .p-body { animation: breathe 4.2s ease-in-out infinite; }
.held .p-body { animation: wiggle .3s ease-in-out infinite; }
.pet.dancing .p-body { animation: dance .62s ease-in-out infinite; }
.pet.dig .p-body { animation: dig .2s ease-in-out infinite; }
.idle .p-head { animation: tilt 7s ease-in-out infinite; }
.pet.typing .p-head { animation: nod .32s ease-in-out infinite; }
.asleep .p-head { animation: none; transform: rotate(7deg); }
@keyframes dance { 0%,100% { transform: rotate(-6deg) translateY(0); } 25%,75% { transform: rotate(0) translateY(-3px); } 50% { transform: rotate(6deg) translateY(0); } }
@keyframes dig { 0%,100% { transform: rotate(5deg); } 50% { transform: rotate(9deg) translateY(1px); } }
@keyframes tilt { 0%,78%,100% { transform: rotate(0); } 84%,94% { transform: rotate(-9deg); } }
@keyframes nod { 0%,100% { transform: rotate(0); } 50% { transform: rotate(5deg); } }
.gem { position:fixed; width:30px; height:30px; box-sizing:border-box; border-radius:50%; pointer-events:auto; cursor:pointer;
  background:rgba(255,255,255,.88); border:2px solid #23182e; box-shadow:0 2px 6px rgba(0,0,0,.22);
  animation: gem-pop .42s cubic-bezier(.16,1,.3,1) both; }
.gem-i { position:absolute; left:1px; top:1px; width:24px; height:24px; animation: gem-bob 2.6s ease-in-out .45s infinite; transition: scale .14s ease-out; }
.gem-i svg { display:block; width:24px; height:24px; }
.gem:hover .gem-i { scale:1.16; }
.gem-tw { position:absolute; right:-6px; top:-6px; width:12px; height:12px; opacity:0; animation: gem-twinkle 2.6s ease-in-out .9s infinite; pointer-events:none; }
.gem-tw svg { display:block; width:12px; height:12px; }
/* picked up: slides to the pet and shrinks into it (quick, ease-in) */
.gem.taken { pointer-events:none; animation: gem-take .34s cubic-bezier(.5,0,.8,.5) forwards; }
@keyframes gem-pop { from { transform: translateY(14px) scale(.3); opacity:0; } to { transform:none; opacity:1; } }
@keyframes gem-bob { 0%,100% { transform:none; } 50% { transform: translateY(-2px); } }
@keyframes gem-twinkle { 0%,55%,100% { opacity:0; transform:scale(.3) rotate(0); } 72% { opacity:1; transform:scale(1) rotate(45deg); } 88% { opacity:0; transform:scale(.4) rotate(90deg); } }
@keyframes gem-take { 0% { transform:none; opacity:1; } 75% { opacity:1; } 100% { transform: translate(var(--fx, 0px), var(--fy, 0px)) scale(.2); opacity:0; } }
.eat .p-mouth { animation: chew .28s steps(2) infinite; }
.blink .p-eye { transform: scaleY(.1); transform-box: fill-box; transform-origin: center; }
@keyframes walk-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
@keyframes run-bob { 0%,100% { transform: rotate(3deg) translateY(0); } 50% { transform: rotate(4deg) translateY(-2.6px); } }
@keyframes head-bob { 0%,100% { transform: rotate(-2deg); } 50% { transform: rotate(2.5deg); } }
@keyframes hop {
  0% { transform: translateY(0) scale(1.07,.9); animation-timing-function: cubic-bezier(.2,.7,.4,1); }
  22% { transform: translateY(-4px) scale(.95,1.07); animation-timing-function: cubic-bezier(.2,.6,.5,1); }
  50% { transform: translateY(-9px) scale(1,1); animation-timing-function: cubic-bezier(.5,0,.8,.4); }
  82% { transform: translateY(-1px) scale(.96,1.06); animation-timing-function: ease-out; }
  100% { transform: translateY(0) scale(1.07,.9); }
}
@keyframes land { 0% { transform: scale(1.14,.82); } 45% { transform: scale(.96,1.05); } 100% { transform: scale(1,1); } }
@keyframes pat { 0% { transform: scale(1,1); } 30% { transform: scale(1.09,.9); } 65% { transform: scale(.97,1.04); } 100% { transform: scale(1,1); } }
@keyframes munch { 0%,100% { transform: rotate(8deg); } 50% { transform: rotate(12deg) translateY(.6px); } }
@keyframes breathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.015,.975); } }
@keyframes wiggle { 0%,100% { transform: rotate(-7deg); } 50% { transform: rotate(7deg); } }
@keyframes chew { 0% { opacity:1; } 100% { opacity:.2; } }
.bubble {
  position:absolute; left:50%; bottom:${H + 8}px; box-sizing:border-box; width:max-content; max-width:min(220px, calc(100vw - 32px));
  transform:translateX(calc(-50% + var(--sx, 0px))) scale(.7); transform-origin:var(--tx, 50%) 100%;
  background:#fff; color:#23182e; border:2px solid #23182e; border-radius:13px; padding:4px 10px 5px;
  font:600 12px/1.35 ui-rounded, "SF Pro Rounded", system-ui, sans-serif; font-style:normal; letter-spacing:0; text-transform:none; text-align:center;
  white-space:normal; overflow-wrap:anywhere; text-wrap:balance; box-shadow:0 3px 8px rgba(0,0,0,.2);
  opacity:0; transition:opacity .12s ease-in, transform .12s ease-in; pointer-events:none;
}
/* the tail: a rotated square that hides the border behind it, pointing at the pet */
.bubble::after {
  content:''; position:absolute; left:var(--tx, 50%); bottom:-7px; width:10px; height:10px; margin-left:-5px; box-sizing:border-box;
  background:#fff; border:solid #23182e; border-width:0 2px 2px 0; border-radius:0 0 3px 0; transform:rotate(45deg);
}
.bubble.show { opacity:1; transform:translateX(calc(-50% + var(--sx, 0px))) scale(1); transition:opacity .16s ease-out, transform .26s cubic-bezier(.16,1,.3,1); }
/* only when the pet has been lifted to the very top of the window */
.bubble.below { bottom:auto; top:${H + 8}px; transform-origin:var(--tx, 50%) 0; }
.bubble.below::after { bottom:auto; top:-7px; transform:rotate(225deg); }
.ball, .treat { pointer-events:none; }
.ball { width:18px; height:18px; }
.treat { width:18px; height:18px; }
.ball svg, .treat svg { display:block; width:18px; height:18px; }
.heart { pointer-events:none; width:16px; height:16px; color:#ff5c8a; animation: floatup 1.1s cubic-bezier(.2,.7,.3,1) both; }
.heart svg { display:block; width:100%; height:100%; overflow:visible; }
.heart.z { animation: zfloat 2.2s cubic-bezier(.3,.5,.4,1) both; }
@keyframes floatup { 0% { opacity:0; scale:.4; translate:0 0; } 18% { opacity:1; scale:1.15; } 60% { opacity:1; scale:1; } 100% { opacity:0; translate:var(--dx, 0px) -50px; } }
@keyframes zfloat { 0% { opacity:0; scale:.5; translate:0 0; } 22% { opacity:1; } 70% { opacity:1; } 100% { opacity:0; scale:1.2; translate:var(--dx, 10px) -38px; } }
@keyframes fade-only { 0%,50% { opacity:1; } 100% { opacity:0; } }
[hidden] { display:none !important; }
/* reduced motion: the pet stays put and still; speech, icons and face changes remain, with fades instead of movement */
@media (prefers-reduced-motion: reduce) {
  .p-body, .p-head, .p-tail, .p-leg, .p-mouth, .pet-svg, .gem, .gem-i, .gem-tw { animation: none !important; }
  .flip, .pet-svg, .gem-i { transition: none; }
  .gem:hover .gem-i { scale:1; }
  .gem-tw { opacity:.9; }
  .gem { animation: gem-fade .2s ease-out both !important; }
  .gem.taken { animation: fade-only .2s ease-in forwards !important; }
  .heart, .heart.z { animation: fade-only 1.2s ease-in both !important; }
  .bubble, .bubble.show { transform:translateX(calc(-50% + var(--sx, 0px))); transition: opacity .12s; }
}
@keyframes gem-fade { from { opacity:0; } to { opacity:1; } }
</style>
<div class="pet idle"><div class="flip">${petModel(PET_DEFAULTS.skin)}</div><div class="bubble"></div></div>
<div class="ball" hidden>${BALL_SVG}</div>
<div class="treat" hidden>${COOKIE_SVG}</div>`);

  const elPet = root.querySelector('.pet');
  const elFlip = root.querySelector('.flip');
  let elEyes = root.querySelectorAll('.p-pupil');
  let elMouth = root.querySelector('.p-mouth');
  let shownSkin = PET_DEFAULTS.skin;
  const elBubble = root.querySelector('.bubble');
  const elBall = root.querySelector('.ball');
  const elTreat = root.querySelector('.treat');

  // ---------- state ----------
  let pet = Object.assign({}, PET_DEFAULTS);
  let x = rand(40, Math.max(60, window.innerWidth - 140));
  let y = 0;                 // height above the floor
  let vy = 0;
  let dir = 1;
  let state = 'idle';
  let stateUntil = 0;
  let walkTarget = 0;
  let ball = null;           // {x, y, vx, vy, kicks, born}
  let treat = null;          // {x, y, vy}
  let kickCooldown = 0;
  let mouse = { x: -999, y: -999 };
  let lastActivity = performance.now();
  let lastNap = 0;
  let bubbleTimer = 0;
  let loveUntil = 0;
  let started = false;
  let meal = 'cookie';          // the treat currently being eaten
  let speed = 0;                              // current walking speed, eased toward its target
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  // page-aware extras
  let keyCount = 0, typingUntil = -1e9;
  let dancing = false;
  let lastScrollY = window.scrollY, lastScrollT = 0, lastHop = 0, saidEnd = false;
  let gem = null, nextGemAt = performance.now() + rand(60000, 120000);
  let lastIdleSay = -1e9, dead = false, lastDisplay = null, lastMouth = null, noClearUntil = 0;
  let mouseMovedAt = performance.now(), visited = false, walkSay = '';
  const nightNow = () => { const h = new Date().getHours(); return h >= 23 || h < 5; };
  let isNight = nightNow();

  const maxX = () => Math.max(0, document.documentElement.clientWidth - W);

  // ---------- staying out of the way ----------
  // Visible only when switched on, not snoozed, and not hidden on this site.
  const shown = () => !dead && pet.enabled && Date.now() >= pet.snoozeUntil && !pet.hiddenSites.includes(location.hostname);

  const INTERACTIVE = 'a[href],button,input,textarea,select,summary,label,video,audio,iframe,[role=button],[role=link],'
    + '[role=tab],[role=textbox],[role=slider],[role=checkbox],[contenteditable]:not([contenteditable=false]),[onclick]';
  // Is there something clickable under the spot where the pet would stand?
  function blockedAt(px) {
    const top = window.innerHeight - H;
    for (const fx of [0.22, 0.5, 0.78]) {
      for (const fy of [0.4, 0.88]) {
        for (const el of document.elementsFromPoint(px + W * fx, top + H * fy)) {
          if (el === host) continue;
          if (el === document.documentElement || el === document.body) break;
          if (el.closest(INTERACTIVE) || getComputedStyle(el).cursor === 'pointer') return true;
          break;                      // only the topmost thing under the pet matters
        }
      }
    }
    return false;
  }
  // The nearest spot to `prefer` with nothing clickable under it, or null.
  function clearSpot(prefer) {
    const max = maxX();
    prefer = Math.max(0, Math.min(max, prefer));
    for (let d = 0; d <= max; d += 28) {
      for (const px of d ? [prefer + d, prefer - d] : [prefer]) {
        if (px >= 0 && px <= max && !blockedAt(px)) return px;
      }
    }
    return null;
  }
  const floorTop = () => window.innerHeight - H;

  function setState(s, ms) {
    state = s;
    stateUntil = performance.now() + (ms || 0);
    if (s !== 'walk' && s !== 'chase') speed = 0;
    elPet.className = 'pet ' + ({ walk: 'walking', chase: 'walking running', sleep: 'asleep', fall: 'falling' }[s] || s)
      + ((PET_SKINS[pet.skin] || {}).hop ? ' hops' : '');
    updateFace();
  }

  // one-shot reaction classes (land, pat) that clear themselves
  function oneShot(cls, ms) {
    elPet.classList.remove(cls);
    void elPet.offsetWidth;            // restart the animation if it is already running
    elPet.classList.add(cls);
    setTimeout(() => elPet.classList.remove(cls), ms);
  }

  function updateFace() {
    let m;
    if (state === 'sleep') m = 'sleep';
    else if (state === 'eat' || state === 'held' || state === 'fall') m = 'open';
    else if (performance.now() < loveUntil) m = 'happy';
    else {
      const mood = petMood(pet);
      m = mood === 'happy' ? 'happy' : (mood === 'sad' || mood === 'hungry') ? 'sad' : 'okay';
    }
    if (m !== lastMouth) { lastMouth = m; elMouth.setAttribute('d', PET_MOUTHS[m]); }
  }

  // Keep the bubble inside the window and its tail on the pet: slide the bubble sideways near
  // an edge and move the tail back over the pet. Runs only while a line is showing, and
  // writes only when the result changes.
  let bubW = 0, bubH = 0, bubbleOn = false;
  function placeBubble(top) {
    const vw = document.documentElement.clientWidth, cx = x + W / 2;
    const left = Math.max(8, Math.min(vw - 8 - bubW, cx - bubW / 2));
    const sx = Math.round(left - (cx - bubW / 2));
    const below = top - bubH - 16 < 4;
    if (sx !== last.bsx) {
      last.bsx = sx;
      const tx = Math.max(Math.min(16, bubW / 2), Math.min(bubW - Math.min(16, bubW / 2), bubW / 2 - sx));
      elBubble.style.setProperty('--sx', sx + 'px');
      elBubble.style.setProperty('--tx', Math.round(tx) + 'px');
    }
    if (below !== last.below) { last.below = below; elBubble.classList.toggle('below', below); }
  }

  // `say` answers something you did; `sayIdle` is chatter. Quiet mode keeps only the
  // answers, silent keeps neither, and chatter is rate-limited even in chatty mode.
  function say(text, ms = 2200) {
    if (pet.chatter === 'silent') return;
    elBubble.textContent = text;
    bubW = elBubble.offsetWidth; bubH = elBubble.offsetHeight;        // measured once per line, not per frame
    bubbleOn = true; last.bsx = NaN; last.below = null;
    placeBubble(floorTop() - y);
    elBubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubbleOn = false;
      elBubble.classList.remove('show');
      setTimeout(() => { if (!elBubble.classList.contains('show')) elBubble.textContent = ''; }, 200);
    }, ms);
  }
  function sayIdle(text, ms) {
    const now = performance.now();
    if (pet.chatter !== 'chatty' || now - lastIdleSay < 25000) return;
    lastIdleSay = now;
    say(text, ms);
  }

  const sound = () => (PET_SKINS[pet.skin] || {}).sound || 'hi!';

  // Floating icons: 'heart', 'spark', 'note', 'notes' or 'z'. At most 14 live; each removes itself.
  function hearts(n = 3, kind = 'heart') {
    if (document.hidden) return;
    const icon = ICONS[kind] || ICONS.heart;
    for (let i = 0; i < n && root.querySelectorAll('.heart').length < 14; i++) {
      const h = document.createElement('div');
      h.className = kind === 'z' ? 'heart z' : 'heart';
      petSetMarkup(h, icon.svg);
      h.style.color = icon.color;
      // z's rise from the sleeping head (which is on the other side when facing left)
      const px = kind === 'z' ? x + (dir > 0 ? 58 : W - 72) : x + rand(4, W - 16);
      const py = kind === 'z' ? floorTop() - y + 4 : floorTop() - y + rand(-10, 8);
      h.style.setProperty('--dx', (kind === 'z' ? rand(6, 16) * dir : rand(-12, 12)) + 'px');
      h.style.transform = `translate(${px}px, ${py}px)`;
      h.style.animationDelay = i * 0.12 + 's';
      h.addEventListener('animationend', () => h.remove());
      setTimeout(() => h.remove(), 2600);
      root.appendChild(h);
    }
  }

  function applyAppearance() {
    const look = pet.skin + '|' + pet.outfit;
    if (look !== shownSkin) {
      shownSkin = look;
      petSetMarkup(elFlip, petModel(pet.skin, pet.outfit));
      elEyes = root.querySelectorAll('.p-pupil');
      elMouth = root.querySelector('.p-mouth');
      lastMouth = null;
      last.look = '';
      if (started) { say(pick(['new look!', 'ta-da!', 'how do I look?'])); hearts(2); }
    }
    const display = shown() ? 'block' : 'none';
    if (display !== lastDisplay) { lastDisplay = display; host.style.setProperty('display', display, 'important'); }
    updateFace();
  }

  // ---------- toys ----------
  // Treats and toys come from PET_GOODIES (pet-core.js). Premium ones (Goodies pack)
  // only work once the pack is unlocked; anything else falls back to cookie and ball.
  const goodie = (group, kind) => {
    const set = typeof PET_GOODIES === 'object' ? PET_GOODIES[group] : null;
    if (!set || !petHas(set, kind) || (set[kind].premium && !pet.goodies)) return null;
    return set[kind];
  };
  const TREAT_LINES = { cupcake: ['a cupcake!!', 'party time!'], fish: ['FISH!', 'my favourite!'] };
  const TOY_LINES = { frisbee: ['frisbee!!', 'I got it!'], yarn: ['yarn!', 'mine mine mine'] };

  function dropTreat(kind) {
    if (!goodie('treats', kind)) kind = 'cookie';
    const g = goodie('treats', kind);
    petSetMarkup(elTreat, (g && g.svg) || PET_GOODIES.treats.cookie.svg);          // our own constant artwork
    const spot = clearSpot(rand(0, maxX()));
    treat = { kind, x: (spot ?? rand(0, maxX())) + W / 2, y: window.innerHeight - 30, vy: 0 };
    last.treat = '';
    elTreat.hidden = false;
    if (state === 'sleep') say('…food?!');
    else if (TREAT_LINES[kind]) say(pick(TREAT_LINES[kind]));
  }

  function throwBall(kind) {
    if (!goodie('toys', kind)) kind = 'ball';
    const g = goodie('toys', kind);
    petSetMarkup(elBall, (g && g.svg) || PET_GOODIES.toys.ball.svg);
    ball = { kind, g: (g && g.gravity) || 1500, x: x + W / 2, y: 60, vx: rand(220, 420) * (Math.random() < 0.5 ? -1 : 1), vy: 520, kicks: 0, born: performance.now() };
    elBall.hidden = false;
    if (state === 'sleep') say(kind === 'ball' ? 'ball!!' : 'ooh!');
    else if (TOY_LINES[kind]) say(pick(TOY_LINES[kind]));
  }

  function endBall() {
    const kind = ball.kind;
    ball = null;
    elBall.hidden = true;
    loveUntil = performance.now() + 3000;
    say(pick(['that was fun!', 'again? again?', 'best. day.']));
    hearts(2);
    petAct('ballDone', kind).then((p) => { pet = p; updateFace(); });
  }

  // The pet digs up a little gift and leaves it beside itself; clicking it keeps it.
  // Earned treasures: doing something (reading to the end, playing music, staying up
  // late...) makes the pet dig up that thing's treasure, at most one of each per day.
  let pendingGift = null;
  function earn(kind) {
    if (!petHas(PET_TREASURES, kind) || !shown() || gem || pendingGift) return;
    if (pet.lastFound[kind] === new Date().toDateString()) return;
    pendingGift = kind;
  }

  function findTreasure(kind) {
    kind = kind || pick(Object.keys(PET_TREASURES).filter((k) => PET_TREASURES[k].how === 'dig'));
    const el = document.createElement('div');
    el.className = 'gem';
    el.title = 'A gift! Click to keep it';
    petSetMarkup(el, `<div class="gem-i">${PET_TREASURES[kind].svg}</div><div class="gem-tw">${ICONS.spark.svg}</div>`);
    el.querySelector('.gem-tw svg').style.color = '#f7c531';
    const gl = Math.max(4, Math.min(document.documentElement.clientWidth - 34, x + (dir > 0 ? W - 8 : -22)));
    const gt = window.innerHeight - 33;
    el.style.left = gl + 'px';
    el.style.top = gt + 'px';
    el.addEventListener('click', (e) => {
      if (!e.isTrusted || el.classList.contains('taken')) return;
      gem = null;
      // it slides to the pet's head, then the pet sparkles and gives a little squish
      el.style.setProperty('--fx', (x + (dir > 0 ? 62 : W - 62) - (gl + 15)) + 'px');
      el.style.setProperty('--fy', (floorTop() - y + 26 - (gt + 15)) + 'px');
      el.classList.add('taken');
      const done = () => el.remove();
      el.addEventListener('animationend', done);
      setTimeout(done, 700);
      setTimeout(() => { hearts(3, 'spark'); if (!calm.matches) oneShot('pat', 380); }, calm.matches ? 0 : 280);
      loveUntil = performance.now() + 3000;
      say(pick(['yay!', 'you like it!', 'I found it myself!']));
      petAct('treasure', kind).then((p) => { pet = p; updateFace(); });
    });
    root.appendChild(el);
    gem = el;
    setTimeout(() => { if (gem === el) { el.remove(); gem = null; } }, 45000);
  }

  // ---------- main loop ----------
  function chatter() {
    if (isNight && Math.random() < 0.3) return sayIdle(pick(['*yawn*', 'it\'s so late…', 'bedtime soon?']));
    const mood = petMood(pet);
    if (mood === 'hungry') return sayIdle(pick(['so hungry…', 'snack? please?', '*tummy rumbles*']));
    if (mood === 'sleepy') return sayIdle(pick(['*yawn*', 'sleepy…']));
    if (mood === 'sad') return sayIdle(pick(['play with me?', '…', 'pet me?']));
    if (Math.random() < 0.35) sayIdle(pick(['la la la', 'hi!', sound(), sound(), 'nice page']));
  }

  function update(dt, t) {
    kickCooldown -= dt;

    if (treat) {
      if (treat.y > 0) { treat.vy -= 1500 * dt; treat.y = Math.max(0, treat.y + treat.vy * dt); }
    }
    if (ball) {
      ball.vy -= ball.g * dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.y < 0) {
        ball.y = 0;
        ball.vy = Math.abs(ball.vy) > 90 ? -ball.vy * 0.6 : 0;
      }
      if (ball.y === 0) ball.vx *= Math.max(0, 1 - 1.4 * dt);
      const bw = window.innerWidth - 9;
      if (ball.x < 9) { ball.x = 9; ball.vx = Math.abs(ball.vx) * 0.8; }
      if (ball.x > bw) { ball.x = bw; ball.vx = -Math.abs(ball.vx) * 0.8; }
      if (ball.kicks >= 5 || t - ball.born > 25000) endBall();
    }

    switch (state) {
      case 'held':
        break;

      case 'fall':
        vy -= 1800 * dt;
        y += vy * dt;
        if (y <= 0) {
          y = 0;
          if (vy < -450) { vy = -vy * 0.35; oneShot('land', 240); }
          else { vy = 0; setState('idle', 900); oneShot('land', 340); say(pick(['wheee!', 'oof', 'again!'])); }
        }
        break;

      case 'idle':
        if (treat || ball) { setState('chase'); break; }
        if (t > stateUntil) {
          const still = t - mouseMovedAt;
          if (pet.energy < 20 || t - lastActivity > 120000) { setState('sleep'); sayIdle('z z z', 3000); }
          else if (!gem && (pendingGift || (t > nextGemAt && pet.happy > 40))) { setState('dig', 1700); sayIdle('*sniff sniff*', 1500); }
          else if (!calm.matches && !visited && still > 5000 && still < 60000 && mouse.x >= 0 && Math.abs(mouse.x - (x + W / 2)) > 90) {
            // you've paused somewhere: wander over and see what you're looking at
            visited = true;
            const spot = clearSpot(mouse.x - W / 2);
            if (spot !== null) { walkTarget = spot; walkSay = pick(['hi!', 'whatcha looking at?', '*sniff*']); setState('walk'); }
            else setState('idle', 2000);
          }
          else if (!calm.matches && Math.random() < (dancing ? 0.12 : 0.6)) {
            const spot = clearSpot(rand(0, maxX()));
            if (spot !== null) { walkTarget = spot; setState('walk'); } else setState('idle', 3000);
          }
          else { setState('idle', rand(1500, 4500)); chatter(); }
        }
        break;

      case 'walk': {
        if (treat || ball) { setState('chase'); break; }
        const d = walkTarget - x;
        if (Math.abs(d) < 3) { setState('idle', rand(2000, 5000)); if (walkSay) { sayIdle(walkSay); walkSay = ''; } break; }
        dir = Math.sign(d);
        // ease up to walking pace and slow down on the way in
        speed += (Math.min(pet.energy < 25 ? 32 : 55, Math.abs(d) * 4 + 10) - speed) * Math.min(1, dt * 7);
        x += dir * Math.min(Math.abs(d), speed * dt);
        break;
      }

      case 'chase': {
        let tx;
        if (treat) {
          tx = treat.x - W / 2;
          if (Math.abs(tx - x) < 8 && treat.y <= 0) {
            meal = treat.kind;
            treat = null; elTreat.hidden = true;
            setState('eat', 1600);
            break;
          }
        } else if (ball) {
          tx = ball.x - W / 2;
          if (Math.abs(tx - x) < 30 && ball.y < 30 && kickCooldown <= 0) {
            ball.vx = dir * rand(280, 520);
            ball.vy = rand(300, 560);
            ball.kicks++;
            kickCooldown = 0.5;
          }
        } else { setState('idle', 800); break; }
        const d = Math.max(0, Math.min(maxX(), tx)) - x;
        if (Math.abs(d) > 6) {
          dir = Math.sign(d);
          speed += (Math.min(175, Math.abs(d) * 6 + 20) - speed) * Math.min(1, dt * 7);
          x += dir * Math.min(Math.abs(d), speed * dt);
        }
        break;
      }

      case 'eat':
        if (t > stateUntil) {
          loveUntil = t + 3000;
          setState('idle', 1800);
          say(pick(meal === 'cookie' ? ['yum!', 'nom nom', 'more?'] : ['SO good', 'best treat ever', 'yum yum yum']));
          if (meal !== 'cookie') hearts(3);
          petAct('ate', meal).then((p) => { pet = p; updateFace(); });
        }
        break;

      case 'dig':
        if (t > stateUntil) {
          const earned = pendingGift;
          pendingGift = null;
          findTreasure(earned);
          if (!earned) nextGemAt = t + rand(300000, 600000);
          setState('idle', 2500);
          sayIdle(pick(['for you!', 'look what I found!', 'a present!']));
        }
        break;

      case 'sleep':
        if (treat || ball) { setState('chase'); break; }
        if (t - lastNap > 15000) {
          lastNap = t;
          petAct('nap').then((p) => {
            pet = p;
            if (state === 'sleep' && pet.energy >= 90 && t - lastActivity < 120000) { setState('idle', 1500); say('*streeetch*'); }
          });
        }
        break;
    }

    x = Math.max(0, Math.min(maxX(), x));
  }

  // Only touch the page when something actually changed: writing the same values every
  // frame still costs style and paint work in every open tab.
  const last = { pos: '', flip: 0, look: '', ball: '', treat: '', bsx: NaN, below: null };
  function render() {
    const top = floorTop() - y;
    const pos = `translate(${x.toFixed(1)}px, ${top.toFixed(1)}px)`;
    if (pos !== last.pos) { last.pos = pos; elPet.style.transform = pos; if (bubbleOn) placeBubble(top); }
    if (dir !== last.flip) { last.flip = dir; elFlip.style.transform = `scaleX(${dir})`; }
    elPet.classList.toggle('dancing', dancing && state === 'idle');
    elPet.classList.toggle('typing', state === 'idle' && performance.now() < typingUntil);
    elPet.classList.toggle('night', isNight);
    elPet.classList.toggle('loved', state !== 'sleep' && performance.now() < loveUntil);
    // eyes follow the cursor
    if (state !== 'sleep') {
      const dx = mouse.x - (x + W / 2), dy = mouse.y - (top + 26);
      const dist = Math.hypot(dx, dy) || 1;
      // only the pupils move; the drawing is mirrored when facing left, so mirror x too
      const k = dist < 500 ? 0.9 : 0;
      const look = `translate(${((dx / dist) * k * dir).toFixed(1)} ${((dy / dist) * k).toFixed(1)})`;
      if (look !== last.look) { last.look = look; for (const e of elEyes) e.setAttribute('transform', look); }
    }
    if (ball) elBall.style.transform = `translate(${ball.x - 9}px, ${window.innerHeight - 18 - ball.y}px) rotate(${ball.x * 4}deg)`;
    if (treat) {
      const t = `translate(${treat.x - 9}px, ${(window.innerHeight - 18 - treat.y).toFixed(1)}px) rotate(${calm.matches ? 0 : (treat.y * 0.25).toFixed(0)}deg)`;
      if (t !== last.treat) { last.treat = t; elTreat.style.transform = t; }
    }
  }

  let lastT = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    if (dead) return;
    if (shown()) { update(dt, t); render(); requestAnimationFrame(frame); }
    else setTimeout(() => requestAnimationFrame(frame), 1000);   // hidden: check back once a second
  }

  // blink now and then
  const blinkOnce = () => { elPet.classList.add('blink'); setTimeout(() => elPet.classList.remove('blink'), 130); };
  (function blinkLoop() {
    setTimeout(() => {
      if (dead) return;
      if (state !== 'sleep' && !document.hidden) {
        blinkOnce();
        if (Math.random() < 0.2) setTimeout(blinkOnce, 260);   // the odd double blink
      }
      blinkLoop();
    }, rand(2400, 5400));
  })();

  // sleepy z's drift up while it naps
  every(() => { if (state === 'sleep' && shown()) hearts(1, 'z'); }, 2600);

  // Every second and a half: if the pet is standing on something clickable, walk off it.
  // Where there is nowhere clear to go (a full-width bar), fade out and let clicks through.
  every(() => {
    if (!shown() || document.hidden || press || y > 0) return;
    const now = performance.now();
    const onControl = blockedAt(x);
    let ghost = false;
    if (onControl) {
      const spot = now < noClearUntil ? null : clearSpot(x);
      if (spot === null) { ghost = true; noClearUntil = now + 10000; }
      else if (state === 'idle') { walkTarget = spot; setState('walk'); }
      else if (state === 'sleep') ghost = true;
    }
    elPet.classList.toggle('ghost', ghost);
  }, 1500);

  // stop every loop while the tab is in the background
  document.addEventListener('visibilitychange', () => host.classList.toggle('paused', document.hidden));

  // ---------- interaction ----------
  let press = null, lastPetSave = 0;

  elPet.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    e.preventDefault();
    elPet.setPointerCapture(e.pointerId);
    press = { sx: e.clientX, sy: e.clientY, ox: e.clientX - x, oy: e.clientY - (floorTop() - y), moved: false };
  });

  elPet.addEventListener('pointermove', (e) => {
    if (!press || !e.isTrusted) return;
    if (!press.moved && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > 5) {
      press.moved = true;
      setState('held');
      say(pick(['whoa!', 'put me down!', 'wheee!']), 1200);
    }
    if (press.moved) {
      x = e.clientX - press.ox;
      y = Math.max(0, floorTop() - (e.clientY - press.oy));
    }
  });

  const release = (e) => {
    if (!press || !e.isTrusted) return;
    const wasDrag = press.moved;
    press = null;
    if (wasDrag) { vy = 0; setState('fall'); return; }
    // a click = a pat
    const now = performance.now();
    if (state === 'sleep') { setState('idle', 2000); say(pick(['mmh… hi', '*yawn* hello'])); }
    else say(pick(['hehe', 'hee hee', sound(), ':3']), 1200);
    hearts();
    oneShot('pat', 380);
    loveUntil = now + 2500;
    updateFace();
    if (now - lastPetSave > 800) {
      lastPetSave = now;
      petAct('pat').then((p) => { pet = p; });
    }
  };
  elPet.addEventListener('pointerup', release);
  elPet.addEventListener('pointercancel', release);

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    lastActivity = mouseMovedAt = performance.now();
    visited = false;
  }, { passive: true });

  // Typing buddy: trots over beside the field you're typing in and nods along.
  // It only notices that a key was pressed; it never reads or stores which one, and it
  // ignores password, payment and one-time-code fields completely.
  const SENSITIVE = /^(current-password|new-password|one-time-code|cc-.*)$/;
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const now = performance.now();
    lastActivity = now;
    const el = e.target;
    const editable = el && el.tagName && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
    if (!editable || !shown()) return;
    if (el.type === 'password' || SENSITIVE.test((el.getAttribute('autocomplete') || '').trim())) return;
    if (!e.key || e.key.length !== 1) return;
    if (now - typingUntil > 30000 && (state === 'idle' || state === 'walk')) {
      const r = el.getBoundingClientRect();
      const spot = clearSpot(r.left + r.width / 2 - W / 2);       // beside the field, never on it
      if (spot !== null) { walkTarget = spot; walkSay = pick(['whatcha writing?', 'ooh, typing!', 'tap tap tap']); setState('walk'); }
    }
    typingUntil = now + 1200;
    if (++keyCount % 150 === 0) { sayIdle(pick(["you're on a roll!", 'so fast!', 'go go go!'])); hearts(1, 'spark'); earn('pencil'); }
  }, { passive: true });

  // Fast scrolling bounces the pet off its feet; reaching the end of a long page gets a cheer.
  window.addEventListener('scroll', () => {
    const now = performance.now();
    lastActivity = now;
    const dy = Math.abs(window.scrollY - lastScrollY), dt = now - lastScrollT;
    lastScrollY = window.scrollY; lastScrollT = now;
    if (!shown()) return;
    if (!calm.matches && dt < 100 && dy / dt > 3.5 && y === 0 && (state === 'idle' || state === 'walk') && now - lastHop > 4000) {
      lastHop = now; vy = 430; y = 1;
      setState('fall');
      say(pick(['whoa!', 'hold on!', 'wheee!']), 1200);
    }
    const doc = document.documentElement;
    if (!saidEnd && doc.scrollHeight > window.innerHeight * 2.5 && window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
      saidEnd = true;
      sayIdle(pick(['the end!', 'we made it to the bottom!']));
      earn('bookmark');
    }
  }, { passive: true });

  // Dances when the page is playing sound.
  // Media events don't bubble, but they can be caught on the way down (capture), so the
  // pet hears about every player without scanning the page.
  const media = new Set(document.querySelectorAll('video, audio'));
  const audible = (m) => m.isConnected && !m.paused && !m.ended && !m.muted && m.volume > 0;
  function onMedia(e) {
    if (e && e.target instanceof HTMLMediaElement) media.add(e.target);
    for (const m of media) if (!m.isConnected) media.delete(m);
    const was = dancing;
    dancing = [...media].some(audible);
    if (dancing && !was && shown() && state !== 'sleep' && !document.hidden) { sayIdle(pick(['ooh, music!', 'I love this one!', 'la la la!'])); earn('note'); }
  }
  for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied']) document.addEventListener(type, onMedia, true);
  onMedia();
  every(() => { if (dancing && state === 'idle' && shown()) hearts(1, pick(['note', 'notes'])); }, 1100);

  // Stretch reminder after ~50 minutes of continuous browsing (tracked across tabs).
  async function checkBreak() {
    if (!shown() || document.hidden || performance.now() - lastActivity > 60000) return;
    const now = Date.now();
    const { petSession: old } = await ext.storage.local.get('petSession');
    const s = old && now - old.last < 5 * 60000 ? old : { start: now };
    s.last = now;
    if (now - s.start > 50 * 60000) {
      s.start = now;
      loveUntil = performance.now() + 4000;
      say('stretch break? we\'ve been at it a while.', 6000);
      earn('teacup');
    }
    await ext.storage.local.set({ petSession: s });
  }

  // ---------- wiring to storage and the popup ----------
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pet && changes.pet.newValue) {
      pet = normalizePet(changes.pet.newValue);
      applyAppearance();
    }
  });

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'pet:host') { sendResponse({ ok: true, host: location.hostname }); return; }
    if (!shown()) { sendResponse({ ok: false, reason: 'hidden' }); return; }
    const kind = typeof msg.kind === 'string' ? msg.kind : '';
    if (msg.type === 'pet:treat') dropTreat(kind);
    else if (msg.type === 'pet:ball') throwBall(kind);
    else { sendResponse({ ok: false }); return; }
    sendResponse({ ok: true });
  });

  // re-apply time decay so the mood stays current on long-lived pages
  every(() => {
    isNight = nightNow();
    if (isNight) earn('moon');
    checkBreak().catch(() => {});
    petLoad().then((p) => { pet = p; applyAppearance(); });     // also notices a snooze ending
  }, 30000);

  (async () => {
    pet = await petLoad();
    let away = Infinity;
    try {
      const { petSession: s } = await ext.storage.local.get('petSession');
      if (s && Number.isFinite(s.last)) away = Date.now() - s.last;
    } catch { /* first run */ }
    applyAppearance();
    (document.documentElement || document.body).appendChild(host);
    setState('idle', 1200);
    started = true;
    // Greets you once per sitting, not on every page; never says its name on a web page.
    if (away > 3 * 3600e3 && away !== Infinity) {
      setTimeout(() => { if (shown()) sayIdle("you're back! I saved you something", 3500); }, 700);
      earn('sun');                                   // a welcome-back present
    } else if (away > 10 * 60e3) {
      setTimeout(() => { if (shown()) sayIdle(pick(['hi!', sound()])); }, 700);
    } else if (isNight) {
      setTimeout(() => { if (shown()) sayIdle('*yawn* it\'s late…', 3500); }, 4500);
    }
    checkBreak().catch(() => {});
    requestAnimationFrame(frame);
  })();
})();
