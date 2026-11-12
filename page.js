// Draws the website's animals, treasures and goodies from the extension's own artwork,
// and wires the "Try it" buttons to the demo pet walking on this page.
(() => {
  const $ = (id) => document.getElementById(id);
  const style = document.createElement('style');
  style.textContent = PET_SVG_CSS;
  document.head.appendChild(style);

  petSetMarkup($('hero-pet'), petModel('cat'));

  for (const [k, s] of Object.entries(PET_SKINS)) {
    const fig = document.createElement('figure');
    petSetMarkup(fig, petModel(k));
    const cap = document.createElement('figcaption');
    cap.textContent = s.name;
    if (s.premium) { const t = document.createElement('small'); t.textContent = 'Goodies pack'; cap.append(t); }
    fig.append(cap);
    $('zoo').append(fig);
  }

  for (const t of Object.values(PET_TREASURES)) {
    const span = document.createElement('span');
    span.title = t.name;
    petSetMarkup(span, t.svg);
    $('book').append(span);
  }

  const goods = [...Object.values(PET_GOODIES.treats), ...Object.values(PET_GOODIES.toys)].filter((g) => g.premium);
  for (const g of goods) { const s = document.createElement('span'); s.title = g.name; petSetMarkup(s, g.icon); $('goods').append(s); }
  for (const [k, o] of Object.entries(PET_OUTFITS)) { const s = document.createElement('span'); s.title = o.name; petSetMarkup(s, petOutfitIcon(k)); $('goods').append(s); }

  // demo: everything unlocked so visitors can try the goodies too
  changePet((p) => { p.goodies = true; p.chatter = 'chatty'; });

  const chip = (label, iconMarkup, premium, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    if (iconMarkup) petSetMarkup(b, iconMarkup);
    b.append(label);
    if (premium) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Goodies'; b.append(t); }
    b.onclick = onClick;
    return b;
  };
  for (const [k, g] of Object.entries(PET_GOODIES.treats)) {
    $('try-treats').append(chip(g.name, g.icon, g.premium, () => pagePetDemo.tell({ type: 'pet:treat', kind: k })), ' ');
  }
  for (const [k, g] of Object.entries(PET_GOODIES.toys)) {
    $('try-toys').append(chip(g.name, g.icon, g.premium, () => pagePetDemo.tell({ type: 'pet:ball', kind: k })), ' ');
  }
  const animalChips = [];
  for (const [k, s] of Object.entries(PET_SKINS)) {
    const b = chip(s.name, '', s.premium, async () => {
      await browser.runtime.sendMessage({ type: 'pet:op', op: 'skin', arg: k });
      animalChips.forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    });
    b.setAttribute('aria-pressed', String(k === 'cat'));
    animalChips.push(b);
    $('try-animals').append(b, ' ');
  }
})();
