/**
 * map.js — World map rendering: D3 Natural Earth + Orthographic Globe + Canvas FX
 *
 * Dual-canvas design:
 *   #map-bg  (bgCanvas) — persistent globe background, only redrawn when rotation changes
 *   #map-canvas (canvas) — overlay: arcs, heatmap, stars, effects — cleared every frame
 * This avoids cross-canvas drawImage() on the hot path.
 */

window.AzimuthMap = (() => {
  const { GEO } = window.AZIMUTH_DATA;

  let proj, svgGeoPath;
  let bgCanvas, bgCtx, _bgCgp;   // persistent globe bg
  let canvas, ctx;                // overlay: cleared every frame
  let mapW, mapH;
  let arcs       = [];
  let particles  = [];
  let pulseRings = [];
  let showArcs   = true;
  let showHeat   = true;
  let paused     = false;
  let globeMode  = false;
  let globeRot   = [0, -25, 0];
  let autoRotate = false;
  let isDragging = false;
  let dragStart  = null;
  let autoRotTimer = null;
  let rafId, lastFrame = 0;
  let worldData = null;
  let stars     = null;
  let _graticule    = null;
  let _lastGlobeRot = [Infinity, Infinity, Infinity];
  let _heatOff      = null;
  let _heatOffCtx   = null;
  let _lastHeatTs   = 0;
  let _heatDirty    = false;   // set true to force heatmap rebuild on next draw

  const MAX_ARCS = 50;
  const NS = 'http://www.w3.org/2000/svg';

  /* ── Projection factory ─────────────────────────────────────── */
  function makeProj() {
    if (globeMode) {
      return d3.geoOrthographic()
        .scale(Math.min(mapW, mapH) / 1.9)
        .translate([mapW / 2, mapH / 2])
        .rotate(globeRot)
        .clipAngle(90);
    }
    return d3.geoNaturalEarth1()
      .scale(mapW / 5.0)
      .translate([mapW / 2, mapH / 2]);
  }

  /* ── Init ───────────────────────────────────────────────────── */
  async function init() {
    const container = document.getElementById('map-container');
    mapW = container.clientWidth;
    mapH = container.clientHeight;

    bgCanvas        = document.getElementById('map-bg');
    bgCanvas.width  = mapW;
    bgCanvas.height = mapH;
    bgCtx = bgCanvas.getContext('2d');

    canvas        = document.getElementById('map-canvas');
    canvas.width  = mapW;
    canvas.height = mapH;
    ctx = canvas.getContext('2d');

    proj       = makeProj();
    svgGeoPath = d3.geoPath(proj);
    _bgCgp     = d3.geoPath(proj, bgCtx);

    initStars();
    await loadWorldMap();
    bindTooltip();
    bindGlobeDrag();

    window.addEventListener('resize', onResize);
    rafId = requestAnimationFrame(frame);
  }

  /* ── World data ─────────────────────────────────────────────── */
  async function loadWorldMap() {
    try {
      const res   = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
      const world = await res.json();
      worldData = {
        countries: topojson.feature(world, world.objects.countries),
        borders:   topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
      };
      _graticule = d3.geoGraticule()();
      renderSVGMap();
    } catch (e) {
      console.error('Map load failed:', e);
    }
  }

  /* ── SVG flat map ───────────────────────────────────────────── */
  function renderSVGMap() {
    const svg = document.getElementById('world-svg');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${mapW} ${mapH}`);

    if (globeMode || !worldData) { svg.style.display = 'none'; return; }
    svg.style.display = '';

    const { countries, borders } = worldData;

    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('width', mapW); rect.setAttribute('height', mapH);
    rect.setAttribute('fill', '#030c18');
    svg.appendChild(rect);

    const gratPath = document.createElementNS(NS, 'path');
    gratPath.setAttribute('d', svgGeoPath(d3.geoGraticule()()));
    gratPath.setAttribute('class', 'graticule');
    svg.appendChild(gratPath);

    const cG = document.createElementNS(NS, 'g');
    countries.features.forEach(f => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', svgGeoPath(f));
      p.setAttribute('class', 'land');
      p.setAttribute('data-id', f.id);
      cG.appendChild(p);
    });
    svg.appendChild(cG);

    const bPath = document.createElementNS(NS, 'path');
    bPath.setAttribute('d', svgGeoPath(borders));
    bPath.setAttribute('fill', 'none');
    bPath.setAttribute('stroke', '#1a3a5a');
    bPath.setAttribute('stroke-width', '0.35');
    svg.appendChild(bPath);

    Object.entries(GEO).forEach(([name, [lon, lat]]) => {
      const pt = proj([lon, lat]);
      if (!pt) return;
      const [x, y] = pt;
      if (x < 4 || x > mapW - 4 || y < 4 || y > mapH - 4) return;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '1.8');
      dot.setAttribute('class', 'city-dot'); dot.setAttribute('data-country', name);
      svg.appendChild(dot);
    });
  }

  /* ── Globe drag ─────────────────────────────────────────────── */
  function bindGlobeDrag() {
    const container = document.getElementById('map-container');

    function startDrag(x, y) {
      if (!globeMode) return;
      isDragging = true;
      dragStart  = { x, y, rot: [...globeRot] };
      clearTimeout(autoRotTimer);
      autoRotate = false;
    }
    function moveDrag(x, y) {
      if (!isDragging || !globeMode) return;
      globeRot[0] = dragStart.rot[0] + (x - dragStart.x) * 0.4;
      globeRot[1] = Math.max(-90, Math.min(90, dragStart.rot[1] - (y - dragStart.y) * 0.4));
      proj.rotate(globeRot);
    }
    function endDrag() {
      if (!isDragging) return;
      isDragging = false;
      autoRotTimer = setTimeout(() => { if (globeMode) autoRotate = true; }, 4000);
    }

    container.addEventListener('mousedown', e => startDrag(e.clientX, e.clientY));
    document.addEventListener('mousemove',  e => moveDrag(e.clientX, e.clientY));
    document.addEventListener('mouseup',    endDrag);
    container.addEventListener('touchstart', e => startDrag(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    document.addEventListener('touchmove',   e => moveDrag(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    document.addEventListener('touchend',    endDrag);
  }

  /* ── Tooltip ────────────────────────────────────────────────── */
  function bindTooltip() {
    const container = document.getElementById('map-container');
    const tt        = document.getElementById('tooltip');

    container.addEventListener('mousemove', e => {
      if (globeMode) { tt.style.display = 'none'; return; }
      const r  = container.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;

      let found = null;
      for (const [name, coords] of Object.entries(GEO)) {
        const pt = proj(coords);
        if (!pt) continue;
        if (Math.hypot(pt[0] - mx, pt[1] - my) < 14) { found = name; break; }
      }

      if (found) {
        const s = window.AzimuthFeed.getCountryStats(found);
        document.getElementById('tt-country').textContent = found;
        document.getElementById('tt-out').textContent     = s.out;
        document.getElementById('tt-in').textContent      = s.in;
        document.getElementById('tt-threat').textContent  = s.topThreat || '—';
        tt.style.display = 'block';
        tt.style.left    = Math.min(mx + 14, mapW - 200) + 'px';
        tt.style.top     = Math.max(my - 50, 6) + 'px';
      } else {
        tt.style.display = 'none';
      }
    });
    container.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
  }

  /* ── Arc management ─────────────────────────────────────────── */
  function addArc(attack) {
    const srcGeo = GEO[attack.src];
    const tgtGeo = GEO[attack.tgt];
    if (!srcGeo || !tgtGeo) return;

    const srcPt = proj(srcGeo);
    const tgtPt = proj(tgtGeo);

    if (arcs.length >= MAX_ARCS) arcs.shift();
    arcs.push({
      srcName: attack.src, tgtName: attack.tgt,
      srcGeo, tgtGeo,
      x1: srcPt ? srcPt[0] : 0, y1: srcPt ? srcPt[1] : 0,
      x2: tgtPt ? tgtPt[0] : 0, y2: tgtPt ? tgtPt[1] : 0,
      color: attack.color, progress: 0,
      speed: 0.006 + Math.random() * 0.007,
      born: Date.now(), ttl: 4500 + Math.random() * 3000,
      impacted: false,
    });

    const dot = document.querySelector(`.city-dot[data-country="${attack.src}"]`);
    if (dot) { dot.classList.add('hot'); setTimeout(() => dot.classList.remove('hot'), 2200); }
  }

  function addPulseRing(x, y, color) {
    pulseRings.push({ x, y, color, born: Date.now(), ttl: 750 });
  }

  /* ── Stars ─────────────────────────────────────────────────── */
  function initStars() {
    stars = Array.from({ length: 80 }, () => ({
      x: Math.random(), y: Math.random(),
      r: Math.random() * 1.1 + 0.2,
      baseA: Math.random() * 0.55 + 0.15,
      twinkle: Math.random() * 0.04 + 0.008,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  function drawStarfield() {
    ctx.fillStyle   = '#ffffff';
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    stars.forEach(s => {
      const x = s.x * mapW, y = s.y * mapH;
      ctx.moveTo(x + s.r, y);
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
    });
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ── Main draw loop ─────────────────────────────────────────── */
  function frame(ts) {
    if (ts - lastFrame > (globeMode ? 50 : 16)) {
      ctx.clearRect(0, 0, mapW, mapH);   // overlay only — bgCanvas persists

      if (globeMode) {
        if (autoRotate && !paused && !isDragging) {
          globeRot[0] += 0.07;
          proj.rotate(globeRot);
        }

        drawStarfield();
        drawGlobeBg();   // updates bgCanvas only when rotation changes enough

        // Atmosphere glow — two arcs, no shadowBlur
        const sc = proj.scale();
        ctx.beginPath();
        ctx.arc(mapW / 2, mapH / 2, sc + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 180, 255, 0.07)';
        ctx.lineWidth   = 12;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(mapW / 2, mapH / 2, sc, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.28)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // City dots — two batched passes (fill, then stroke)
        const visPts = [];
        Object.values(GEO).forEach(([lon, lat]) => {
          const pt = proj([lon, lat]);
          if (pt) visPts.push(pt);
        });
        ctx.fillStyle = 'rgba(0, 212, 255, 0.22)';
        ctx.beginPath();
        visPts.forEach(([x, y]) => { ctx.moveTo(x + 1.8, y); ctx.arc(x, y, 1.8, 0, Math.PI * 2); });
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        visPts.forEach(([x, y]) => { ctx.moveTo(x + 1.8, y); ctx.arc(x, y, 1.8, 0, Math.PI * 2); });
        ctx.stroke();
      }

      if (showHeat) drawHeat();
      if (showArcs) drawArcs();
      drawPulseRings();
      drawParticles();

      lastFrame = ts;
    }
    rafId = requestAnimationFrame(frame);
  }

  /* ── Globe background (persistent canvas) ───────────────────── */
  function drawGlobeBg() {
    if (!worldData) return;
    const rotDelta = Math.abs(globeRot[0] - _lastGlobeRot[0]) +
                     Math.abs(globeRot[1] - _lastGlobeRot[1]);
    if (rotDelta < 1.5 && _lastGlobeRot[0] !== Infinity) return;

    const { countries, borders } = worldData;
    bgCtx.clearRect(0, 0, mapW, mapH);

    // Ocean sphere
    bgCtx.beginPath();
    _bgCgp({ type: 'Sphere' });
    const sg = bgCtx.createRadialGradient(
      mapW / 2 - proj.scale() * 0.14, mapH / 2 - proj.scale() * 0.18, 0,
      mapW / 2, mapH / 2, proj.scale()
    );
    sg.addColorStop(0,    '#0d2a4a');
    sg.addColorStop(0.55, '#041020');
    sg.addColorStop(1,    '#020810');
    bgCtx.fillStyle = sg;
    bgCtx.fill();

    // Graticule — use cached object
    bgCtx.beginPath();
    _bgCgp(_graticule);
    bgCtx.strokeStyle = 'rgba(0, 50, 100, 0.55)';
    bgCtx.lineWidth   = 0.35;
    bgCtx.stroke();

    // Countries — single batched fill (was 200 individual fills)
    bgCtx.beginPath();
    countries.features.forEach(f => _bgCgp(f));
    bgCtx.fillStyle = '#0c1e32';
    bgCtx.fill();

    // Borders — one stroke via topology mesh
    bgCtx.beginPath();
    _bgCgp(borders);
    bgCtx.strokeStyle = '#183650';
    bgCtx.lineWidth   = 0.4;
    bgCtx.stroke();

    _lastGlobeRot = [...globeRot];
    _heatDirty    = true;   // globe moved, invalidate heatmap cache
  }

  /* ── Heatmap (offscreen cache, blit to overlay) ──────────────── */
  function drawHeat() {
    const now   = performance.now();
    const stale = _heatDirty || (now - _lastHeatTs > 600);

    if (_heatOff && !stale) {
      ctx.drawImage(_heatOff, 0, 0);
      return;
    }

    if (!_heatOff || _heatOff.width !== mapW || _heatOff.height !== mapH) {
      _heatOff    = document.createElement('canvas');
      _heatOff.width  = mapW;
      _heatOff.height = mapH;
      _heatOffCtx = _heatOff.getContext('2d');
    }
    const hc = _heatOffCtx;
    hc.clearRect(0, 0, mapW, mapH);

    function blob(country, count, r, g, b) {
      if (!GEO[country]) return;
      const pt = proj(GEO[country]);
      if (!pt) return;
      const [x, y] = pt;
      const radius = Math.min(52, 10 + count * 2.4);
      const grad   = hc.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0,   `rgba(${r},${g},${b},0.34)`);
      grad.addColorStop(0.4, `rgba(${r},${g},${b},0.12)`);
      grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      hc.beginPath();
      hc.arc(x, y, radius, 0, Math.PI * 2);
      hc.fillStyle = grad;
      hc.fill();
    }

    const am = window.AzimuthFeed.getAttackerMap();
    const tm = window.AzimuthFeed.getTargetMap();
    Object.entries(am).forEach(([c, n]) => blob(c, n, 255, 51, 85));
    Object.entries(tm).forEach(([c, n]) => blob(c, n, 0, 180, 255));

    ctx.drawImage(_heatOff, 0, 0);
    _lastHeatTs = now;
    _heatDirty  = false;
  }

  /* ── Arc drawing ─────────────────────────────────────────────── */
  function drawArcs() {
    const now = Date.now();
    arcs = arcs.filter(a => (now - a.born) < a.ttl + 900);

    arcs.forEach(arc => {
      if (!paused) arc.progress = Math.min(1, arc.progress + arc.speed);

      if (globeMode) {
        const sp = proj(arc.srcGeo);
        const tp = proj(arc.tgtGeo);
        if (!sp || !tp) return;
        arc.x1 = sp[0]; arc.y1 = sp[1];
        arc.x2 = tp[0]; arc.y2 = tp[1];
      }

      const age  = now - arc.born;
      const fade = age > arc.ttl ? 1 - (age - arc.ttl) / 900 : 1;
      if (fade <= 0) return;
      drawTacticalArc(arc, fade);
    });
  }

  function drawTacticalArc(arc, fade) {
    const { x1, y1, x2, y2, color, progress } = arc;
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist < 3) return;

    const cx = (x1 + x2) / 2;
    const cy = Math.min(y1, y2) - dist * 0.24 - 16;

    // Fewer points in globe mode — less CPU per arc
    const STEPS  = globeMode ? 24 : 40;
    const nSteps = Math.round(progress * STEPS);
    const pts    = [];
    for (let i = 0; i <= nSteps; i++) {
      const t = i / STEPS;
      pts.push([
        (1-t)*(1-t)*x1 + 2*(1-t)*t*cx + t*t*x2,
        (1-t)*(1-t)*y1 + 2*(1-t)*t*cy + t*t*y2,
      ]);
    }
    if (pts.length < 2) return;

    const [ex, ey] = pts[pts.length - 1];
    ctx.save();
    ctx.globalAlpha = fade;

    // Bloom layer — skip in globe mode (saves 33% of stroke calls)
    if (!globeMode) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = color + '18';
      ctx.lineWidth   = 8;
      ctx.stroke();
    }

    // Glow
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color + '3a';
    ctx.lineWidth   = globeMode ? 2 : 3;
    ctx.stroke();

    // Core line — skip gradient in globe mode
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (globeMode) {
      ctx.strokeStyle = color + 'cc';
    } else {
      const lg = ctx.createLinearGradient(x1, y1, ex, ey);
      lg.addColorStop(0,   color + '14');
      lg.addColorStop(0.4, color + '55');
      lg.addColorStop(0.8, color + 'bb');
      lg.addColorStop(1,   color + 'ff');
      ctx.strokeStyle = lg;
    }
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Moving head — concentric alpha circles, no shadowBlur
    if (progress < 1) {
      ctx.beginPath(); ctx.arc(ex, ey, 8,   0, Math.PI * 2);
      ctx.fillStyle = color + '1f'; ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, 5,   0, Math.PI * 2);
      ctx.fillStyle = color + '40'; ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, 2,   0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    }

    if (progress >= 0.97 && !arc.impacted) {
      arc.impacted = true;
      addPulseRing(x2, y2, arc.color);
    }

    ctx.restore();
  }

  /* ── Particles ───────────────────────────────────────────────── */
  function drawParticles() {
    const now = Date.now();
    particles = particles.filter(p => (now - p.born) < p.ttl);
    particles.forEach(p => {
      const life = 1 - (now - p.born) / p.ttl;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.93; p.vy *= 0.93;
      ctx.save();
      ctx.globalAlpha = life * 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * life, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.restore();
    });
  }

  /* ── Pulse rings ─────────────────────────────────────────────── */
  function drawPulseRings() {
    const now = Date.now();
    pulseRings = pulseRings.filter(r => (now - r.born) < r.ttl);
    pulseRings.forEach(r => {
      const life   = 1 - (now - r.born) / r.ttl;
      const radius = 2 + (1 - life) * 15;
      ctx.save();
      ctx.globalAlpha = life * 0.9;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = r.color;
      ctx.lineWidth   = 1.2;
      ctx.stroke();
      ctx.restore();
    });
  }

  /* ── Controls ────────────────────────────────────────────────── */
  function setShowArcs(v) { showArcs = v; }
  function setShowHeat(v) { showHeat = v; }
  function setPaused(v)   { paused   = v; }
  function clearArcs()    { arcs = []; particles = []; pulseRings = []; }
  function invalidateHeat() { _heatOff = null; _lastHeatTs = 0; }

  function toggleGlobe() {
    globeMode  = !globeMode;
    autoRotate = globeMode;

    proj       = makeProj();
    svgGeoPath = d3.geoPath(proj);
    _bgCgp     = d3.geoPath(proj, bgCtx);
    _lastGlobeRot = [Infinity, Infinity, Infinity];

    bgCanvas.style.display = globeMode ? 'block' : 'none';
    document.getElementById('map-container').classList.toggle('globe-mode', globeMode);
    renderSVGMap();

    arcs.forEach(a => {
      const sp = proj(a.srcGeo); const tp = proj(a.tgtGeo);
      if (sp) { a.x1 = sp[0]; a.y1 = sp[1]; }
      if (tp) { a.x2 = tp[0]; a.y2 = tp[1]; }
    });

    _heatDirty = true;
    return globeMode;
  }

  /* ── Resize ─────────────────────────────────────────────────── */
  function onResize() {
    const container = document.getElementById('map-container');
    mapW = container.clientWidth;
    mapH = container.clientHeight;
    canvas.width    = mapW;
    canvas.height   = mapH;
    bgCanvas.width  = mapW;
    bgCanvas.height = mapH;
    proj       = makeProj();
    svgGeoPath = d3.geoPath(proj);
    _bgCgp     = d3.geoPath(proj, bgCtx);
    _lastGlobeRot = [Infinity, Infinity, Infinity];
    _heatOff   = null;
    renderSVGMap();
  }

  function resize() { onResize(); }

  function lonLatToXY(lon, lat) {
    const pt = proj([lon, lat]);
    return pt ? { x: pt[0], y: pt[1] } : { x: 0, y: 0 };
  }

  return { init, addArc, setShowArcs, setShowHeat, setPaused, clearArcs,
           lonLatToXY, resize, toggleGlobe, invalidateHeat };
})();
