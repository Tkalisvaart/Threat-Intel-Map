/**
 * map.js — World map rendering: D3 Natural Earth + Orthographic Globe + Canvas FX
 */

window.SentinelMap = (() => {
  const { GEO } = window.SENTINEL_DATA;

  let proj, svgGeoPath;
  let canvas, ctx;
  let mapW, mapH;
  let arcs      = [];
  let particles = [];
  let pulseRings = [];
  let showArcs  = true;
  let showHeat  = true;
  let paused    = false;
  let globeMode = false;
  let globeRot  = [0, -25, 0];
  let autoRotate = false;
  let isDragging = false;
  let dragStart  = null;
  let autoRotTimer = null;
  let rafId, lastFrame = 0;
  let worldData = null;
  let stars = null;
  let radarAngle = 0;

  const MAX_ARCS = 50;
  const NS = 'http://www.w3.org/2000/svg';

  /* ── Projection factory ─────────────────────────────────────── */
  function makeProj() {
    if (globeMode) {
      return d3.geoOrthographic()
        .scale(Math.min(mapW, mapH) / 2.08)
        .translate([mapW / 2, mapH / 2])
        .rotate(globeRot)
        .clipAngle(90);
    }
    return d3.geoNaturalEarth1()
      .scale(mapW / 5.8)
      .translate([mapW / 2, mapH / 2]);
  }

  /* ── Init ───────────────────────────────────────────────────── */
  async function init() {
    const container = document.getElementById('map-container');
    mapW = container.clientWidth;
    mapH = container.clientHeight;

    canvas        = document.getElementById('map-canvas');
    canvas.width  = mapW;
    canvas.height = mapH;
    ctx = canvas.getContext('2d');

    proj       = makeProj();
    svgGeoPath = d3.geoPath(proj);

    initStars();
    await loadWorldMap();
    bindTooltip();
    bindGlobeDrag();

    window.addEventListener('resize', onResize);
    rafId = requestAnimationFrame(frame);
  }

  /* ── World data load ────────────────────────────────────────── */
  async function loadWorldMap() {
    try {
      const res   = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
      const world = await res.json();
      worldData = {
        countries: topojson.feature(world, world.objects.countries),
        borders:   topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
      };
      renderSVGMap();
    } catch (e) {
      console.error('Map load failed:', e);
    }
  }

  /* ── SVG flat map (clears and redraws) ──────────────────────── */
  function renderSVGMap() {
    const svg = document.getElementById('world-svg');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${mapW} ${mapH}`);

    if (globeMode || !worldData) {
      svg.style.display = 'none';
      return;
    }
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
        const s = window.SentinelFeed.getCountryStats(found);
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
      color:    attack.color,
      progress: 0,
      speed:    0.006 + Math.random() * 0.007,
      born:     Date.now(),
      ttl:      4500 + Math.random() * 3000,
      impacted: false,
    });

    // Highlight source city dot
    const dot = document.querySelector(`.city-dot[data-country="${attack.src}"]`);
    if (dot) { dot.classList.add('hot'); setTimeout(() => dot.classList.remove('hot'), 2200); }
  }

  /* ── Spawn effects ──────────────────────────────────────────── */
  function spawnImpactRing(x, y, color) {
    const ov   = document.getElementById('map-overlay');
    const ring = document.createElement('div');
    ring.className     = 'impact-ring';
    ring.style.left    = x + 'px';
    ring.style.top     = y + 'px';
    ring.style.borderColor = color;
    ov.appendChild(ring);
    setTimeout(() => ring.remove(), 800);
  }

  function spawnParticles(x, y, color) {
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2 + Math.random() * 0.3;
      const spd   = 1.8 + Math.random() * 3;
      particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        color,
        size: 1.4 + Math.random() * 1.8,
        born: Date.now(),
        ttl:  500 + Math.random() * 400,
      });
    }
  }

  function addPulseRing(x, y, color) {
    pulseRings.push({ x, y, color, born: Date.now(), ttl: 1400 });
  }

  /* ── Stars (globe mode only) ─────────────────────────────────── */
  function initStars() {
    stars = Array.from({ length: 180 }, () => ({
      x:       Math.random(),
      y:       Math.random(),
      r:       Math.random() * 1.1 + 0.2,
      baseA:   Math.random() * 0.55 + 0.15,
      twinkle: Math.random() * 0.04 + 0.008,
      phase:   Math.random() * Math.PI * 2,
    }));
  }

  function drawStarfield(ts) {
    stars.forEach(s => {
      const alpha = s.baseA + Math.sin(ts * s.twinkle + s.phase) * 0.18;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.beginPath();
      ctx.arc(s.x * mapW, s.y * mapH, s.r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  /* ── Draw loop ───────────────────────────────────────────────── */
  function frame(ts) {
    if (ts - lastFrame > 14) {
      ctx.clearRect(0, 0, mapW, mapH);

      if (globeMode) {
        // Auto-rotate
        if (autoRotate && !paused && !isDragging) {
          globeRot[0] += 0.12;
          proj.rotate(globeRot);
        }
        drawStarfield(ts);
        drawGlobeCanvas();
      }

      // drawRadarSweep(ts);
      if (showHeat) drawHeat();
      if (showArcs) drawArcs();
      drawPulseRings();
      drawParticles();

      lastFrame = ts;
    }
    rafId = requestAnimationFrame(frame);
  }

  /* ── Globe canvas rendering ─────────────────────────────────── */
  function drawGlobeCanvas() {
    if (!worldData) return;
    const { countries, borders } = worldData;
    const cgp = d3.geoPath(proj, ctx); // canvas geo-path renderer

    // Ocean sphere (radial gradient for depth)
    ctx.beginPath();
    cgp({ type: 'Sphere' });
    const sphereGrad = ctx.createRadialGradient(
      mapW / 2 - proj.scale() * 0.14, mapH / 2 - proj.scale() * 0.18, 0,
      mapW / 2, mapH / 2, proj.scale()
    );
    sphereGrad.addColorStop(0, '#0d2a4a');
    sphereGrad.addColorStop(0.55, '#041020');
    sphereGrad.addColorStop(1, '#020810');
    ctx.fillStyle = sphereGrad;
    ctx.fill();

    // Graticule
    ctx.beginPath();
    cgp(d3.geoGraticule()());
    ctx.strokeStyle = 'rgba(0, 50, 100, 0.55)';
    ctx.lineWidth   = 0.35;
    ctx.stroke();

    // Countries
    countries.features.forEach(f => {
      ctx.beginPath();
      cgp(f);
      ctx.fillStyle   = '#0c1e32';
      ctx.strokeStyle = '#183650';
      ctx.lineWidth   = 0.4;
      ctx.fill();
      ctx.stroke();
    });

    // Globe atmospheric glow ring
    ctx.beginPath();
    cgp({ type: 'Sphere' });
    ctx.shadowColor = 'rgba(0, 180, 255, 0.4)';
    ctx.shadowBlur  = 18;
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.22)';
    ctx.lineWidth   = 1.8;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // City dots on globe
    Object.entries(GEO).forEach(([, [lon, lat]]) => {
      const pt = proj([lon, lat]);
      if (!pt) return;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 1.8, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(0, 212, 255, 0.22)';
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
      ctx.lineWidth   = 0.5;
      ctx.fill();
      ctx.stroke();
    });
  }

  /* ── Radar sweep ─────────────────────────────────────────────── */
  function drawRadarSweep(ts) {
    radarAngle = (ts * 0.00055) % (Math.PI * 2);

    const cx   = mapW / 2;
    const cy   = mapH / 2;
    const maxR = Math.hypot(cx, cy) * 1.1;
    const span = 0.7; // radians of sweep trail

    ctx.save();

    // Fading sweep wedge
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    grad.addColorStop(0,   'rgba(0, 255, 120, 0)');
    grad.addColorStop(0.25, 'rgba(0, 255, 120, 0.06)');
    grad.addColorStop(1,   'rgba(0, 255, 120, 0)');

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, maxR, radarAngle - span, radarAngle);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Leading edge line
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(radarAngle) * maxR, cy + Math.sin(radarAngle) * maxR);
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.14)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.restore();
  }

  /* ── Heatmap ─────────────────────────────────────────────────── */
  function drawHeat() {
    const attackerMap = window.SentinelFeed.getAttackerMap();
    Object.entries(attackerMap).forEach(([country, count]) => {
      if (!GEO[country]) return;
      const pt = proj(GEO[country]);
      if (!pt) return;
      const [x, y] = pt;
      const r    = Math.min(44, 10 + count * 2.2);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0,   'rgba(255, 51, 85, 0.32)');
      grad.addColorStop(0.45, 'rgba(255, 51, 85, 0.1)');
      grad.addColorStop(1,   'rgba(255, 51, 85, 0)');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });
  }

  /* ── Arc drawing ─────────────────────────────────────────────── */
  function drawArcs() {
    const now = Date.now();
    arcs = arcs.filter(a => (now - a.born) < a.ttl + 900);

    arcs.forEach(arc => {
      if (!paused) arc.progress = Math.min(1, arc.progress + arc.speed);

      // In globe mode, re-project endpoints each frame
      if (globeMode) {
        const sp = proj(arc.srcGeo);
        const tp = proj(arc.tgtGeo);
        if (!sp || !tp) return; // on back hemisphere — skip
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

    // Bezier control point — lifts the arc "above" the map surface
    const cx  = (x1 + x2) / 2;
    const cy  = Math.min(y1, y2) - dist * 0.24 - 16;

    const STEPS  = 80;
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

    // ── Layer 1: Wide bloom ──────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color + '1a';
    ctx.lineWidth   = 9;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 22;
    ctx.stroke();

    // ── Layer 2: Mid glow ────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color + '44';
    ctx.lineWidth   = 3.5;
    ctx.shadowBlur  = 12;
    ctx.stroke();

    // ── Layer 3: Core line with gradient ─────────────────────────
    const lineGrad = ctx.createLinearGradient(x1, y1, ex, ey);
    lineGrad.addColorStop(0,    color + '14');
    lineGrad.addColorStop(0.35, color + '55');
    lineGrad.addColorStop(0.75, color + 'bb');
    lineGrad.addColorStop(1,    color + 'ff');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth   = 1.6;
    ctx.shadowBlur  = 7;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // ── Moving head ──────────────────────────────────────────────
    if (progress < 1) {
      // Outer ring pulse
      ctx.beginPath();
      ctx.arc(ex, ey, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = color + '50';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // White core
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fillStyle   = '#ffffff';
      ctx.shadowColor = color;
      ctx.shadowBlur  = 22;
      ctx.fill();
      ctx.shadowBlur  = 0;

      // Colored inner dot
      ctx.beginPath();
      ctx.arc(ex, ey, 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // ── Arrival: reticle + crosshair ─────────────────────────────
    if (progress >= 0.97) {
      if (!arc.impacted) {
        arc.impacted = true;
        spawnParticles(x2, y2, arc.color);
        addPulseRing(x2, y2, arc.color);
        spawnImpactRing(x2, y2, arc.color);
      }

      const rProg = Math.min(1, (progress - 0.97) / 0.055);
      const r     = 5 + rProg * 22;

      ctx.globalAlpha = fade * (1 - rProg) * 0.85;
      ctx.beginPath();
      ctx.arc(x2, y2, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 10;
      ctx.stroke();
      ctx.shadowBlur  = 0;

      // Crosshair ticks
      const tickLen = r * 0.45;
      ctx.globalAlpha = fade * (1 - rProg) * 0.6;
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(x2 + dx * (r + 2),             y2 + dy * (r + 2));
        ctx.lineTo(x2 + dx * (r + 2 + tickLen),   y2 + dy * (r + 2 + tickLen));
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.2;
        ctx.stroke();
      });
    }

    ctx.restore();
  }

  /* ── Particle system ─────────────────────────────────────────── */
  function drawParticles() {
    const now = Date.now();
    particles = particles.filter(p => (now - p.born) < p.ttl);
    particles.forEach(p => {
      const life = 1 - (now - p.born) / p.ttl;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.93; p.vy *= 0.93;
      ctx.save();
      ctx.globalAlpha  = life * 0.85;
      ctx.shadowColor  = p.color;
      ctx.shadowBlur   = 8;
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
      const radius = 4 + (1 - life) * 45;
      ctx.save();
      ctx.globalAlpha  = life * 0.45;
      ctx.shadowColor  = r.color;
      ctx.shadowBlur   = 12;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = r.color;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      ctx.restore();
    });
  }

  /* ── Controls ────────────────────────────────────────────────── */
  function setShowArcs(v) { showArcs = v; }
  function setShowHeat(v) { showHeat = v; }
  function setPaused(v)   { paused   = v; }
  function clearArcs()    { arcs = []; particles = []; pulseRings = []; }

  function toggleGlobe() {
    globeMode  = !globeMode;
    autoRotate = globeMode;

    proj       = makeProj();
    svgGeoPath = d3.geoPath(proj);

    document.getElementById('map-container').classList.toggle('globe-mode', globeMode);
    renderSVGMap();

    // Re-project existing arcs
    arcs.forEach(a => {
      const sp = proj(a.srcGeo); const tp = proj(a.tgtGeo);
      if (sp) { a.x1 = sp[0]; a.y1 = sp[1]; }
      if (tp) { a.x2 = tp[0]; a.y2 = tp[1]; }
    });

    return globeMode;
  }

  /* ── Resize ─────────────────────────────────────────────────── */
  function onResize() {
    const container = document.getElementById('map-container');
    mapW = container.clientWidth;
    mapH = container.clientHeight;
    canvas.width  = mapW;
    canvas.height = mapH;
    proj           = makeProj();
    svgGeoPath     = d3.geoPath(proj);
    renderSVGMap();
  }

  function resize() { onResize(); }

  function lonLatToXY(lon, lat) {
    const pt = proj([lon, lat]);
    return pt ? { x: pt[0], y: pt[1] } : { x: 0, y: 0 };
  }

  return { init, addArc, setShowArcs, setShowHeat, setPaused, clearArcs, lonLatToXY, resize, toggleGlobe };
})();
