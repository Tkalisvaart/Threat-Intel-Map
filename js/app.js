/**
 * app.js — Azimuth main orchestration
 */

(async () => {
  const { TYPES, GEO } = window.AZIMUTH_DATA;

  let paused   = false;
  let showArcs = true;
  let showHeat = true;
  let theater  = false;

  let _dataLastModified = null;
  let _rawEvents = [];  // full dataset from last successful iocs.json load

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
  function spawnAttack(ev, skipStats = false) {
    const typeInfo = TYPES[ev.type];
    if (!typeInfo || !GEO[ev.src] || !GEO[ev.tgt]) return;
    const attack = { ...ev, color: typeInfo.color };
    AzimuthFeed.addEvent(attack, !skipStats);
    AzimuthMap.addArc(attack);
  }

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

  /* ── Export CSV ─────────────────────────────────────────────── */
  function exportCSV() {
    const items  = _rawEvents.length ? _rawEvents : AzimuthFeed.getAllEvents();
    const header = 'Source,Target,Type,Severity,IP,Family,FirstSeen\n';
    const rows   = items.map(e => {
      const sev = TYPES[e.type] ? TYPES[e.type].severity : '';
      return `${e.src},${e.tgt},${e.type},${sev},${e.ip || ''},${e.family || ''},${e.first_seen || ''}`;
    }).join('\n');
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
        : '<div class="d-empty">No indicators yet</div>';

      const sources = window.AzimuthFeed.getTopSourcesOf(country);
      document.getElementById('d-sources').innerHTML = sources.length
        ? sources.map(([c, n]) => `<div class="d-row"><span class="d-row-flag">${FLAGS[c]||'🌐'}</span><span class="d-row-country">${c}</span><span class="d-row-count">${n}</span></div>`).join('')
        : '<div class="d-empty">No exposure data yet</div>';

      const events = window.AzimuthFeed.getAllEvents()
        .filter(e => e.src === country || e.tgt === country)
        .slice(0, 10);
      const { THREAT_ACTORS } = window.AZIMUTH_DATA;
      document.getElementById('d-events').innerHTML = events.length
        ? events.map(e => {
            const t      = TYPES[e.type];
            const dir    = e.src === country ? '→' : '←';
            const peer   = e.src === country ? e.tgt : e.src;
            const vtUrl  = `https://www.virustotal.com/gui/ip-address/${e.ip}`;
            const actor  = e.family ? (THREAT_ACTORS[e.family] || '') : '';
            const portTxt = e.port ? `<span class="fi-port">:${e.port}</span>` : '';
            const actorTxt = actor ? `<span class="d-event-actor">${actor}</span>` : '';
            return `<div class="d-event">
              <span class="fi-type ${t.cls}">${t.label}</span>
              <span class="d-event-dir">${dir}</span>
              <span class="d-event-peer">${peer}</span>
              <a class="fi-ip-link" href="${vtUrl}" target="_blank" rel="noopener noreferrer">${e.ip}</a>${portTxt}
              ${actorTxt}
              ${e.first_seen ? `<span class="d-event-first">${e.first_seen}</span>` : ''}
            </div>`;
          }).join('')
        : '<div class="d-empty">No indicators yet</div>';

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

  /* ── Intel source popup ─────────────────────────────────────── */
  const intelStat  = document.getElementById('intel-source-stat');
  const intelPopup = document.getElementById('intel-popup');

  function updateIntelPopup() {
    const s = window.AZIMUTH_SOURCES;
    const feeds = [
      { key: 'feodo',           label: 'Feodo Tracker'   },
      { key: 'openphish',       label: 'OpenPhish'        },
      { key: 'blocklist',       label: 'Blocklist.de'     },
      { key: 'emergingthreats', label: 'Emerging Threats' },
      { key: 'cins',            label: 'CINS Score'       },
      { key: 'abuseipdb',       label: 'AbuseIPDB'        },
      { key: 'threatfox',       label: 'ThreatFox'        },
      { key: 'urlhaus',         label: 'URLhaus'          },
      { key: 'ipsum',           label: 'IPsum'            },
    ];

    if (!s) {
      feeds.forEach(({ key }) => {
        const el  = document.getElementById('ipc-' + key);
        const row = document.getElementById('ipr-' + key);
        if (el)  { el.textContent = '—'; el.className = 'ip-count inactive'; }
        if (row) row.querySelector('.ip-dot').classList.remove('active');
      });
      const upd = document.getElementById('ipc-updated');
      if (upd) upd.textContent = 'No live data available';
      return;
    }

    feeds.forEach(({ key }) => {
      const count = s[key] || 0;
      const el    = document.getElementById('ipc-' + key);
      const row   = document.getElementById('ipr-' + key);
      const dot   = row && row.querySelector('.ip-dot');
      if (el) {
        el.textContent = count > 0 ? count.toLocaleString() + ' events' : 'inactive';
        el.className   = 'ip-count' + (count === 0 ? ' inactive' : '');
      }
      if (dot) dot.classList.toggle('active', count > 0);
    });

    const upd = document.getElementById('ipc-updated');
    if (upd && s.updatedAt) {
      const d  = new Date(s.updatedAt);
      const hm = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
      upd.textContent = 'Data refreshed: ' + hm;
    }
  }

  intelStat.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = intelPopup.classList.toggle('open');
    if (isOpen) updateIntelPopup();
  });

  document.addEventListener('click', () => intelPopup.classList.remove('open'));

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

  /* ── Chart helpers ──────────────────────────────────────────── */
  const { TYPES: _TYPES } = window.AZIMUTH_DATA;
  const TYPE_ORDER = ['malware', 'c2', 'exploit', 'phishing', 'ddos', 'recon'];

  function hexToRgba(hex, a) {
    return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
  }

  function setupChartCanvas(id) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const W = canvas.parentElement.clientWidth - 28;
    if (W <= 0) return null;
    canvas.width  = W;
    canvas.height = 56;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, 56);
    return { ctx, W };
  }

  /* ── Line chart — per-type activity, last 30 min ────────────── */
  function drawLineChart() {
    const chart = setupChartCanvas('timeline-canvas');
    if (!chart) return;
    const { ctx, W } = chart;

    const SLOTS  = 30;
    const CH     = 46;  // chart height; bottom 10px for labels
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
      const color = _TYPES[type].color;
      const pts = slots.map((s, i) => ({
        x: i * step,
        y: CH - (s.types[type] || 0) / globalMax * CH
      }));

      // Filled area
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

      // Line stroke
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

  function setRealFeedStats(events) {
    window.AZIMUTH_REALSTATS = true;
    const { TYPES, GEO } = window.AZIMUTH_DATA;
    const valid = events.filter(e => GEO[e.src]);

    window.AZIMUTH_TOTAL_COUNT = valid.length;

    // Pre-populate heatmap + leaderboards immediately from real data
    AzimuthFeed.ingestBatch(valid);
    AzimuthMap.invalidateHeat();

    function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

    set('ts-total', valid.length.toLocaleString());

    const srcCountries = new Set(valid.map(e => e.src));
    set('ts-countries', srcCountries.size);

    const uniqueIPSet = new Set(valid.filter(e => e.ip).map(e => e.ip));
    set('r-unique', uniqueIPSet.size.toLocaleString());

    // High-confidence indicators (AbuseIPDB confidence >= 90)
    const highConf = valid.filter(e => (e.confidence || 0) >= 90).length;
    set('r-highconf', highConf.toLocaleString());

    // Intel source breakdown — prefer explicit source field, fall back to family-based detection
    const blocklistFamilies = new Set([
      'SSH Brute Force','Web Exploit','Botnet','Brute Force','Mail Spam',
      'IMAP Brute Force','FTP Brute Force','Persistent Attacker','VoIP Scan',
    ]);
    const esrc = e => e.source;
    const feedCounts = {
      feodo:          valid.filter(e => esrc(e) === 'feodo'          || (!esrc(e) && e.type === 'c2' && (e.family || '') !== 'AbuseIPDB')).length,
      openphish:      valid.filter(e => esrc(e) === 'openphish'      || (!esrc(e) && e.family === 'Phishing Site')).length,
      blocklist:      valid.filter(e => esrc(e) === 'blocklist'       || (!esrc(e) && blocklistFamilies.has(e.family || ''))).length,
      emergingthreats:valid.filter(e => esrc(e) === 'emergingthreats'|| (!esrc(e) && e.family === 'Compromised Host')).length,
      cins:           valid.filter(e => esrc(e) === 'cins'           || (!esrc(e) && e.family === 'CINS Score')).length,
      abuseipdb:      valid.filter(e => esrc(e) === 'abuseipdb'      || (!esrc(e) && (e.family || '') === 'AbuseIPDB')).length,
      ipsum:          valid.filter(e => esrc(e) === 'ipsum'           || (!esrc(e) && e.family === 'IPsum')).length,
    };
    const urlhausCount  = valid.filter(e => esrc(e) === 'urlhaus'   || (!esrc(e) && e.active !== undefined)).length;
    const threatfoxCount = valid.filter(e => esrc(e) === 'threatfox' || (!esrc(e) && (e.port || 0) > 0 && e.active === undefined && (e.family || '') !== 'AbuseIPDB')).length;
    const activeFeeds = Object.values(feedCounts).filter(v => v > 0).length
      + (threatfoxCount > 0 ? 1 : 0)
      + (urlhausCount > 0 ? 1 : 0);
    set('r-feeds', `${activeFeeds}/9`);

    // Total documented attack events from AbuseIPDB report counts
    const atkEvents = valid.reduce((sum, e) => sum + (e.total_reports || 0), 0);
    set('r-events', atkEvents > 0 ? atkEvents.toLocaleString() : '—');

    // Global threat level — based on C2/exploit ratio (highest-risk types)
    const sevEl = document.getElementById('ts-severity');
    if (sevEl) {
      const c2exploit = valid.filter(e => e.type === 'c2' || e.type === 'exploit').length;
      const ratio = c2exploit / (valid.length || 1);
      const level = ratio > 0.4 ? 'CRITICAL' : ratio > 0.2 ? 'HIGH' : 'ELEVATED';
      sevEl.textContent = level;
      sevEl.className   = 'top-stat-val ' + (level === 'CRITICAL' ? 'red' : level === 'HIGH' ? 'amber' : 'green');
    }

    // Indicator type breakdown from real data
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

    window.AZIMUTH_TYPEMAP = typeMap;

    window.AZIMUTH_SOURCES = {
      ...feedCounts,
      threatfox: threatfoxCount,
      urlhaus:   urlhausCount,
      updatedAt: _dataLastModified,
    };
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

  /* ── Continuous animation loop ─────────────────────────────── */
  let _animQueue  = [];
  let _animTimer  = null;
  const ANIM_INTERVAL_MS = 350; // ~2.9 events/sec

  function _refillQueue() {
    _animQueue = [..._rawEvents].sort(() => Math.random() - 0.5);
  }

  function _startAnimLoop() {
    if (_animTimer !== null) return;
    _refillQueue();
    _animTimer = setInterval(() => {
      if (paused) return;
      if (_animQueue.length === 0) _refillQueue();
      if (_animQueue.length === 0) return;
      spawnAttack(_animQueue.shift(), true);
    }, ANIM_INTERVAL_MS);
  }

  async function pollRealFeed() {
    try {
      const headers = {};
      if (_dataLastModified) headers['If-Modified-Since'] = _dataLastModified;

      const res = await fetch('./data/iocs.json', { cache: 'no-cache', headers });

      if (res.status === 304) return;
      if (!res.ok) { setIntelSource('NO DATA', false); return; }

      const lm = res.headers.get('Last-Modified');
      if (lm) _dataLastModified = lm;

      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) { setIntelSource('NO DATA', false); return; }

      _rawEvents = events;
      setRealFeedStats(events);
      saveHistorySnapshot(events);
      _startAnimLoop(); // no-op after first call; queue drains into fresh data naturally
      setIntelSource('LIVE INTEL', true);
      console.log(`[Threat Intel] ${events.length} events loaded`);
    } catch (_) {
      setIntelSource('NO DATA', false);
    }
  }

  pollRealFeed();
  setInterval(pollRealFeed, 60_000);
  // --- END REAL CTI FEED ---

})();
