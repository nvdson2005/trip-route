/* Trip Route Mapper — paste a text route, see it on a map, record a video. */
'use strict';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCENT = '#e8452c';
const INK = '#1d2433';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const state = {
  stops: [],          // {id, query, label, lng, lat, candidates: [{label,lng,lat}], status}
  route: null,        // {coords, cum, total, stopFrac, distance, duration, bounds, straight}
  playing: false,
  recording: false,
  cancel: false,
};
let nextId = 1;
const overlay = { title: '', main: '', sub: '' };

/* ---------- text helpers ---------- */

function norm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Common Vietnamese abbreviations / unaccented names that geocoders get wrong.
const ALIASES = {
  'hcmc': 'Thành phố Hồ Chí Minh', 'hcm': 'Thành phố Hồ Chí Minh', 'tphcm': 'Thành phố Hồ Chí Minh',
  'tp hcm': 'Thành phố Hồ Chí Minh', 'sg': 'Thành phố Hồ Chí Minh', 'saigon': 'Thành phố Hồ Chí Minh',
  'sai gon': 'Thành phố Hồ Chí Minh', 'ho chi minh': 'Thành phố Hồ Chí Minh',
  'ho chi minh city': 'Thành phố Hồ Chí Minh', 'tp ho chi minh': 'Thành phố Hồ Chí Minh',
  'hn': 'Hà Nội', 'hanoi': 'Hà Nội', 'ha noi': 'Hà Nội',
  'vt': 'Vũng Tàu', 'vung tau': 'Vũng Tàu',
  'dalat': 'Đà Lạt', 'da lat': 'Đà Lạt',
  'danang': 'Đà Nẵng', 'da nang': 'Đà Nẵng',
  'nha trang': 'Nha Trang', 'phan thiet': 'Phan Thiết', 'mui ne': 'Mũi Né',
  'bao loc': 'Bảo Lộc', 'hue': 'Huế', 'hoi an': 'Hội An', 'sapa': 'Sa Pa', 'sa pa': 'Sa Pa',
  'phu quoc': 'Phú Quốc', 'can tho': 'Cần Thơ', 'quy nhon': 'Quy Nhơn', 'ha giang': 'Hà Giang',
  'buon ma thuot': 'Buôn Ma Thuột', 'bmt': 'Buôn Ma Thuột', 'pleiku': 'Pleiku',
  'hai phong': 'Hải Phòng', 'ha long': 'Hạ Long', 'ninh binh': 'Ninh Bình', 'vinh': 'Vinh',
};

function splitRoute(text) {
  // " - " separated text may contain hyphenated names ("Ba Ria-Vung Tau"), so only
  // split on bare hyphens when no spaced dash is present.
  const spaced = /\s[-–—]+\s/.test(text);
  const re = spaced
    ? /\s+[-–—]+\s+|\s*(?:->|→|⇒|=>|>|,|;|\||\n)\s*/
    : /\s*(?:->|→|⇒|=>|[-–—>]|,|;|\||\n)\s*/;
  return text.split(re).map((s) => s.trim()).filter(Boolean);
}

/* ---------- cache ---------- */

function cacheGet(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function cacheSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

/* ---------- geocoding ---------- */

let lastNominatim = 0;
async function nominatimSlot() {
  // Nominatim usage policy: max 1 request per second.
  const wait = lastNominatim + 1100 - Date.now();
  lastNominatim = Math.max(Date.now(), lastNominatim + 1100);
  if (wait > 0) await sleep(wait);
}

async function geocode(q, country) {
  const key = 'geo2:' + country + ':' + norm(q);
  const cached = cacheGet(key);
  if (cached && cached.length) return cached;
  const query = ALIASES[norm(q)] || q;
  let results = [];
  try {
    await nominatimSlot();
    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': 'vi,en' });
    if (country) u.searchParams.set('countrycodes', country);
    const r = await fetch(u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    results = (await r.json()).map((d) => ({ label: d.display_name, lng: +d.lon, lat: +d.lat }));
  } catch (e) { console.warn('Nominatim failed, trying Photon', e); }
  if (!results.length) {
    try {
      const u = new URL('https://photon.komoot.io/api/');
      u.search = new URLSearchParams({ q: query, limit: '5' });
      if (country === 'vn') u.searchParams.set('bbox', '102.1,8.2,109.6,23.4');
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      results = (await r.json()).features.map((f) => {
        const p = f.properties;
        return {
          label: [p.name, p.city, p.state, p.country].filter(Boolean).join(', '),
          lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
        };
      });
    } catch (e) { console.warn('Photon failed', e); }
  }
  if (results.length) cacheSet(key, results);
  return results;
}

async function reverseGeocode(lng, lat) {
  try {
    await nominatimSlot();
    const u = new URL('https://nominatim.openstreetmap.org/reverse');
    u.search = new URLSearchParams({ lat, lon: lng, format: 'jsonv2', zoom: '10', 'accept-language': 'vi,en' });
    const r = await fetch(u);
    const d = await r.json();
    return d.name || (d.display_name || '').split(',')[0] || null;
  } catch { return null; }
}

/* ---------- geometry ---------- */

function hav(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav(coords[i - 1], coords[i]));
  return cum;
}
function downsample(coords, max) {
  if (coords.length <= max) return coords;
  const step = Math.ceil(coords.length / max), out = [];
  for (let i = 0; i < coords.length; i += step) out.push(coords[i]);
  if (out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
}
function boundsOf(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  return b;
}
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/* ---------- map ---------- */

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [107.2, 11.2],
  zoom: 6.5,
  preserveDrawingBuffer: true, // needed to copy the canvas into the video
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

const EMPTY = { type: 'FeatureCollection', features: [] };
const lineFC = (coords) => ({ type: 'FeatureCollection', features: coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [] });
const pointFC = (c) => ({ type: 'FeatureCollection', features: c ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }] : [] });

map.on('load', () => {
  map.addSource('progress', { type: 'geojson', data: EMPTY });
  map.addSource('stops', { type: 'geojson', data: EMPTY });
  map.addSource('head', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'progress-casing', type: 'line', source: 'progress',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'progress-line', type: 'line', source: 'progress',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ACCENT, 'line-width': 5 } });
  map.addLayer({ id: 'stops-circle', type: 'circle', source: 'stops',
    filter: ['==', ['get', 'reached'], true],
    paint: { 'circle-radius': 8, 'circle-color': INK, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'stops-label', type: 'symbol', source: 'stops',
    filter: ['==', ['get', 'reached'], true],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 15,
      'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-allow-overlap': true, 'text-max-width': 12 },
    paint: { 'text-color': INK, 'text-halo-color': '#ffffff', 'text-halo-width': 2.2 } });
  map.addLayer({ id: 'head', type: 'circle', source: 'head',
    paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': ACCENT, 'circle-stroke-width': 4 } });
  setupDrag();
  loadFromUrl();
  refresh(false);
});

/* ---------- drag stops on the map ---------- */

function setupDrag() {
  let dragId = null;
  const canvas = map.getCanvasContainer();
  map.on('mouseenter', 'stops-circle', () => { if (!state.playing) canvas.style.cursor = 'grab'; });
  map.on('mouseleave', 'stops-circle', () => { canvas.style.cursor = ''; });
  const onMove = (e) => {
    const s = state.stops.find((x) => x.id === dragId);
    if (!s) return;
    s.lng = e.lngLat.lng; s.lat = e.lngLat.lat;
    updateStopsSource(1);
  };
  const onUp = () => {
    map.off('mousemove', onMove); map.off('touchmove', onMove);
    canvas.style.cursor = '';
    const s = state.stops.find((x) => x.id === dragId);
    dragId = null;
    if (s) { s.label = 'Moved on map'; s.candidates = []; refresh(); }
  };
  const onDown = (e) => {
    if (state.playing || (e.points && e.points.length !== 1)) return;
    e.preventDefault();
    dragId = e.features[0].properties.id;
    canvas.style.cursor = 'grabbing';
    map.on('mousemove', onMove); map.on('touchmove', onMove);
    map.once('mouseup', onUp); map.once('touchend', onUp);
  };
  map.on('mousedown', 'stops-circle', onDown);
  map.on('touchstart', 'stops-circle', onDown);

  map.on('click', async (e) => {
    if (state.playing || !$('#clickAdd').checked) return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ['stops-circle'] });
    if (hit.length) return;
    const s = { id: nextId++, query: '…', label: 'Added on map', lng: e.lngLat.lng, lat: e.lngLat.lat, candidates: [] };
    state.stops.push(s);
    refresh();
    const name = await reverseGeocode(s.lng, s.lat);
    s.query = name || `Point ${state.stops.indexOf(s) + 1}`;
    refresh(false);
  });
}

/* ---------- stops panel ---------- */

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderStops() {
  const ol = $('#stops');
  ol.innerHTML = '';
  state.stops.forEach((s, i) => {
    const li = document.createElement('li');
    if (s.lng == null) li.className = 'bad';
    const cands = s.candidates.length > 1
      ? `<select data-act="cand">${s.candidates.map((c, k) => `<option value="${k}" ${c.lng === s.lng && c.lat === s.lat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`
      : '';
    const sub = s.status === 'searching' ? 'Searching…' : s.lng == null ? 'Not found. Edit the name or click the map.' : s.label;
    li.innerHTML = `
      <button class="num" data-act="fly" title="Zoom to stop">${i + 1}</button>
      <div class="stop-body">
        <input type="text" data-act="name" value="${esc(s.query)}" aria-label="Stop ${i + 1} name">
        ${cands}
        <small title="${esc(sub)}">${esc(sub)}</small>
      </div>
      <div class="stop-actions">
        <button data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" title="Move down" ${i === state.stops.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="del" title="Remove">×</button>
      </div>`;
    li.dataset.id = s.id;
    ol.appendChild(li);
  });
  $('#stopsEmpty').hidden = state.stops.length > 0;
  $('#stopCount').textContent = state.stops.length ? `(${state.stops.length})` : '';
}

$('#stops').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || state.playing) return;
  const id = +btn.closest('li').dataset.id;
  const i = state.stops.findIndex((s) => s.id === id);
  const s = state.stops[i];
  switch (btn.dataset.act) {
    case 'fly': if (s.lng != null) map.flyTo({ center: [s.lng, s.lat], zoom: 11 }); return;
    case 'up': state.stops.splice(i - 1, 0, state.stops.splice(i, 1)[0]); break;
    case 'down': state.stops.splice(i + 1, 0, state.stops.splice(i, 1)[0]); break;
    case 'del': state.stops.splice(i, 1); break;
    default: return;
  }
  refresh();
});
$('#stops').addEventListener('change', async (e) => {
  const li = e.target.closest('li');
  const s = state.stops.find((x) => x.id === +li.dataset.id);
  if (!s) return;
  if (e.target.dataset.act === 'cand') {
    const c = s.candidates[+e.target.value];
    Object.assign(s, { lng: c.lng, lat: c.lat, label: c.label });
    refresh();
  } else if (e.target.dataset.act === 'name') {
    const q = e.target.value.trim();
    if (!q || q === s.query) return;
    s.query = q;
    await lookupStop(s);
    refresh();
  }
});

async function lookupStop(s) {
  s.status = 'searching';
  renderStops();
  const res = await geocode(s.query, $('#country').value);
  s.status = null;
  s.candidates = res;
  if (res.length) Object.assign(s, { lng: res[0].lng, lat: res[0].lat, label: res[0].label });
  else Object.assign(s, { lng: null, lat: null, label: '' });
}

$('#findBtn').addEventListener('click', async () => {
  const names = splitRoute($('#routeText').value);
  if (!names.length) { setStatus('Type a route first, e.g. “HCMC - Vung Tau - Phan Thiet”.'); return; }
  $('#findBtn').disabled = true;
  state.stops = names.map((q) => ({ id: nextId++, query: q, label: '', lng: null, lat: null, candidates: [], status: 'searching' }));
  state.route = null;
  renderStops();
  setStatus(`Looking up ${names.length} places…`);
  for (const s of state.stops) { await lookupStop(s); renderStops(); updateStopsSource(1); }
  const missing = state.stops.filter((s) => s.lng == null).length;
  setStatus(missing ? `${missing} place(s) not found. Fix the name or click the map to place them.` : 'Places found. Check each one, then preview or record.');
  $('#findBtn').disabled = false;
  await refresh();
  fitAll();
});

/* ---------- routing ---------- */

let routeToken = 0;
async function computeRoute() {
  const token = ++routeToken;
  const pts = state.stops.filter((s) => s.lng != null);
  if (pts.length < 2) { state.route = null; return; }
  const wantRoad = $('#mode').value === 'road';
  let coords = null, distance = null, duration = null, legDist = null, note = '';
  if (wantRoad) {
    $('#routeInfo').textContent = 'Finding roads…';
    try {
      const path = pts.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson`);
      const j = await r.json();
      if (j.code !== 'Ok') throw new Error(j.code);
      const rt = j.routes[0];
      coords = rt.geometry.coordinates; distance = rt.distance; duration = rt.duration;
      legDist = rt.legs.map((l) => l.distance);
    } catch (e) {
      console.warn('OSRM failed', e);
      note = 'Road routing failed (no road or service busy), so straight lines are shown.';
    }
  }
  if (token !== routeToken) return; // a newer request superseded this one
  if (!coords) {
    coords = [];
    legDist = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      for (let k = i === 1 ? 0 : 1; k <= 60; k++) {
        const t = k / 60;
        coords.push([a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t]);
      }
      legDist.push(hav([a.lng, a.lat], [b.lng, b.lat]));
    }
  }
  coords = downsample(coords, 3000);
  const cum = cumulative(coords);
  const total = cum[cum.length - 1] || 1;
  const legSum = legDist.reduce((a, b) => a + b, 0) || 1;
  const stopFrac = [0];
  legDist.forEach((d) => stopFrac.push(Math.min(1, stopFrac[stopFrac.length - 1] + d / legSum)));
  state.route = {
    coords, cum, total, stopFrac, names: pts.map((p) => p.query),
    distance: distance ?? legSum, duration, straight: !distance, bounds: boundsOf(coords),
  };
  const km = Math.round(state.route.distance / 1000);
  const time = duration ? ` · about ${Math.floor(duration / 3600)}h ${Math.round((duration % 3600) / 60)}m driving` : ' (straight-line distance)';
  $('#routeInfo').textContent = `${km.toLocaleString()} km${time}. ${note}`;
}

/* ---------- map state ---------- */

function updateStopsSource(frac) {
  const src = map.getSource('stops');
  if (!src) return;
  const pts = state.stops.filter((s) => s.lng != null);
  const fracs = state.route && state.route.stopFrac.length === pts.length ? state.route.stopFrac : pts.map(() => 0);
  src.setData({
    type: 'FeatureCollection',
    features: pts.map((s, i) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.query, reached: fracs[i] <= frac + 1e-9 },
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    })),
  });
}

function pointAt(frac) {
  const R = state.route;
  const d = frac * R.total;
  let lo = 0, hi = R.cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (R.cum[mid] <= d) lo = mid; else hi = mid; }
  const seg = R.cum[hi] - R.cum[lo] || 1;
  const t = Math.min(1, Math.max(0, (d - R.cum[lo]) / seg));
  const a = R.coords[lo], b = R.coords[hi];
  return { i: lo, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

function setProgress(frac, showHead) {
  const R = state.route;
  if (!R) { map.getSource('progress')?.setData(EMPTY); map.getSource('head')?.setData(EMPTY); updateStopsSource(1); return null; }
  const { i, point } = pointAt(frac);
  const line = R.coords.slice(0, i + 1);
  line.push(point);
  map.getSource('progress').setData(lineFC(line));
  map.getSource('head').setData(showHead ? pointFC(point) : EMPTY);
  updateStopsSource(frac);
  // overlay text
  let leg = 0;
  while (leg < R.stopFrac.length - 2 && frac >= R.stopFrac[leg + 1]) leg++;
  overlay.main = `${Math.round((frac * R.distance) / 1000).toLocaleString()} km`;
  overlay.sub = frac >= 1 ? `${R.names.length} stops` : `${R.names[leg]} → ${R.names[leg + 1]}`;
  drawPreviewOverlay();
  return point;
}

function autoTitle() {
  return $('#title').value.trim() || state.stops.filter((s) => s.lng != null).map((s) => s.query).join(' → ');
}

async function refresh(reroute = true) {
  renderStops();
  updateStopsSource(1);
  if (reroute) await computeRoute();
  overlay.title = autoTitle();
  if (!state.route) { overlay.main = ''; overlay.sub = ''; }
  setProgress(1, false);
  writeUrl();
  setUI();
}

function fitAll() {
  const pts = state.stops.filter((s) => s.lng != null).map((s) => [s.lng, s.lat]);
  const coords = state.route ? state.route.coords : pts;
  if (!coords.length) return;
  if (coords.length === 1) { map.flyTo({ center: coords[0], zoom: 10 }); return; }
  map.fitBounds(boundsOf(coords), { padding: framePadding(), duration: 800, maxZoom: 12 });
}

/* ---------- overlay (title + distance chip) ---------- */

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function drawOverlay(ctx, W, H) {
  const s = Math.min(W, H) / 720;
  const m = 26 * s;
  ctx.save();
  ctx.textBaseline = 'middle';
  if (overlay.title) {
    let fs = 32 * s;
    const maxW = W - m * 2 - 36 * s;
    ctx.font = `700 ${fs}px ${FONT}`;
    while (ctx.measureText(overlay.title).width > maxW && fs > 13 * s) { fs -= 1 * s; ctx.font = `700 ${fs}px ${FONT}`; }
    let text = overlay.title;
    while (ctx.measureText(text).width > maxW && text.length > 4) text = text.slice(0, -2);
    if (text !== overlay.title) text = text.slice(0, -1) + '…';
    const w = ctx.measureText(text).width + 36 * s, h = fs + 26 * s;
    ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 16 * s; ctx.shadowOffsetY = 4 * s;
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    roundRect(ctx, m, m, w, h, 12 * s); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = INK;
    ctx.fillText(text, m + 18 * s, m + h / 2);
  }
  if (overlay.main) {
    const f1 = 30 * s, f2 = 17 * s;
    ctx.font = `800 ${f1}px ${FONT}`;
    const w1 = ctx.measureText(overlay.main).width;
    ctx.font = `600 ${f2}px ${FONT}`;
    const w2 = Math.min(ctx.measureText(overlay.sub).width, W - m * 2 - 36 * s);
    const w = Math.max(w1, w2) + 36 * s, h = f1 + f2 + 34 * s;
    const y = H - m - h;
    ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 16 * s; ctx.shadowOffsetY = 4 * s;
    ctx.fillStyle = INK;
    roundRect(ctx, m, y, w, h, 12 * s); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = ACCENT;
    ctx.font = `800 ${f1}px ${FONT}`;
    ctx.fillText(overlay.main, m + 18 * s, y + 14 * s + f1 / 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${f2}px ${FONT}`;
    ctx.fillText(overlay.sub, m + 18 * s, y + 20 * s + f1 + f2 / 2, w - 36 * s);
  }
  ctx.restore();
}

function drawPreviewOverlay() {
  const c = $('#overlay');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  drawOverlay(ctx, c.width, c.height);
}

/* ---------- frame layout ---------- */

function aspectRatio() { const [a, b] = $('#aspect').value.split(':').map(Number); return a / b; }
function targetSize() {
  const q = +$('#quality').value, r = aspectRatio();
  const even = (n) => Math.round(n / 2) * 2;
  return r >= 1 ? [even(q * r), q] : [q, even(q / r)];
}
function layoutFrame() {
  const stage = $('#stage');
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const r = aspectRatio();
  let w = aw, h = aw / r;
  if (h > ah) { h = ah; w = ah * r; }
  const f = $('#frame');
  f.style.width = Math.floor(w) + 'px';
  f.style.height = Math.floor(h) + 'px';
  const c = $('#overlay');
  c.width = Math.floor(w * devicePixelRatio);
  c.height = Math.floor(h * devicePixelRatio);
  map.resize();
  drawPreviewOverlay();
}
function framePadding() {
  const f = $('#frame');
  const w = f.clientWidth, h = f.clientHeight;
  return { top: h * 0.2, bottom: h * 0.24, left: w * 0.12, right: w * 0.12 };
}
let resizeTimer;
window.addEventListener('resize', () => {
  if (state.recording || state.playing) return;
  layoutFrame();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitAll, 300);
});
$('#aspect').addEventListener('change', () => { layoutFrame(); fitAll(); });

/* ---------- animation ---------- */

function moveDone(fn) {
  return new Promise((res) => {
    const t = setTimeout(res, 4000);
    map.once('moveend', () => { clearTimeout(t); res(); });
    fn();
  });
}
function tilesReady(timeout = 5000) {
  return new Promise((res) => {
    if (map.loaded() && map.areTilesLoaded()) return res();
    const t = setTimeout(res, timeout);
    map.once('idle', () => { clearTimeout(t); res(); });
  });
}

async function play() {
  const R = state.route;
  if (!R || state.playing) return;
  state.playing = true; state.cancel = false; setUI();
  const durMs = +$('#duration').value * 1000;
  const follow = $('#camera').value === 'follow';
  const pad = framePadding();

  map.fitBounds(R.bounds, { padding: pad, duration: 0 });
  setProgress(0, true);
  await tilesReady();
  await sleep(900);
  const overviewZoom = map.getZoom();
  // Close enough to see roads, far enough to keep context.
  const followZoom = Math.min(Math.max(overviewZoom + 1.6, 7), 11.5);
  let center = R.coords[0];
  if (follow && !state.cancel) {
    await moveDone(() => map.easeTo({ center, zoom: followZoom, duration: 1400, padding: { top: 0, bottom: 0, left: 0, right: 0 } }));
  }

  if (!state.cancel) {
    await new Promise((res) => {
      const t0 = performance.now();
      const frame = (now) => {
        if (state.cancel) return res();
        const lin = Math.min(1, (now - t0) / durMs);
        const p = setProgress(easeInOut(lin), true);
        if (follow) {
          center = [center[0] + (p[0] - center[0]) * 0.2, center[1] + (p[1] - center[1]) * 0.2];
          map.jumpTo({ center });
        }
        if (lin < 1) requestAnimationFrame(frame); else res();
      };
      requestAnimationFrame(frame);
    });
  }

  if (!state.cancel) {
    map.getSource('head').setData(EMPTY);
    if (follow) await moveDone(() => map.fitBounds(R.bounds, { padding: pad, duration: 1600 }));
    await sleep(1800);
  }
  if (state.cancel) setProgress(1, false);
  state.playing = false;
  setUI();
}

/* ---------- recording ---------- */

function pickMime() {
  const opts = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function record() {
  if (!state.route || state.playing) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    setStatus('This browser cannot record video. Use Chrome, Edge, Firefox or Safari 14.1+.');
    return;
  }
  state.recording = true; setUI();
  const [tw, th] = targetSize();
  const frame = $('#frame');
  map.setPixelRatio(tw / frame.clientWidth); // render the map at video resolution
  setStatus(`Recording ${tw}×${th}… keep this tab visible until it finishes.`);

  const comp = document.createElement('canvas');
  comp.width = tw; comp.height = th;
  const ctx = comp.getContext('2d');
  const mc = map.getCanvas();
  let drawing = true;
  const draw = () => {
    if (!drawing) return;
    ctx.drawImage(mc, 0, 0, tw, th);
    drawOverlay(ctx, tw, th);
    requestAnimationFrame(draw);
  };
  draw();

  const mime = pickMime();
  const rec = new MediaRecorder(comp.captureStream(30), {
    mimeType: mime || undefined,
    videoBitsPerSecond: Math.round(tw * th * 30 * 0.12),
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  await play();
  await sleep(250);
  rec.stop();
  await stopped;
  drawing = false;
  map.setPixelRatio(devicePixelRatio);
  state.recording = false;
  setUI();

  if (state.cancel) { setStatus('Recording cancelled.'); return; }
  const type = rec.mimeType || mime || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type });
  const url = URL.createObjectURL(blob);
  const name = `trip-route-${new Date().toISOString().slice(0, 10)}.${ext}`;
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  $('#status').innerHTML = `Saved <a href="${url}" download="${name}">${name}</a> (${(blob.size / 1e6).toFixed(1)} MB).` +
    (ext === 'webm' ? ' WebM plays in browsers and VLC; convert to MP4 for some phones.' : '');
}

/* ---------- share link ---------- */

function writeUrl() {
  const pts = state.stops.filter((s) => s.lng != null);
  const p = new URLSearchParams();
  if (pts.length) p.set('r', pts.map((s) => `${s.query.replace(/[~|]/g, ' ')}~${s.lat.toFixed(5)}~${s.lng.toFixed(5)}`).join('|'));
  if ($('#mode').value !== 'road') p.set('m', $('#mode').value);
  if ($('#aspect').value !== '16:9') p.set('a', $('#aspect').value);
  if ($('#title').value.trim()) p.set('t', $('#title').value.trim());
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function loadFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('m')) $('#mode').value = p.get('m');
  if (p.get('a')) { $('#aspect').value = p.get('a'); layoutFrame(); }
  if (p.get('t')) $('#title').value = p.get('t');
  const r = p.get('r');
  if (!r) return;
  state.stops = r.split('|').map((part) => {
    const [q, lat, lng] = part.split('~');
    return { id: nextId++, query: q, label: 'From shared link', lat: +lat, lng: +lng, candidates: [] };
  }).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  $('#routeText').value = state.stops.map((s) => s.query).join(' - ');
  refresh().then(fitAll);
}

$('#shareBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); setStatus('Link copied.'); }
  catch { setStatus('Copy this page URL to share the route.'); }
});

/* ---------- UI wiring ---------- */

function setStatus(t) { $('#status').textContent = t; }
function setUI() {
  const busy = state.playing || state.recording;
  const ok = !!state.route;
  $('#playBtn').disabled = busy || !ok;
  $('#recBtn').disabled = busy || !ok;
  $('#stopBtn').hidden = !busy;
  $('#findBtn').disabled = busy;
  for (const id of ['#aspect', '#quality', '#mode', '#camera', '#duration']) $(id).disabled = busy;
}

$('#playBtn').addEventListener('click', () => { setStatus(''); play(); });
$('#recBtn').addEventListener('click', record);
$('#stopBtn').addEventListener('click', () => { state.cancel = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') state.cancel = true; });
$('#mode').addEventListener('change', () => refresh().then(fitAll));
$('#duration').addEventListener('input', () => { $('#durLabel').textContent = $('#duration').value + 's'; });
$('#title').addEventListener('input', () => { overlay.title = autoTitle(); drawPreviewOverlay(); writeUrl(); });
$('#routeText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#findBtn').click(); });

layoutFrame();
setUI();
