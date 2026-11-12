// Lets the real Page Pet run on this website. It stands in for the browser-extension
// APIs and keeps the demo pet in this tab's memory only: nothing is saved or sent.
(() => {
  const data = {};
  const listeners = [];
  let onMessage = null;
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  globalThis.browser = {
    storage: {
      local: {
        async get(k) { return { [k]: copy(data[k]) }; },
        async set(o) {
          const changes = {};
          for (const [k, v] of Object.entries(o)) { data[k] = copy(v); changes[k] = { newValue: copy(v) }; }
          listeners.forEach((f) => f(changes, 'local'));
        },
      },
      onChanged: { addListener(f) { listeners.push(f); } },
    },
    runtime: {
      id: 'page-pet-demo',
      async sendMessage(m) {
        if (m && m.type === 'pet:op' && petHas(PET_OPS, m.op)) {
          return { ok: true, pet: await changePet((p) => PET_OPS[m.op](p, m.arg)) };
        }
        return { ok: false };
      },
      onMessage: { addListener(f) { onMessage = f; } },
    },
  };
  // the page's buttons talk to the pet the way the extension's popup does
  globalThis.pagePetDemo = { tell: (msg) => new Promise((r) => (onMessage ? onMessage(msg, null, r) : r(null))) };
})();
