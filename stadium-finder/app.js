// Stadium Finder
// A few safety notes:
// - all text goes on the page with textContent, never innerHTML
// - anything from localStorage, the url or an uploaded file gets checked first
// - the only websites it talks to are Nominatim (find a place) and OSRM (drive times)
'use strict';
(function () {
  const DATA = window.STADIUM_DATA;
  const $ = (sel, root) => (root || document).querySelector(sel);

  if (!DATA || !Array.isArray(DATA.venues)) {
    $('#locStatus').textContent = 'Venue data failed to load. Try refreshing the page.';
    return;
  }

  // helpers

  // makes an html element. text is added with textContent so it is safe
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false || k === 'style') continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false || k === 'style') continue;
      if (k === 'text') e.textContent = v;
      else e.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) if (kid) e.append(kid);
    return e;
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const isNum = n => typeof n === 'number' && Number.isFinite(n);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked, skip it */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* skip */ } },
  };
  const KEY_VISITED = 'csf.visited.v1';
  const KEY_PREFS = 'csf.prefs.v1';

  const STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'Washington, DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', ON: 'Ontario', BC: 'British Columbia',
  };
  const stateName = st => STATE_NAMES[st] || st;

  // data

  const venues = DATA.venues;
  const levels = DATA.levels;
  const levelById = new Map(levels.map(l => [l.id, l]));
  const byId = new Map(venues.map(v => [v.id, v]));
  const ck = v => v.la + ',' + v.lo; // venues in the same town share one lookup

  // math

  const R_MI = 3958.8;
  const rad = d => (d * Math.PI) / 180;
  function haversine(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_MI * Math.asin(Math.sqrt(x));
  }
  function bearing(a, b) { // angle from north in radians
    const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
    return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  }
  function fmtTime(hr) {
    const total = Math.round(hr * 60), hh = Math.floor(total / 60), mm = total % 60;
    if (hh === 0) return mm + ' min';
    return mm ? hh + ' hr ' + mm + ' min' : hh + ' hr';
  }
  const fmtMi = mi => Math.round(mi).toLocaleString('en-US') + ' mi';
  const fmtLimit = () => (state.unit === 'miles' ? state.limit + ' miles' : state.limit + (state.limit === 1 ? ' hour' : ' hours'));

  // state

  const UNIT_CFG = {
    miles: { min: 10, max: 1000, step: 10, def: 150 },
    hours: { min: 0.5, max: 16, step: 0.5, def: 3 },
  };
  const SORTS = {
    time: (a, b) => a.hr - b.hr,
    distance: (a, b) => a.mi - b.mi,
    school: (a, b) => a.v.s.localeCompare(b.v.s),
    venue: (a, b) => a.v.v.localeCompare(b.v.v),
    conf: (a, b) => a.v.cf.localeCompare(b.v.cf) || a.hr - b.hr,
    state: (a, b) => a.v.st.localeCompare(b.v.st) || a.hr - b.hr,
  };

  const state = {
    origin: null,           // {lat, lon, label}
    unit: 'miles',
    limit: 150,
    levels: new Set(['fbs', 'fcs']),
    conf: '', st: '', q: '',
    sort: 'time', desc: false,
    hideVisited: false, group: false,
    view: 'list',
    theme: 'light',              // '', 'light' or 'dark'
    selected: null,         // radar selection
    pick: null,             // "pick one for me" result
  };
  const visited = new Set();

  // drive info for the current start: town key -> {mi, hr, src}
  let legs = new Map();
  let coverage = 0;         // how many miles out we already looked up
  let calcToken = 0;
  let busy = false;
  let usedEstimate = false;

  // saved data (validated)

  function validOrigin(o) {
    if (!o || typeof o !== 'object') return null;
    const { lat, lon } = o;
    if (!isNum(lat) || !isNum(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const label = typeof o.label === 'string' ? o.label.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : 'Custom location';
    return { lat, lon, label: label || 'Custom location' };
  }

  function loadVisited() {
    const raw = store.get(KEY_VISITED);
    if (!Array.isArray(raw)) return;
    for (const id of raw.slice(0, 2000)) if (typeof id === 'string' && byId.has(id)) visited.add(id);
  }
  const saveVisited = () => store.set(KEY_VISITED, [...visited]);

  function applyUnit(unit, limit) {
    const cfg = UNIT_CFG[unit];
    state.unit = unit;
    state.limit = clamp(isNum(limit) ? limit : cfg.def, cfg.min, cfg.max);
  }

  function loadPrefs() {
    const p = store.get(KEY_PREFS);
    if (!p || typeof p !== 'object') return;
    if (p.unit === 'miles' || p.unit === 'hours') applyUnit(p.unit, p.limit);
    if (Array.isArray(p.levels)) {
      const ok = p.levels.filter(l => levelById.has(l));
      if (ok.length) state.levels = new Set(ok);
    }
    if (typeof p.sort === 'string' && SORTS[p.sort]) state.sort = p.sort;
    state.desc = p.desc === true;
    state.hideVisited = p.hideVisited === true;
    state.group = p.group === true;
    if (p.theme === 'light' || p.theme === 'dark') state.theme = p.theme;
    const o = validOrigin(p.origin);
    if (o) state.origin = o;
  }
  function savePrefs() {
    store.set(KEY_PREFS, {
      unit: state.unit, limit: state.limit, levels: [...state.levels], sort: state.sort, desc: state.desc,
      hideVisited: state.hideVisited, group: state.group, theme: state.theme, origin: state.origin,
    });
  }

  // shared links look like #lat=30.27&lon=-97.74&n=Austin&u=miles&d=150&l=fbs,fcs
  function loadHash() {
    if (!location.hash || location.hash.length < 2) return;
    let p;
    try { p = new URLSearchParams(location.hash.slice(1)); } catch (e) { return; }
    const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
    const o = validOrigin({ lat, lon, label: p.get('n') || 'Shared location' });
    if (o) state.origin = o;
    const u = p.get('u');
    if (u === 'miles' || u === 'hours') applyUnit(u, parseFloat(p.get('d')));
    const l = (p.get('l') || '').split(',').filter(x => levelById.has(x));
    if (l.length) state.levels = new Set(l);
  }

  // networking

  async function fetchJson(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' }, credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  let lastGeocode = 0;
  async function geocode(query) {
    const wait = 1100 - (Date.now() - lastGeocode); // Nominatim only allows 1 request per second
    if (wait > 0) await sleep(wait);
    lastGeocode = Date.now();
    const url = 'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', countrycodes: 'us' });
    const data = await fetchJson(url, 10000);
    if (!Array.isArray(data) || !data.length) return null;
    const lat = Number(data[0].lat), lon = Number(data[0].lon);
    if (!isNum(lat) || !isNum(lon)) return null;
    return { lat: +lat.toFixed(3), lon: +lon.toFixed(3) };
  }

  // asks OSRM for the drive from the start to many towns, returns null if it fails
  async function osrmTable(origin, dests) {
    const coords = [origin, ...dests].map(c => c[1] + ',' + c[0]).join(';');
    const idx = dests.map((_, i) => i + 1).join(';');
    const url = 'https://router.project-osrm.org/table/v1/driving/' + coords +
      '?sources=0&destinations=' + idx + '&annotations=distance,duration';
    try {
      const d = await fetchJson(url, 20000);
      if (!d || d.code !== 'Ok' || !d.distances || !d.durations) return null;
      const dist = d.distances[0], dur = d.durations[0];
      if (!Array.isArray(dist) || dist.length !== dests.length) return null;
      return dist.map((m, i) => (isNum(m) && isNum(dur[i])) ? { mi: m / 1609.344, hr: dur[i] / 3600 } : null);
    } catch (e) { return null; }
  }

  const OSRM_CHUNK = 90;
  function neededRadius() { // how far out to look (straight line), bigger than the limit because roads curve
    const pad = state.unit === 'miles' ? state.limit : state.limit * 80;
    return Math.min(pad * 1.6 + 40, 6000);
  }

  async function ensureLegs() {
    if (!state.origin) return;
    const need = neededRadius();
    if (need <= coverage) { render(); return; }
    const token = ++calcToken;
    const origin = [state.origin.lat, state.origin.lon];
    const todo = new Map();
    for (const v of venues) {
      const k = ck(v);
      if (!legs.has(k) && !todo.has(k) && haversine(origin, [v.la, v.lo]) <= need) todo.set(k, [v.la, v.lo]);
    }
    const entries = [...todo.entries()];
    busy = true;
    setStatus(entries.length ? 'Getting drive times for ' + entries.length + ' towns...' : '');
    render();
    for (let i = 0; i < entries.length; i += OSRM_CHUNK) {
      if (token !== calcToken) return; // a newer search took over
      const chunk = entries.slice(i, i + OSRM_CHUNK);
      const res = await osrmTable(origin, chunk.map(e => e[1]));
      if (token !== calcToken) return;
      chunk.forEach(([k, pt], j) => {
        const leg = res && res[j];
        if (leg) legs.set(k, { mi: leg.mi, hr: leg.hr, src: 'driving' });
        else {
          const mi = haversine(origin, pt) * 1.25;
          legs.set(k, { mi, hr: mi / 55, src: 'estimate' });
          usedEstimate = true;
        }
      });
      if (i + OSRM_CHUNK < entries.length) await sleep(150);
    }
    if (token !== calcToken) return;
    coverage = need;
    busy = false;
    setStatus(usedEstimate
      ? 'Live drive times were unavailable for some towns, so those use straight-line distance +25% at 55 mph.'
      : '', usedEstimate);
    render();
  }

  function setOrigin(o) {
    state.origin = o;
    legs = new Map(); coverage = 0; usedEstimate = false; calcToken++;
    state.selected = null; state.pick = null;
    savePrefs();
    ensureLegs();
  }

  // view computing

  function computeView() {
    const q = state.q.trim().toLowerCase();
    const base = [];
    for (const v of venues) {
      if (!state.levels.has(v.lv)) continue;
      if (state.conf && v.cf !== state.conf) continue;
      if (state.st && v.st !== state.st) continue;
      if (q && !(v.s + ' ' + v.v + ' ' + v.c + ' ' + v.cf).toLowerCase().includes(q)) continue;
      if (state.hideVisited && visited.has(v.id)) continue;
      const leg = legs.get(ck(v));
      if (leg) base.push({ v, mi: leg.mi, hr: leg.hr, src: leg.src });
    }
    const metric = r => (state.unit === 'miles' ? r.mi : r.hr);
    const within = base.filter(r => metric(r) <= state.limit);
    const beyond = base.filter(r => metric(r) > state.limit).sort((a, b) => a.hr - b.hr);
    const cmp = SORTS[state.sort];
    within.sort(state.desc ? (a, b) => cmp(b, a) : cmp);
    return { within, honorable: beyond.slice(0, 5), metric };
  }

  // rendering

  function setStatus(msg, isError) {
    const el = $('#locStatus');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function mapsSearchUrl(v) {
    return 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query: v.v + ', ' + v.c + ', ' + v.st });
  }

  function rowEl(r) {
    const v = r.v, been = visited.has(v.id);
    const lv = levelById.get(v.lv);
    return h('li', { class: 'row' + (been ? ' is-visited' : ''), 'data-id': v.id },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' },
          h('span', { class: 'school', text: v.s }),
          h('span', { class: 'chip', text: lv ? lv.label.replace('*', '') : v.lv })),
        h('div', { class: 'row-sub' },
          h('span', { class: 'venue', text: v.v }),
          h('span', { text: v.c + ', ' + v.st }),
          h('span', { text: v.cf }))),
      h('div', { class: 'row-num' },
        h('strong', { text: fmtTime(r.hr) }),
        h('span', { text: fmtMi(r.mi) }),
        r.src === 'estimate' ? h('em', { text: ' (estimate)' }) : null),
      h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'been', 'data-act': 'been', 'aria-pressed': String(been), 'aria-label': (been ? 'Unmark ' : 'Mark ') + v.s + ' ' + v.v + ' as visited', text: been ? 'Been here' : 'Mark visited' }),
        h('a', { href: mapsSearchUrl(v), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open ' + v.v + ' in Google Maps', text: 'Map' })));
  }

  function emptyBox(title, text) {
    return h('div', { class: 'empty' }, h('strong', { text: title }), h('span', { text }));
  }

  function renderSummary(view) {
    const box = clear($('#summary'));
    if (!state.origin) return;
    const w = view.within;
    box.append(h('h2', { text: busy && !w.length ? 'Working out drive times...' :
      w.length + (w.length === 1 ? ' venue' : ' venues') + ' within ' + fmtLimit() + ' of ' + state.origin.label }));
    if (!w.length) return;

    const states = new Set(w.map(r => r.v.st)), confs = new Set(w.map(r => r.v.cf));
    const beenN = w.filter(r => visited.has(r.v.id)).length;
    box.append(h('dl', { class: 'stats' },
      h('div', null, h('dd', { text: w.length }), h('dt', { text: 'venues' })),
      h('div', null, h('dd', { text: states.size }), h('dt', { text: states.size === 1 ? 'state' : 'states' })),
      h('div', null, h('dd', { text: confs.size }), h('dt', { text: confs.size === 1 ? 'conference' : 'conferences' })),
      h('div', null, h('dd', { text: beenN + ' of ' + w.length }), h('dt', { text: 'visited' }))));
    box.append(h('div', { class: 'bar', 'aria-hidden': 'true' }, (() => {
      const i = h('i'); i.style.width = Math.round((beenN / w.length) * 100) + '%'; return i;
    })()));

    const byHr = [...w].sort((a, b) => a.hr - b.hr);
    const closest = byHr[0], farthest = byHr[byHr.length - 1];
    const avg = w.reduce((t, r) => t + r.hr, 0) / w.length;
    const facts = h('ul', { class: 'facts' },
      h('li', null, 'Closest: ', h('b', { text: closest.v.s }), ' (' + fmtTime(closest.hr) + ', ' + fmtMi(closest.mi) + ')'),
      h('li', null, 'Farthest in range: ', h('b', { text: farthest.v.s }), ' (' + fmtTime(farthest.hr) + ', ' + fmtMi(farthest.mi) + ')'),
      h('li', null, 'Average drive: ', h('b', { text: fmtTime(avg) })));
    if (w.length >= 2) {
      const cLat = w.reduce((t, r) => t + r.v.la, 0) / w.length, cLon = w.reduce((t, r) => t + r.v.lo, 0) / w.length;
      const mid = w.reduce((best, r) => (haversine([cLat, cLon], [r.v.la, r.v.lo]) < haversine([cLat, cLon], [best.v.la, best.v.lo]) ? r : best), w[0]);
      facts.append(h('li', null, 'Most central: ', h('b', { text: mid.v.s }), ' (' + mid.v.c + ', ' + mid.v.st + ')'));
    }
    box.append(facts);
  }

  function groupedByLevel(rows) {
    const out = [];
    for (const l of levels) {
      const sub = rows.filter(r => r.v.lv === l.id);
      if (sub.length) out.push([l, sub]);
    }
    return out;
  }

  function honorableBlock(view) {
    if (!view.honorable.length) return null;
    return h('div', null,
      h('h3', { class: 'subhead', text: 'Just outside your limit' }),
      h('p', { class: 'note', text: 'The closest venues that missed the cutoff.' }),
      h('ul', { class: 'rows' }, view.honorable.map(r => rowEl(r))));
  }

  function renderList(view) {
    const p = clear($('#panel-list'));
    if (state.pick) {
      const r = view.within.find(x => x.v.id === state.pick);
      if (r) p.append(h('div', { class: 'pick' },
        h('p', null, 'How about ', h('b', { text: r.v.s + ' - ' + r.v.v }), ', ' + fmtTime(r.hr) + ' away?'),
        h('ul', { class: 'rows' }, rowEl(r)),
        h('p', null, h('button', { type: 'button', class: 'ghost', 'data-act': 'pickagain', text: 'Pick again' }))));
    }
    if (!view.within.length) {
      p.append(emptyBox('Nothing in range', 'Try a longer distance, more levels, or clear a filter.'));
    } else if (state.group && state.levels.size > 1) {
      for (const [l, rows] of groupedByLevel(view.within)) {
        p.append(h('div', { class: 'group-head' }, h('span', { text: l.label.replace('*', '') }), h('small', { text: rows.length + ' in range' })),
          h('ul', { class: 'rows' }, rows.map(r => rowEl(r))));
      }
    } else {
      p.append(h('ul', { class: 'rows' }, view.within.map(r => rowEl(r))));
    }
    p.append(honorableBlock(view));
  }

  function renderStates(view) {
    const p = clear($('#panel-state'));
    if (!view.within.length) { p.append(emptyBox('Nothing in range', 'Try a longer distance or clear a filter.')); return; }
    const groups = new Map();
    for (const r of view.within) { if (!groups.has(r.v.st)) groups.set(r.v.st, []); groups.get(r.v.st).push(r); }
    const order = [...groups.entries()].map(([st, rows]) => [st, rows.sort((a, b) => a.hr - b.hr)])
      .sort((a, b) => a[1][0].hr - b[1][0].hr);
    for (const [st, rows] of order) {
      p.append(h('div', { class: 'group-head' }, h('span', { text: stateName(st) }), h('small', { text: rows.length + (rows.length === 1 ? ' venue' : ' venues') })),
        h('ul', { class: 'rows' }, rows.map(r => rowEl(r))));
    }
  }

  // radar: a map centered on the starting point so direction and distance from the center are true
  function shapePath(lv, r) {
    const poly = pts => 'M' + pts.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('L') + 'Z';
    switch (lv) {
      case 'fcs': return poly([[-r, -r], [r, -r], [r, r], [-r, r]]);
      case 'baseball': return poly([[0, -r - 2], [r + 2, 0], [0, r + 2], [-r - 2, 0]]);
      case 'basketball': return poly([[0, -r - 1], [r + 2, r], [-r - 2, r]]);
      case 'mlb': return poly([[-r - 2, -r], [r + 2, -r], [0, r + 2]]);
      case 'milb': return poly([0, 1, 2, 3, 4, 5].map(i => [(r + 1) * Math.cos(i * Math.PI / 3), (r + 1) * Math.sin(i * Math.PI / 3)]));
      default: return 'M' + -r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0Z';
    }
  }

  // gives [east, north] in miles from the center
  function project(lat, lon, lat0, lon0) {
    const p = rad(lat), p0 = rad(lat0), dl = rad(lon - lon0);
    const cosc = clamp(Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl), -1, 1);
    const c = Math.acos(cosc), sinc = Math.sin(c);
    const k = sinc < 1e-9 ? 1 : c / sinc;
    return [R_MI * k * Math.cos(p) * Math.sin(dl), R_MI * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl))];
  }

  // turns lists of lon/lat into an svg path, skips shapes that are off screen
  function mapPath(shapes, close, o, C, scale, reach) {
    let d = '';
    for (const flat of shapes) {
      let seg = '', minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < flat.length; i += 2) {
        const pt = project(flat[i + 1], flat[i], o[0], o[1]);
        const x = C + pt[0] * scale, y = C - pt[1] * scale;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        seg += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      if (maxX < C - reach || minX > C + reach || maxY < C - reach || minY > C + reach) continue;
      d += seg + (close ? 'Z' : '');
    }
    return d;
  }

  function niceStep(radius) {
    const steps = [5, 10, 25, 50, 100, 200, 250, 500, 1000];
    return steps.find(s2 => s2 >= radius / 4) || 1000;
  }

  function renderRadar(view) {
    const p = clear($('#panel-radar'));
    if (!state.origin) return;
    const W = 640, C = W / 2, ROUT = C - 14, RMAX = ROUT - 10;
    const origin = [state.origin.lat, state.origin.lon];
    const dist = r => haversine(origin, [r.v.la, r.v.lo]);
    const farthest = view.within.reduce((m, r) => Math.max(m, dist(r)), 0);
    const radiusMi = Math.max(15, farthest ? farthest * 1.12 : (state.unit === 'miles' ? state.limit : state.limit * 50));
    const scale = RMAX / radiusMi;

    const clipId = 'radarClip';
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + W, class: 'radar', role: 'img',
      'aria-label': 'Map of venues around ' + state.origin.label + '. Distances shown are straight-line miles from the center.' });
    svg.append(s('defs', null, s('clipPath', { id: clipId }, s('circle', { cx: C, cy: C, r: ROUT }))));
    svg.append(s('circle', { cx: C, cy: C, r: ROUT, class: 'disc' }));

    const md = window.MAP_DATA;
    if (md) {
      svg.append(s('g', { 'clip-path': 'url(#' + clipId + ')' },
        s('path', { d: mapPath(md.land, true, origin, C, scale, ROUT), class: 'map-land' }),
        s('path', { d: mapPath(md.borders, false, origin, C, scale, ROUT), class: 'map-border' })));
    }

    const step = niceStep(radiusMi);
    for (let mi = step; mi * scale <= RMAX + 1; mi += step) {
      svg.append(s('circle', { cx: C, cy: C, r: mi * scale, class: 'ring' }),
        s('text', { x: C + 4, y: C - mi * scale - 4, text: mi + ' mi' }));
    }
    svg.append(s('circle', { cx: C, cy: C, r: ROUT, class: 'edge' }),
      s('line', { x1: C, y1: C - ROUT, x2: C, y2: C + ROUT, class: 'axis' }), s('line', { x1: C - ROUT, y1: C, x2: C + ROUT, y2: C, class: 'axis' }),
      s('text', { x: C - 4, y: 12, text: 'N' }), s('text', { x: W - 12, y: C - 6, text: 'E' }),
      s('text', { x: C - 4, y: W - 3, text: 'S' }), s('text', { x: 3, y: C - 6, text: 'W' }));

    const seen = new Map();
    const plot = [...view.within.map(r => [r, false]), ...view.honorable.map(r => [r, true])];
    const placed = [];
    plot.forEach(([r, far]) => {
      const pt = project(r.v.la, r.v.lo, origin[0], origin[1]);
      const k = ck(r.v), n = seen.get(k) || 0; seen.set(k, n + 1);
      const x = C + pt[0] * scale + (n % 2 ? -1 : 1) * Math.ceil(n / 2) * 9, y = C - pt[1] * scale;
      if (Math.hypot(x - C, y - C) > RMAX + 6) return;
      placed.push({ r, x, y, n });
      const cls = 'dot' + (visited.has(r.v.id) ? ' visited' : '') + (far ? ' far' : '') + (state.selected === r.v.id ? ' sel' : '');
      svg.append(s('g', { class: cls, transform: 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')', tabindex: 0, role: 'button', 'data-id': r.v.id,
        'aria-label': r.v.s + ', ' + r.v.v + ', ' + fmtTime(r.hr) + (far ? ', just outside your limit' : '') },
        s('title', { text: r.v.s + ' - ' + fmtTime(r.hr) }),
        s('path', { d: shapePath(r.v.lv, 6), class: 'shape' })));
    });
    const taken = [];
    placed.filter(q => q.n === 0 && !view.honorable.includes(q.r)).sort((a, b) => a.r.hr - b.r.hr).forEach(q => {
      if (taken.length >= 10) return;
      const lx = q.x + 10, ly = q.y - 8;
      if (taken.some(t2 => Math.abs(t2[0] - lx) < 70 && Math.abs(t2[1] - ly) < 13)) return; // skip labels that would overlap
      taken.push([lx, ly]);
      svg.append(s('text', { x: lx.toFixed(1), y: ly.toFixed(1), class: 'lbl', text: q.r.v.c }));
    });
    svg.append(s('circle', { cx: C, cy: C, r: 5, class: 'home' }));

    const legend = h('div', { class: 'legend' });
    for (const l of levels) {
      if (!state.levels.has(l.id)) continue;
      legend.append(h('span', null, s('svg', { width: 14, height: 14, viewBox: '-8 -8 16 16', 'aria-hidden': 'true' }, s('path', { d: shapePath(l.id, 6), class: 'shape' })), l.label.replace('*', '')));
    }
    legend.append(h('span', { text: 'Red outline = visited. Faded = just outside your limit.' }));

    p.append(h('div', { class: 'radar-wrap' }, svg, legend));
    p.append(h('p', { class: 'note', text: 'Centered on your starting point, with north up. Rings show straight-line miles; your limit is measured by driving, so a few venues can sit slightly inside or outside the rings. Select a dot for details.' }));
    const sel = state.selected && plot.find(([r]) => r.v.id === state.selected);
    if (sel) p.append(h('ul', { class: 'rows' }, rowEl(sel[0])));
  }

  function renderEmptyStart() {
    $('#summary').replaceChildren();
    for (const id of ['list', 'state', 'radar']) clear($('#panel-' + id));
    $('#panel-' + state.view).append(emptyBox('Where are you starting from?', 'Type a city or town above, or use your location, and the venues in range will show up here.'));
  }

  function render() {
    $('#visitedBtn').textContent = 'Manage my visited list (' + visited.size + ')';
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.view === state.view ? 'true' : 'false');
    for (const id of ['list', 'state', 'radar']) $('#panel-' + id).hidden = id !== state.view;

    if (!state.origin) { renderEmptyStart(); return; }
    const view = computeView();
    renderSummary(view);
    for (const id of ['list', 'state', 'radar']) if (id !== state.view) clear($('#panel-' + id));
    if (busy && !view.within.length && !view.honorable.length) {
      clear($('#panel-' + state.view)).append(emptyBox('Getting drive times...', 'This usually takes a few seconds.'));
      return;
    }
    if (state.view === 'list') renderList(view);
    else if (state.view === 'state') renderStates(view);
    else renderRadar(view);
  }

  // controls

  function buildLevels() {
    const box = clear($('#levelList'));
    for (const l of levels) {
      const n = venues.filter(v => v.lv === l.id).length;
      const cb = h('input', { type: 'checkbox', value: l.id, checked: state.levels.has(l.id) });
      cb.addEventListener('change', () => {
        if (cb.checked) state.levels.add(l.id); else state.levels.delete(l.id);
        if (!state.levels.size) { state.levels.add(l.id); cb.checked = true; } // always keep one level on
        refreshSelects(); savePrefs(); render();
      });
      box.append(h('label', { class: 'lv-' + l.id }, cb, h('span', { class: 'lvdot' }), h('span', { text: l.label }), h('span', { class: 'n', text: n })));
    }
    $('#levelNote').textContent = '*Basketball covers the major conferences and the Big East, not every Division I team.';
  }

  function refreshSelects() {
    const pool = venues.filter(v => state.levels.has(v.lv));
    const confs = [...new Set(pool.map(v => v.cf))].sort((a, b) => a.localeCompare(b));
    const sts = [...new Set(pool.map(v => v.st))].sort((a, b) => stateName(a).localeCompare(stateName(b)));
    if (state.conf && !confs.includes(state.conf)) state.conf = '';
    if (state.st && !sts.includes(state.st)) state.st = '';
    const cs = clear($('#confSel')), ss = clear($('#stateSel'));
    cs.append(h('option', { value: '', text: 'All conferences' }));
    ss.append(h('option', { value: '', text: 'All states' }));
    for (const c of confs) cs.append(h('option', { value: c, text: c }));
    for (const st of sts) ss.append(h('option', { value: st, text: stateName(st) }));
    cs.value = state.conf; ss.value = state.st;
  }

  function syncLimitControls() {
    const cfg = UNIT_CFG[state.unit];
    for (const id of ['#limitRange', '#limitNum']) {
      const el = $(id);
      el.min = cfg.min; el.max = cfg.max; el.step = cfg.step; el.value = state.limit;
    }
    $('#limitUnit').textContent = state.unit;
    for (const r of document.querySelectorAll('input[name="unit"]')) r.checked = r.value === state.unit;
  }

  function syncControls() {
    syncLimitControls();
    $('#sortSel').value = state.sort;
    $('#hideVisited').checked = state.hideVisited;
    $('#groupLevels').checked = state.group;
    updateDirBtn();
    if (state.origin) $('#locInput').value = state.origin.label;
  }
  function updateDirBtn() {
    const b = $('#dirBtn');
    b.textContent = state.desc ? 'Z-A' : 'A-Z';
    b.setAttribute('aria-label', 'Sort direction: ' + (state.desc ? 'descending' : 'ascending'));
  }

  function isDark() { return state.theme ? state.theme === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function applyTheme() {
    if (state.theme) document.documentElement.setAttribute('data-theme', state.theme);
    else document.documentElement.removeAttribute('data-theme');
    $('#themeBtn').textContent = isDark() ? 'Light mode' : 'Dark mode';
  }

  let toastTimer;
  function toast(msg, undo) {
    const t = clear($('#toast'));
    t.hidden = false;
    t.append(h('span', { text: msg }));
    if (undo) t.append(h('button', { type: 'button', text: 'Undo', onclick: () => { undo(); t.hidden = true; } }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  function toggleVisited(id, silent) {
    const v = byId.get(id); if (!v) return;
    const had = visited.has(id);
    if (had) visited.delete(id); else visited.add(id);
    saveVisited(); render();
    if ($('#visitedDialog').open) renderVisitedDialog();
    if (!silent) toast((had ? 'Removed ' : 'Marked ') + v.s + ' (' + v.v + ')' + (had ? ' from' : ' as') + ' visited.', () => toggleVisited(id, true));
  }

  function pickRandom() {
    const view = computeView();
    const pool = view.within.filter(r => !visited.has(r.v.id));
    if (!pool.length) { toast(view.within.length ? 'You\'ve been to everything in range.' : 'Nothing in range to pick from.'); return; }
    state.pick = pool[Math.floor(Math.random() * pool.length)].v.id;
    state.view = 'list'; render();
    $('#panel-list').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // exports

  function csvCell(x) {
    let t = String(x == null ? '' : x);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stops spreadsheets from running it as a formula
    return '"' + t.replace(/"/g, '""') + '"';
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv(byState) {
    if (!state.origin) { toast('Search for a starting point first.'); return; }
    let rows = computeView().within;
    if (!rows.length) { toast('Nothing to export yet.'); return; }
    if (byState) {
      const first = new Map();
      for (const r of [...rows].sort((a, b) => a.hr - b.hr)) if (!first.has(r.v.st)) first.set(r.v.st, r.hr);
      rows = [...rows].sort((a, b) => first.get(a.v.st) - first.get(b.v.st) || a.v.st.localeCompare(b.v.st) || a.hr - b.hr);
    }
    const head = ['Level', 'Team / school', 'City', 'State', 'Conference', 'Venue', 'Miles', 'Hours', 'Visited'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([levelById.get(r.v.lv).label.replace('*', ''), r.v.s, r.v.c, r.v.st, r.v.cf, r.v.v,
        r.mi.toFixed(1), r.hr.toFixed(2), visited.has(r.v.id) ? 'yes' : 'no'].map(csvCell).join(','));
    }
    download(byState ? 'stadiums-by-state.csv' : 'stadiums.csv', lines.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }

  async function copyLink() {
    if (!state.origin) { toast('Search for a starting point first.'); return; }
    const p = new URLSearchParams({ lat: state.origin.lat, lon: state.origin.lon, n: state.origin.label, u: state.unit, d: state.limit, l: [...state.levels].join(',') });
    const url = location.origin + location.pathname + '#' + p.toString();
    try { await navigator.clipboard.writeText(url); toast('Link copied. It includes your starting point.'); }
    catch (e) { history.replaceState(null, '', '#' + p.toString()); toast('Copy the link from your address bar.'); }
  }

  // visited dialog

  function renderVisitedDialog() {
    const list = clear($('#visitedList'));
    const items = [...visited].map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.s.localeCompare(b.s));
    if (!items.length) list.append(h('li', null, h('span', { class: 'hint', text: 'Nothing yet. Add venues above or mark them from the results.' })));
    for (const v of items) {
      list.append(h('li', null,
        h('span', null, v.s + ' - ' + v.v, h('small', { text: v.c + ', ' + v.st + ' - ' + levelById.get(v.lv).label.replace('*', '') })),
        h('button', { type: 'button', 'data-remove': v.id, 'aria-label': 'Remove ' + v.s + ' ' + v.v, text: 'Remove' })));
    }
    const parts = levels.map(l => {
      const total = venues.filter(v => v.lv === l.id).length;
      const got = venues.filter(v => v.lv === l.id && visited.has(v.id)).length;
      return l.label.replace('*', '') + ' ' + got + '/' + total;
    });
    $('#visitedProgress').textContent = visited.size + ' visited. ' + parts.join(', ') + '.';
    renderAddResults();
  }

  function renderAddResults() {
    const box = clear($('#addResults'));
    const q = $('#addSearch').value.trim().toLowerCase();
    if (q.length < 2) return;
    const hits = venues.filter(v => (v.s + ' ' + v.v + ' ' + v.c).toLowerCase().includes(q)).slice(0, 25);
    if (!hits.length) { box.append(h('li', null, h('span', { class: 'hint', text: 'No matches.' }))); return; }
    for (const v of hits) {
      const has = visited.has(v.id);
      box.append(h('li', null,
        h('span', null, v.s + ' - ' + v.v, h('small', { text: v.c + ', ' + v.st + ' - ' + levelById.get(v.lv).label.replace('*', '') })),
        h('button', { type: 'button', 'data-add': v.id, disabled: has, text: has ? 'Added' : 'Mark visited' })));
    }
  }

  function importVisited(file) {
    if (!file) return;
    if (file.size > 200000) { toast('That file is too large to be a backup.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(String(reader.result)); } catch (e) { toast('That file isn\'t valid JSON.'); return; }
      const arr = Array.isArray(data) ? data : data && Array.isArray(data.visited) ? data.visited : null;
      if (!arr) { toast('That doesn\'t look like a visited-list backup.'); return; }
      let added = 0, skipped = 0;
      for (const id of arr.slice(0, 2000)) {
        if (typeof id === 'string' && byId.has(id)) { if (!visited.has(id)) { visited.add(id); added++; } } else skipped++;
      }
      saveVisited(); render(); renderVisitedDialog();
      toast('Added ' + added + ' venue' + (added === 1 ? '' : 's') + (skipped ? ', ignored ' + skipped + ' unknown' : '') + '.');
    };
    reader.readAsText(file);
  }

  // wiring it up

  async function searchPlace(text) {
    const q = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100);
    if (q.length < 2) { setStatus('Enter a city or town.', true); return; }
    const btn = $('#locBtn');
    btn.disabled = true; setStatus('Looking up "' + q + '"...');
    try {
      const pt = await geocode(q);
      if (!pt) { setStatus('Couldn\'t find that place. Try adding the state, like "Austin, TX".', true); return; }
      setStatus('');
      setOrigin({ lat: pt.lat, lon: pt.lon, label: q });
    } catch (e) {
      setStatus('The place lookup service isn\'t responding. Wait a moment and try again.', true);
    } finally { btn.disabled = false; }
  }

  function useMyLocation() {
    if (!navigator.geolocation) { setStatus('Your browser can\'t share a location.', true); return; }
    setStatus('Waiting for your browser to share a location...');
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = +pos.coords.latitude.toFixed(2), lon = +pos.coords.longitude.toFixed(2); // rounded on purpose for privacy
      $('#locInput').value = 'My location';
      setStatus('');
      setOrigin({ lat, lon, label: 'My location' });
    }, () => setStatus('Location wasn\'t shared. You can type a city instead.', true), { timeout: 10000, maximumAge: 600000 });
  }

  function wire() {
    $('#locForm').addEventListener('submit', e => { e.preventDefault(); searchPlace($('#locInput').value); });
    $('#geoBtn').addEventListener('click', useMyLocation);

    for (const r of document.querySelectorAll('input[name="unit"]')) {
      r.addEventListener('change', () => { if (r.checked) { applyUnit(r.value); syncLimitControls(); savePrefs(); ensureLegs(); } });
    }
    const onLimit = debounce(() => { savePrefs(); ensureLegs(); }, 350);
    const setLimit = val => {
      const cfg = UNIT_CFG[state.unit];
      const n = parseFloat(val);
      if (!isNum(n)) return;
      state.limit = clamp(n, cfg.min, cfg.max);
      render(); onLimit();
    };
    $('#limitRange').addEventListener('input', e => { $('#limitNum').value = e.target.value; setLimit(e.target.value); });
    $('#limitNum').addEventListener('input', e => { $('#limitRange').value = e.target.value; setLimit(e.target.value); });

    const onQ = debounce(() => render(), 150);
    $('#qInput').addEventListener('input', e => { state.q = e.target.value.slice(0, 60); onQ(); });
    $('#confSel').addEventListener('change', e => { state.conf = e.target.value; render(); });
    $('#stateSel').addEventListener('change', e => { state.st = e.target.value; render(); });
    $('#sortSel').addEventListener('change', e => { if (SORTS[e.target.value]) { state.sort = e.target.value; savePrefs(); render(); } });
    $('#dirBtn').addEventListener('click', () => { state.desc = !state.desc; updateDirBtn(); savePrefs(); render(); });
    $('#hideVisited').addEventListener('change', e => { state.hideVisited = e.target.checked; savePrefs(); render(); });
    $('#groupLevels').addEventListener('change', e => { state.group = e.target.checked; savePrefs(); render(); });
    $('#resetBtn').addEventListener('click', () => {
      state.conf = ''; state.st = ''; state.q = ''; state.sort = 'time'; state.desc = false;
      state.hideVisited = false; state.group = false; state.levels = new Set(['fbs', 'fcs']);
      applyUnit('miles'); $('#qInput').value = '';
      buildLevels(); refreshSelects(); syncControls(); savePrefs(); ensureLegs();
    });

    for (const b of document.querySelectorAll('.tabs button')) {
      b.addEventListener('click', () => { state.view = b.dataset.view; render(); });
    }
    $('#pickBtn').addEventListener('click', pickRandom);
    $('#exportFull').addEventListener('click', () => exportCsv(false));
    $('#exportState').addEventListener('click', () => exportCsv(true));
    $('#copyLink').addEventListener('click', copyLink);
    $('#themeBtn').addEventListener('click', () => {
      state.theme = isDark() ? 'light' : 'dark'; applyTheme(); savePrefs();
    });

    // one click handler for all the buttons in the results
    $('.results').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const row = btn.closest('[data-id]');
        const id = row && row.dataset.id;
        switch (btn.dataset.act) {
          case 'been': if (id) toggleVisited(id); break;
          case 'pickagain': pickRandom(); break;
        }
        return;
      }
      const dot = e.target.closest('.dot');
      if (dot && dot.dataset.id) { state.selected = state.selected === dot.dataset.id ? null : dot.dataset.id; render(); }
    });
    $('.results').addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('dot')) {
        e.preventDefault(); state.selected = e.target.dataset.id; render();
        const again = document.querySelector('.dot[data-id="' + CSS.escape(state.selected) + '"]'); if (again) again.focus();
      }
    });

    // visited dialog
    const dlg = $('#visitedDialog');
    $('#visitedBtn').addEventListener('click', () => { renderVisitedDialog(); dlg.showModal(); });
    $('#visitedClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    $('#addSearch').addEventListener('input', debounce(renderAddResults, 120));
    dlg.addEventListener('click', e => {
      const add = e.target.closest('[data-add]'), rem = e.target.closest('[data-remove]');
      if (add && !visited.has(add.dataset.add) && byId.has(add.dataset.add)) toggleVisited(add.dataset.add, true);
      if (rem && visited.has(rem.dataset.remove)) toggleVisited(rem.dataset.remove, true);
    });
    $('#visitedExport').addEventListener('click', () => {
      download('my-visited-venues.json', JSON.stringify({ app: 'stadium-finder', version: 1, visited: [...visited] }, null, 2), 'application/json');
    });
    $('#visitedImport').addEventListener('change', e => { importVisited(e.target.files[0]); e.target.value = ''; });
    $('#visitedClear').addEventListener('click', () => {
      if (visited.size && confirm('Clear all ' + visited.size + ' visited venues?')) { visited.clear(); saveVisited(); render(); renderVisitedDialog(); }
    });
    $('#forgetAll').addEventListener('click', () => {
      if (confirm('Erase your visited list, saved location and settings from this browser?')) {
        store.del(KEY_VISITED); store.del(KEY_PREFS); visited.clear();
        state.origin = null; legs = new Map(); coverage = 0; calcToken++; busy = false;
        $('#locInput').value = ''; render(); renderVisitedDialog(); toast('Everything has been erased from this browser.');
      }
    });
  }

  // init

  loadVisited();
  loadPrefs();
  loadHash();
  applyTheme();
  buildLevels();
  refreshSelects();
  syncControls();
  wire();
  render();
  if (state.origin) ensureLegs();
})();
