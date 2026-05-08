/**
 * app.js — Azimuth main orchestration
 */

(async () => {
  const { TYPES, GEO, SCENARIOS } = window.AZIMUTH_DATA;

  let paused   = false;
  let showArcs = true;
  let showHeat = true;
  let theater  = false;
  let simTimer = null;

  let _dataLastModified = null;

  /* ── Clock + Session uptime ─────────────────────────────────── */
  const sessionStart = Date.now();

  function tickClock() {
    const d   = new Date();
    const utc = d.toUTCString().split(' ');
    document.getElementById('clock').textContent = utc[4] + ' UTC';

    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const el = document.getElementById('ts-uptime');
    if (el) el.textContent = `${hh}:${mm}:${ss}`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ── Intel source badge ─────────────────────────────────────── */
  function setIntelSource(label, live) {
    const el  = document.getElementById('ts-source');
    const box = document.getElementById('intel-source-stat');
    if (el)  el.textContent = label;
    if (box) box.classList.toggle('source-live', live);
  }

  /* ── Map init ───────────────────────────────────────────────── */
  await AzimuthMap.init();

  /* ── Spawn an attack ────────────────────────────────────────── */
  function spawnAttack(scenario) {
    const s        = scenario || SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    const typeInfo = TYPES[s.type];
    if (!GEO[s.src] || !GEO[s.tgt]) return;

    const attack = { ...s, color: typeInfo.color };
    AzimuthFeed.addEvent(attack);
    AzimuthMap.addArc(attack);
  }

  /* ── Simulation loop ────────────────────────────────────────── */
  function scheduleNext() {
    const delay = 700 + Math.random() * 1300;
    simTimer = setTimeout(() => {
      if (!paused) spawnAttack();
      scheduleNext();
    }, delay);
  }

  SCENARIOS.slice(0, 8).forEach((s, i) => {
    setTimeout(() => spawnAttack(s), i * 350 + 200);
  });
  setTimeout(scheduleNext, 3200);

  /* ── Filter buttons ─────────────────────────────────────────── */
  document.getElementById('filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    AzimuthFeed.setFilter(btn.dataset.f);
  });

  /* ── Map control buttons ────────────────────────────────────── */
  document.getElementById('btn-arcs').addEventListener('click', function () {
    showArcs = !showArcs;
    this.classList.toggle('active', showArcs);
    AzimuthMap.setShowArcs(showArcs);
  });

  document.getElementById('btn-heat').addEventListener('click', function () {
    showHeat = !showHeat;
    this.classList.toggle('active', showHeat);
    AzimuthMap.setShowHeat(showHeat);
  });

  document.getElementById('btn-pause').addEventListener('click', function () {
    paused = !paused;
    this.classList.toggle('active', paused);
    this.textContent = paused ? 'Resume' : 'Pause';
    AzimuthMap.setPaused(paused);
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    AzimuthMap.clearArcs();
  });

  /* ── Fullscreen ─────────────────────────────────────────────── */
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(console.warn);
    } else {
      document.exitFullscreen().catch(console.warn);
    }
  }

  document.addEventListener('fullscreenchange', () => {
    const btn  = document.getElementById('btn-fs');
    const isFs = !!document.fullscreenElement;
    btn.textContent = isFs ? 'Exit Full' : 'Full';
    btn.classList.toggle('active', isFs);
  });

  document.getElementById('btn-fs').addEventListener('click', toggleFullscreen);

  /* ── Globe / Map toggle ────────────────────────────────────── */
  document.getElementById('btn-globe').addEventListener('click', function () {
    const isGlobe = AzimuthMap.toggleGlobe();
    this.textContent = isGlobe ? 'Flat Map' : 'Globe';
    this.classList.toggle('active', isGlobe);
  });

  /* ── Theater / Focus mode ───────────────────────────────────── */
  function toggleTheater() {
    theater = !theater;
    const btn = document.getElementById('btn-theater');
    document.getElementById('app').classList.toggle('theater', theater);
    btn.textContent = theater ? 'Exit Focus' : 'Focus';
    btn.classList.toggle('active', theater);
    // Give the map a moment to re-measure after layout shift
    setTimeout(() => AzimuthMap.resize(), 320);
  }

  document.getElementById('btn-theater').addEventListener('click', toggleTheater);

  /* ── Export PNG ─────────────────────────────────────────────── */
  async function exportPNG() {
    const btn = document.getElementById('btn-export');
    btn.textContent = 'Saving…';
    btn.disabled = true;

    try {
      const svgEl     = document.getElementById('world-svg');
      const mapCanvas = document.getElementById('map-canvas');
      const svgData   = new XMLSerializer().serializeToString(svgEl);
      const blob      = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url       = URL.createObjectURL(blob);

      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const off = document.createElement('canvas');
          off.width  = mapCanvas.width;
          off.height = mapCanvas.height;
          const c = off.getContext('2d');
          c.fillStyle = '#020408';
          c.fillRect(0, 0, off.width, off.height);
          c.drawImage(img, 0, 0);
          c.drawImage(mapCanvas, 0, 0);
          const a = document.createElement('a');
          a.download = `azimuth-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
          a.href = off.toDataURL('image/png');
          a.click();
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(); };
        img.src = url;
      });
    } catch (e) {
      console.warn('Export failed:', e);
    }

    btn.textContent = 'Export';
    btn.disabled = false;
  }

  document.getElementById('btn-export').addEventListener('click', exportPNG);

  /* ── Export CSV ─────────────────────────────────────────────── */
  function exportCSV() {
    const items  = AzimuthFeed.getAllEvents();
    const header = 'Timestamp,Source,Target,Type,IP,Severity\n';
    const rows   = items.map(e =>
      `${e.time},${e.src},${e.tgt},${e.type},${e.ip},${e.severity}`
    ).join('\n');
    const blobUrl = URL.createObjectURL(
      new Blob([header + rows], { type: 'text/csv' })
    );
    const a = document.createElement('a');
    a.download = `azimuth-feed-${new Date().toISOString().slice(0, 10)}.csv`;
    a.href = blobUrl;
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  document.getElementById('btn-csv').addEventListener('click', exportCSV);

  /* ── Country detail drawer ──────────────────────────────────── */
  const AzimuthDrawer = (() => {
    const { FLAGS, TYPES } = window.AZIMUTH_DATA;
    const drawer = document.getElementById('country-drawer');

    function open(country) {
      if (!country) return;
      document.getElementById('d-flag').textContent  = FLAGS[country] || '🌐';
      document.getElementById('d-cname').textContent = country;

      const stats = window.AzimuthFeed.getCountryStats(country);
      document.getElementById('d-out').textContent    = stats.out;
      document.getElementById('d-in').textContent     = stats.in;
      document.getElementById('d-threat').textContent = stats.topThreat || '—';

      const breakdown = window.AzimuthFeed.getTypeBreakdownOf(country);
      const bdTotal   = Object.values(breakdown).reduce((a, b) => a + b, 0) || 1;
      Object.keys(TYPES).forEach(k => {
        const pct   = Math.round((breakdown[k] || 0) / bdTotal * 100);
        const fill  = document.getElementById('dbd-' + k);
        const pctEl = document.getElementById('dbpct-' + k);
        if (fill)  fill.style.width  = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
      });

      const targets = window.AzimuthFeed.getTopTargetsOf(country);
      document.getElementById('d-targets').innerHTML = targets.length
        ? targets.map(([c, n]) => `<div class="d-row"><span class="d-row-flag">${FLAGS[c]||'🌐'}</span><span class="d-row-country">${c}</span><span class="d-row-count">${n}</span></div>`).join('')
        : '<div class="d-empty">No outbound events yet</div>';

      const sources = window.AzimuthFeed.getTopSourcesOf(country);
      document.getElementById('d-sources').innerHTML = sources.length
        ? sources.map(([c, n]) => `<div class="d-row"><span class="d-row-flag">${FLAGS[c]||'🌐'}</span><span class="d-row-country">${c}</span><span class="d-row-count">${n}</span></div>`).join('')
        : '<div class="d-empty">No inbound events yet</div>';

      const events = window.AzimuthFeed.getAllEvents()
        .filter(e => e.src === country || e.tgt === country)
        .slice(0, 10);
      document.getElementById('d-events').innerHTML = events.length
        ? events.map(e => {
            const t   = TYPES[e.type];
            const dir = e.src === country ? '→' : '←';
            const peer = e.src === country ? e.tgt : e.src;
            const vtUrl = `https://www.virustotal.com/gui/ip-address/${e.ip}`;
            return `<div class="d-event">
              <span class="fi-type ${t.cls}">${t.label}</span>
              <span class="d-event-dir">${dir}</span>
              <span class="d-event-peer">${peer}</span>
              <a class="fi-ip-link" href="${vtUrl}" target="_blank" rel="noopener noreferrer">${e.ip}</a>
              ${e.first_seen ? `<span class="d-event-first">${e.first_seen}</span>` : ''}
            </div>`;
          }).join('')
        : '<div class="d-empty">No events yet</div>';

      drawer.classList.add('open');
    }

    function close() { drawer.classList.remove('open'); }

    document.getElementById('d-close').addEventListener('click', close);
    document.getElementById('map-container').addEventListener('click', e => {
      if (e.target === drawer || drawer.contains(e.target)) return;
      if (drawer.classList.contains('open')) close();
    });

    return { open, close };
  })();

  window.AzimuthDrawer = AzimuthDrawer;

  /* ── Search wire-up ─────────────────────────────────────────── */
  const searchInput = document.getElementById('feed-search');
  const searchClear = document.getElementById('search-clear');
  searchInput.addEventListener('input', () => AzimuthFeed.setSearch(searchInput.value));
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    AzimuthFeed.setSearch('');
  });

  /* ── Keyboard Shortcuts Modal ───────────────────────────────── */
  const modal = document.getElementById('shortcuts-modal');

  document.getElementById('btn-shortcuts').addEventListener('click', () => {
    modal.classList.toggle('open');
  });

  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open');
  });

  /* ── Keyboard shortcuts ─────────────────────────────────────── */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key.toLowerCase()) {
      case 'g':
        document.getElementById('btn-globe').click();
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 't':
        toggleTheater();
        break;
      case 'p':
        document.getElementById('btn-pause').click();
        break;
      case 'c':
        document.getElementById('btn-clear').click();
        break;
      case 'h':
        document.getElementById('btn-heat').click();
        break;
      case 'a':
        document.getElementById('btn-arcs').click();
        break;
      case 'e':
        exportPNG();
        break;
      case 'x':
        exportCSV();
        break;
      case '?':
        modal.classList.toggle('open');
        break;
      case 'escape':
        modal.classList.remove('open');
        if (document.fullscreenElement) document.exitFullscreen().catch(console.warn);
        break;
    }
  });

  /* ── Timeline sparkline ─────────────────────────────────────── */
  function drawTimeline() {
    const canvas = document.getElementById('timeline-canvas');
    if (!canvas) return;
    const W = canvas.parentElement.clientWidth - 28;
    if (W <= 0) return;
    canvas.width  = W;
    canvas.height = 44;
    const ctx = canvas.getContext('2d');

    const data   = AzimuthFeed.getTimeline(60);
    const maxVal = Math.max(...data, 1);
    const barW   = W / 60;
    const H      = 44;

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(13, 42, 68, 0.7)';
    ctx.lineWidth   = 0.5;
    [H * 0.33, H * 0.66].forEach(y => {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    });

    data.forEach((val, i) => {
      if (!val) return;
      const bh    = Math.max(2, (val / maxVal) * (H - 6));
      const alpha = 0.25 + (i / 59) * 0.75;  // dim → bright left → right
      ctx.fillStyle = `rgba(0, 212, 255, ${alpha.toFixed(2)})`;
      ctx.fillRect(i * barW + 0.5, H - bh, Math.max(1, barW - 1.5), bh);
    });

    // Time axis labels
    ctx.fillStyle = 'rgba(106, 143, 170, 0.55)';
    ctx.font      = '7px JetBrains Mono, monospace';
    ctx.fillText('60s ago', 0, H - 1);
    ctx.textAlign = 'right';
    ctx.fillText('now', W, H - 1);
    ctx.textAlign = 'left';
  }

  setInterval(drawTimeline, 1000);
  drawTimeline();
  drawHistory();

  /* ── Public API (for real CTI feed integration) ─────────────── */
  /**
   * window.Azimuth.ingest({ src, tgt, type })
   * Call this from your own polling loop to inject real attack events.
   * src/tgt must match keys in AZIMUTH_DATA.GEO.
   * type: malware | ddos | phishing | recon | c2 | exploit
   */
  window.Azimuth = {
    ingest: spawnAttack,
    pause:  () => { paused = true;  AzimuthMap.setPaused(true);  },
    resume: () => { paused = false; AzimuthMap.setPaused(false); },
    clear:  () => AzimuthMap.clearArcs(),
  };

  // --- REAL CTI FEED ---
  // data/iocs.json is refreshed hourly by GitHub Actions (scripts/fetch_iocs.py).
  // Same-origin fetch — no CORS issues. Falls back to simulation if file is empty.

  function setRealFeedStats(events) {
    window.AZIMUTH_REALSTATS = true;
    const { TYPES, GEO } = window.AZIMUTH_DATA;
    const valid = events.filter(e => GEO[e.src]);

    // Pre-populate heatmap + leaderboards immediately from real data
    AzimuthFeed.ingestBatch(valid);

    function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

    set('ts-total', valid.length.toLocaleString());

    const srcCountries = new Set(valid.map(e => e.src));
    set('ts-countries', srcCountries.size);

    let crit = 0, high = 0, med = 0;
    valid.forEach(e => {
      const t = TYPES[e.type];
      if (!t) return;
      if      (t.severity === 'CRITICAL') crit++;
      else if (t.severity === 'HIGH')     high++;
      else                                med++;
    });
    set('r-critical', crit);
    set('r-high',     high);
    set('r-medium',   med);

    // Global threat level based on critical ratio
    const sevEl = document.getElementById('ts-severity');
    if (sevEl) {
      const ratio = crit / (valid.length || 1);
      const level = ratio > 0.35 ? 'CRITICAL' : ratio > 0.15 ? 'HIGH' : 'ELEVATED';
      sevEl.textContent = level;
      sevEl.className   = 'top-stat-val ' + (level === 'CRITICAL' ? 'red' : level === 'HIGH' ? 'amber' : 'green');
    }

    // Attack type breakdown from real data
    const typeMap = {};
    valid.forEach(e => { if (e.type) typeMap[e.type] = (typeMap[e.type] || 0) + 1; });
    const total = valid.length || 1;
    Object.keys(TYPES).forEach(k => {
      const pct = Math.round((typeMap[k] || 0) / total * 100);
      const fill  = document.getElementById('bd-' + k);
      const pctEl = document.getElementById('bpct-' + k);
      if (fill)  fill.style.width  = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    });
  }

  function saveHistorySnapshot(events) {
    const key = 'azimuth_24h';
    const now  = Date.now();
    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
    const byType = {};
    events.forEach(e => { if (e.type) byType[e.type] = (byType[e.type] || 0) + 1; });
    history.push({ ts: now, total: events.length, byType });
    const cutoff = now - 24 * 3600 * 1000;
    history = history.filter(h => h.ts > cutoff).slice(-24);
    try { localStorage.setItem(key, JSON.stringify(history)); } catch {}
  }

  function drawHistory() {
    const canvas = document.getElementById('history-canvas');
    if (!canvas) return;
    const W = canvas.parentElement.clientWidth - 28;
    if (W <= 0) return;
    canvas.width  = W;
    canvas.height = 28;
    const hctx = canvas.getContext('2d');
    hctx.clearRect(0, 0, W, 28);

    let history = [];
    try { history = JSON.parse(localStorage.getItem('azimuth_24h') || '[]'); } catch {}

    if (history.length < 1) {
      hctx.fillStyle = 'rgba(106,143,170,0.3)';
      hctx.font = '8px JetBrains Mono, monospace';
      hctx.fillText('Collecting — data appears after first hourly fetch', 2, 17);
      return;
    }

    const typeColors = { malware:'#ff3355', c2:'#00ff88', exploit:'#ff8844', phishing:'#aa44ff', ddos:'#ffaa00', recon:'#00d4ff' };
    const slots = history.slice(-24);
    const barW  = W / Math.max(slots.length, 1);

    slots.forEach((snap, i) => {
      const total = Object.values(snap.byType).reduce((a, b) => a + b, 0) || 1;
      let y = 28;
      const typeOrder = ['malware', 'c2', 'exploit', 'phishing', 'ddos', 'recon'];
      typeOrder.forEach(type => {
        const count = snap.byType[type] || 0;
        if (!count) return;
        const h = Math.max(1, Math.round((count / total) * 28));
        hctx.fillStyle = typeColors[type] || '#444';
        hctx.fillRect(i * barW + 0.5, y - h, Math.max(1, barW - 1.5), h);
        y -= h;
      });
    });

    hctx.fillStyle = 'rgba(106,143,170,0.5)';
    hctx.font = '7px JetBrains Mono, monospace';
    if (slots.length > 0) {
      const d = new Date(slots[0].ts);
      hctx.fillText(d.getHours() + ':00', 0, 27);
    }
    hctx.textAlign = 'right';
    hctx.fillText('now', W, 27);
    hctx.textAlign = 'left';
  }

  async function pollRealFeed() {
    try {
      const headers = {};
      if (_dataLastModified) headers['If-Modified-Since'] = _dataLastModified;

      const res = await fetch('./data/iocs.json', { cache: 'no-cache', headers });

      if (res.status === 304) return; // not modified — skip re-processing
      if (!res.ok) { setIntelSource('SIMULATION', false); return; }

      const lm = res.headers.get('Last-Modified');
      if (lm) _dataLastModified = lm;

      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) { setIntelSource('SIMULATION', false); return; }

      setRealFeedStats(events);
      saveHistorySnapshot(events);
      drawHistory();

      const batch = [...events].sort(() => Math.random() - 0.5).slice(0, 60);
      const gap   = Math.max(500, Math.floor(55_000 / batch.length));
      batch.forEach((ev, i) => {
        setTimeout(() => { if (!paused) spawnAttack(ev); }, i * gap);
      });
      setIntelSource('LIVE INTEL', true);
      console.log(`[Threat Intel] ${events.length} events loaded`);
    } catch (_) {
      setIntelSource('SIMULATION', false);
    }
  }

  pollRealFeed();
  setInterval(pollRealFeed, 60_000);
  // --- END REAL CTI FEED ---

})();
