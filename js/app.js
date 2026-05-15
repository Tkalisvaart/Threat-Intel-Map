(async () => {
  const { TYPES, GEO } = window.AZIMUTH_DATA;

  let paused   = false;
  let showArcs = true;
  let showHeat = true;
  let theater  = false;

  let _dataLastModified   = null;
  let _cfMetaLastModified = null;
  let _rawEvents          = [];
  let _animQueue          = [];
  let _animTimer          = null;

  const ANIM_INTERVAL_MS = 700;

  /* ── Clock + uptime ─────────────────────────────────────────── */
  const sessionStart = Date.now();
  function tickClock() {
    const d = new Date();
    document.getElementById('clock').textContent = d.toUTCString().split(' ')[4] + ' UTC';
    const s  = Math.floor((Date.now() - sessionStart) / 1000);
    const el = document.getElementById('ts-uptime');
    if (el) el.textContent =
      `${String(Math.floor(s / 3600)).padStart(2,'0')}:${String(Math.floor((s % 3600) / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  await AzimuthMap.init();

  /* ── Spawn one event ────────────────────────────────────────── */
  function spawnAttack(ev, countStats = false) {
    const typeInfo = TYPES[ev.type];
    if (!typeInfo || !GEO[ev.src] || !GEO[ev.tgt]) return;
    AzimuthFeed.addEvent({ ...ev, color: typeInfo.color }, countStats);
    AzimuthMap.addArc({ ...ev, color: typeInfo.color });
  }

  /* ── Map controls ───────────────────────────────────────────── */
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
  document.getElementById('btn-clear').addEventListener('click', () => AzimuthMap.clearArcs());

  /* ── Fullscreen ─────────────────────────────────────────────── */
  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(console.warn);
    else document.exitFullscreen().catch(console.warn);
  }
  document.addEventListener('fullscreenchange', () => {
    const btn  = document.getElementById('btn-fs');
    const isFs = !!document.fullscreenElement;
    btn.textContent = isFs ? 'Exit Full' : 'Full';
    btn.classList.toggle('active', isFs);
  });
  document.getElementById('btn-fs').addEventListener('click', toggleFullscreen);

  /* ── Globe toggle ───────────────────────────────────────────── */
  document.getElementById('btn-globe').addEventListener('click', function () {
    const isGlobe = AzimuthMap.toggleGlobe();
    this.textContent = isGlobe ? 'Flat Map' : 'Globe';
    this.classList.toggle('active', isGlobe);
  });

  /* ── Theater mode ───────────────────────────────────────────── */
  function toggleTheater() {
    theater = !theater;
    const btn = document.getElementById('btn-theater');
    document.getElementById('app').classList.toggle('theater', theater);
    btn.textContent = theater ? 'Exit Focus' : 'Focus';
    btn.classList.toggle('active', theater);
    setTimeout(() => AzimuthMap.resize(), 320);
  }
  document.getElementById('btn-theater').addEventListener('click', toggleTheater);

  /* ── CSV export ─────────────────────────────────────────────── */
  function exportCSV() {
    const items  = _rawEvents.length ? _rawEvents : AzimuthFeed.getAllEvents();
    const header = 'Source,Target,Type,Severity,IP,Family,FirstSeen\n';
    const rows   = items.map(e => {
      const sev = TYPES[e.type] ? TYPES[e.type].severity : '';
      return `${e.src},${e.tgt},${e.type},${sev},${e.ip || ''},${e.family || ''},${e.first_seen || ''}`;
    }).join('\n');
    const a = document.createElement('a');
    a.download = `azimuth-feed-${new Date().toISOString().slice(0, 10)}.csv`;
    a.href = URL.createObjectURL(new Blob([header + rows], { type: 'text/csv' }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  document.getElementById('btn-csv').addEventListener('click', exportCSV);

  /* ── Country drawer ─────────────────────────────────────────── */
  const AzimuthDrawer = (() => {
    const { FLAGS, TYPES: T, THREAT_ACTORS } = window.AZIMUTH_DATA;
    const drawer = document.getElementById('country-drawer');

    function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

    function open(country) {
      if (!country) return;
      set('d-flag',  FLAGS[country] || '🌐');
      set('d-cname', country);

      const stats = AzimuthFeed.getCountryStats(country);
      set('d-out',    stats.out);
      set('d-in',     stats.in);
      set('d-threat', stats.topThreat || '—');

      const breakdown = AzimuthFeed.getTypeBreakdownOf(country);
      const bdTotal   = Object.values(breakdown).reduce((a, b) => a + b, 0) || 1;
      Object.keys(T).forEach(k => {
        const pct   = Math.round((breakdown[k] || 0) / bdTotal * 100);
        const fill  = document.getElementById('dbd-' + k);
        const pctEl = document.getElementById('dbpct-' + k);
        if (fill)  fill.style.width  = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
      });

      const fmtList = (items, emptyMsg) => items.length
        ? items.map(([c, n]) => `<div class="d-row"><span class="d-row-flag">${FLAGS[c]||'🌐'}</span><span class="d-row-country">${c}</span><span class="d-row-count">${n}</span></div>`).join('')
        : `<div class="d-empty">${emptyMsg}</div>`;

      document.getElementById('d-targets').innerHTML = fmtList(AzimuthFeed.getTopTargetsOf(country), 'No indicators yet');
      document.getElementById('d-sources').innerHTML = fmtList(AzimuthFeed.getTopSourcesOf(country), 'No exposure data yet');

      const events = AzimuthFeed.getAllEvents().filter(e => e.src === country || e.tgt === country).slice(0, 10);
      document.getElementById('d-events').innerHTML = events.length
        ? events.map(e => {
            const t     = T[e.type];
            const dir   = e.src === country ? '→' : '←';
            const peer  = e.src === country ? e.tgt : e.src;
            const actor = e.family ? (THREAT_ACTORS[e.family] || '') : '';
            return `<div class="d-event">
              <span class="fi-type ${t.cls}">${t.label}</span>
              <span class="d-event-dir">${dir}</span>
              <span class="d-event-peer">${peer}</span>
              ${e.ip ? `<a class="fi-ip-link" href="https://www.virustotal.com/gui/ip-address/${e.ip}" target="_blank" rel="noopener noreferrer">${e.ip}</a>` : ''}
              ${actor ? `<span class="d-event-actor">${actor}</span>` : ''}
              ${e.first_seen ? `<span class="d-event-first">${e.first_seen}</span>` : ''}
            </div>`;
          }).join('')
        : '<div class="d-empty">No indicators yet</div>';

      drawer.classList.add('open');
    }

    function close() { drawer.classList.remove('open'); }

    document.getElementById('d-close').addEventListener('click', close);
    document.getElementById('map-container').addEventListener('click', e => {
      if (!drawer.contains(e.target) && drawer.classList.contains('open')) close();
    });

    return { open, close };
  })();

  window.AzimuthDrawer = AzimuthDrawer;

  /* ── Keyboard shortcuts modal ───────────────────────────────── */
  const modal = document.getElementById('shortcuts-modal');
  document.getElementById('btn-shortcuts').addEventListener('click', () => modal.classList.toggle('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'g': document.getElementById('btn-globe').click(); break;
      case 'f': toggleFullscreen(); break;
      case 't': toggleTheater(); break;
      case 'p': document.getElementById('btn-pause').click(); break;
      case 'c': document.getElementById('btn-clear').click(); break;
      case 'h': document.getElementById('btn-heat').click(); break;
      case 'a': document.getElementById('btn-arcs').click(); break;
      case 'x': exportCSV(); break;
      case '?': modal.classList.toggle('open'); break;
      case 'escape':
        modal.classList.remove('open');
        if (document.fullscreenElement) document.exitFullscreen().catch(console.warn);
        break;
    }
  });

  /* ── Timeline chart ─────────────────────────────────────────── */
  const TYPE_ORDER = ['malware', 'c2', 'exploit', 'phishing', 'ddos', 'recon'];

  function hexToRgba(hex, a) {
    return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
  }

  function drawLineChart() {
    const canvas = document.getElementById('timeline-canvas');
    if (!canvas) return;
    const W = canvas.parentElement.clientWidth - 28;
    if (W <= 0) return;
    canvas.width  = W;
    canvas.height = 56;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, 56);

    const SLOTS  = 30;
    const CH     = 46;
    const nowMin = Math.floor(Date.now() / 60000);
    const hist   = AzimuthFeed.getMinuteHistory();
    const slots  = [];
    for (let i = SLOTS - 1; i >= 0; i--) {
      const min = nowMin - i;
      slots.push(hist.find(b => b.min === min) || { min, count: 0, types: {} });
    }

    const globalMax = Math.max(...slots.flatMap(s => TYPE_ORDER.map(t => s.types[t] || 0)), 1);
    const step = W / (SLOTS - 1);

    TYPE_ORDER.forEach(type => {
      const color = TYPES[type].color;
      const pts   = slots.map((s, i) => ({ x: i * step, y: CH - (s.types[type] || 0) / globalMax * CH }));

      ctx.beginPath();
      ctx.moveTo(pts[0].x, CH);
      pts.forEach((p, i) => {
        if (i === 0) { ctx.lineTo(p.x, p.y); return; }
        const cpx = step / 3;
        ctx.bezierCurveTo(pts[i-1].x + cpx, pts[i-1].y, p.x - cpx, p.y, p.x, p.y);
      });
      ctx.lineTo(pts[pts.length-1].x, CH);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(color, 0.07);
      ctx.fill();

      ctx.beginPath();
      pts.forEach((p, i) => {
        if (i === 0) { ctx.moveTo(p.x, p.y); return; }
        const cpx = step / 3;
        ctx.bezierCurveTo(pts[i-1].x + cpx, pts[i-1].y, p.x - cpx, p.y, p.x, p.y);
      });
      ctx.strokeStyle = hexToRgba(color, 0.65);
      ctx.lineWidth = 1.1;
      ctx.stroke();
    });

    ctx.fillStyle = 'rgba(106,143,170,0.45)';
    ctx.font = '7px JetBrains Mono, monospace';
    ctx.fillText('30m', 0, 56);
    ctx.textAlign = 'right';
    ctx.fillText('now', W, 56);
    ctx.textAlign = 'left';
    if (globalMax > 1) {
      ctx.fillStyle = 'rgba(106,143,170,0.3)';
      ctx.fillText(globalMax, W, 9);
    }
  }

  setInterval(drawLineChart, 1000);
  drawLineChart();

  /* ── Animation loop ─────────────────────────────────────────── */
  function refillQueue() {
    // Fisher-Yates shuffle
    _animQueue = [..._rawEvents];
    for (let i = _animQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [_animQueue[i], _animQueue[j]] = [_animQueue[j], _animQueue[i]];
    }
  }

  function startAnimLoop() {
    if (_animTimer !== null) return;
    refillQueue();
    _animTimer = setInterval(() => {
      if (paused) return;
      if (_animQueue.length === 0) refillQueue();
      if (_animQueue.length === 0) return;
      spawnAttack(_animQueue.shift());
    }, ANIM_INTERVAL_MS);
  }

  /* ── Stats update ───────────────────────────────────────────── */
  function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  function updateStats(events) {
    window.AZIMUTH_REALSTATS  = true;
    window.AZIMUTH_TOTAL_COUNT = events.length;

    AzimuthFeed.ingestBatch(events);

    const srcCountries = new Set(events.map(e => e.src));
    const tgtCountries = new Set(events.map(e => e.tgt).filter(Boolean));
    set('ts-total',   events.length.toLocaleString());
    set('ts-countries', srcCountries.size);
    set('r-unique',   srcCountries.size.toLocaleString());
    set('r-highconf', tgtCountries.size.toLocaleString());
    set('r-feeds',    'CF Radar');
    set('r-events',   events.length.toLocaleString());

    const sevEl = document.getElementById('ts-severity');
    if (sevEl) {
      const n         = events.length || 1;
      const highRatio = events.filter(e => ['exploit','malware','c2'].includes(e.type)).length / n;
      const ddosRatio = events.filter(e => e.type === 'ddos').length / n;
      const level     = (highRatio > 0.15 || ddosRatio > 0.5) ? 'CRITICAL'
                      : (highRatio > 0.05 || ddosRatio > 0.3) ? 'HIGH' : 'ELEVATED';
      sevEl.textContent = level;
      sevEl.className   = 'top-stat-val ' + (level === 'CRITICAL' ? 'red' : level === 'HIGH' ? 'amber' : 'green');
    }
  }

  /* ── Poll iocs.json ─────────────────────────────────────────── */
  async function pollRealFeed() {
    try {
      const headers = _dataLastModified ? { 'If-Modified-Since': _dataLastModified } : {};
      const res = await fetch('./data/iocs.json', { cache: 'no-cache', headers });
      if (res.status === 304 || !res.ok) return;
      const lm = res.headers.get('Last-Modified');
      if (lm) _dataLastModified = lm;
      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) return;
      _rawEvents = events;
      updateStats(events);
      startAnimLoop();
    } catch (_) {}
  }

  pollRealFeed();
  setInterval(pollRealFeed, 60_000);

  /* ── Poll cf_meta.json ──────────────────────────────────────── */
  function renderAttackVectors(meta) {
    const el = document.getElementById('attack-vectors');
    if (!el) return;
    const vectors = { ...(meta.l3_vectors || {}), ...(meta.l7_methods || {}) };
    const entries = Object.entries(vectors).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) { el.innerHTML = '<div class="d-empty">—</div>'; return; }
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
    el.innerHTML = entries.map(([name, val]) => {
      const pct   = Math.round(val / total * 100);
      const color = name.startsWith('HTTP') ? 'var(--amber)' : 'var(--accent2)';
      return `<div class="av-row">
        <span class="av-label" title="${name}">${name}</span>
        <div class="bd-track"><div class="bd-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="av-pct">${pct}%</span>
      </div>`;
    }).join('');
  }

  function renderIndustries(meta) {
    const el  = document.getElementById('targeted-industries');
    const hdr = document.getElementById('industry-header');
    if (!el) return;
    const entries = Object.entries(meta.l7_industries || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!entries.length) { if (hdr) hdr.style.display = 'none'; el.innerHTML = ''; return; }
    if (hdr) hdr.style.display = '';
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
    el.innerHTML = entries.map(([name, val]) => {
      const pct = Math.round(val / total * 100);
      return `<div class="av-row">
        <span class="av-label" title="${name}">${name}</span>
        <div class="bd-track"><div class="bd-fill" style="width:${pct}%;background:var(--purple)"></div></div>
        <span class="av-pct">${pct}%</span>
      </div>`;
    }).join('');
  }

  async function pollCFMeta() {
    try {
      const headers = _cfMetaLastModified ? { 'If-Modified-Since': _cfMetaLastModified } : {};
      const res = await fetch('./data/cf_meta.json', { cache: 'no-cache', headers });
      if (res.status === 304 || !res.ok) return;
      const lm = res.headers.get('Last-Modified');
      if (lm) _cfMetaLastModified = lm;
      const meta = await res.json();
      renderAttackVectors(meta);
      renderIndustries(meta);
    } catch (_) {}
  }

  pollCFMeta();
  setInterval(pollCFMeta, 60_000);

})();
