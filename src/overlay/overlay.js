'use strict';

const list = document.getElementById('list');

window.overlay.onState((people) => {
  list.textContent = '';
  for (const p of people) {
    const li = document.createElement('li');
    if (p.speaking) li.className = 'speaking';

    const av = document.createElement('div');
    av.className = 'av';
    av.style.setProperty('--hue', String(p.hue));
    av.textContent = (p.name || '?').charAt(0).toUpperCase();

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = p.name || '?';

    li.append(av, name);
    if (p.muted) {
      const m = document.createElement('span');
      m.className = 'mt';
      m.textContent = 'muted';
      li.append(m);
    }
    list.appendChild(li);
  }
});
