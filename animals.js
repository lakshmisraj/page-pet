// Draws the animals and treasure icons on animals.html from the extension's own artwork.
(() => {
  const style = document.createElement('style');
  style.textContent = PET_SVG_CSS;
  document.head.appendChild(style);
  for (const fig of document.querySelectorAll('figure[data-skin]')) petSetMarkup(fig, petModel(fig.dataset.skin));
  for (const s of document.querySelectorAll('[data-t]')) petSetMarkup(s, PET_TREASURES[s.dataset.t].svg);
})();
