/**
 * feed.js — Attack feed, statistics, and leaderboard rendering
 */

window.AzimuthFeed = (() => {
  const { TYPES, FLAGS } = window.AZIMUTH_DATA;

  const MAX_FEED = 80;

  let feedItems    = [];
  let attackerMap  = {};  // country → count (outbound)
  let targetMap    = {};  // country → count (inbound)
  let typeMap      = {};  // type → count
  let uniqueIPs    = new Set();
  let critCount    = 0;
  let highCount    = 0;
  let medCount     = 0;
  let totalCount   = 0;
  let perMinute    = [];  // timestamps for rate calc
  let minuteHistory = []; // [{min, count, types:{}}] — last 30 minutes
  let activeFilter = 'all';
  let activeSearch = '';

  /* ── Public: ingest an attack event ───────────────────────── */
  function addEvent(attack) {
    const ip       = attack.ip || randomIP();
    const now      = Date.now();
    const typeInfo = TYPES[attack.type];

    totalCount++;
    attackerMap[attack.src] = (attackerMap[attack.src] || 0) + 1;
    targetMap[attack.tgt]   = (targetMap[attack.tgt]   || 0) + 1;
    typeMap[attack.type]    = (typeMap[attack.type]    || 0) + 1;
    uniqueIPs.add(ip);

    if      (typeInfo.severity === 'CRITICAL') critCount++;
    else if (typeInfo.severity === 'HIGH')     highCount++;
    else                                       medCount++;

    perMinute.push(now);
    perMinute = perMinute.filter(t => now - t < 60_000);

    const minKey = Math.floor(now / 60000);
    const lastBucket = minuteHistory[minuteHistory.length - 1];
    if (lastBucket && lastBucket.min === minKey) {
      lastBucket.count++;
      lastBucket.types[attack.type] = (lastBucket.types[attack.type] || 0) + 1;
    } else {
      minuteHistory.push({ min: minKey, count: 1, types: { [attack.type]: 1 } });
      if (minuteHistory.length > 30) minuteHistory.shift();
    }

    feedItems.unshift({ src: attack.src, tgt: attack.tgt, type: attack.type, ip, time: timeStr(), severity: typeInfo.severity, family: attack.family || '', first_seen: attack.first_seen || '' });
    if (feedItems.length > MAX_FEED) feedItems.pop();

    renderFeed();
    renderStats();
    renderAttackers();
    renderTargets();
    renderBreakdown();
  }

  /* ── Rendering ─────────────────────────────────────────────── */
  function renderFeed() {
    const list  = document.getElementById('feed-list');
    let items = activeFilter === 'all'
      ? feedItems
      : feedItems.filter(f => f.type === activeFilter);

    if (activeSearch) {
      const q = activeSearch;
      items = items.filter(f =>
        f.ip.includes(q) ||
        f.src.toLowerCase().includes(q) ||
        f.tgt.toLowerCase().includes(q) ||
        (f.family || '').toLowerCase().includes(q) ||
        f.type.includes(q)
      );
    }

    document.getElementById('feed-count').textContent = items.length + ' events';

    list.innerHTML = '';
    items.slice(0, 35).forEach((item, i) => {
      const t   = TYPES[item.type];
      const sev = item.severity;
      const sevColor = sev === 'CRITICAL' ? 'var(--red)' : sev === 'HIGH' ? 'var(--amber)' : 'var(--text2)';
      const vtUrl = `https://www.virustotal.com/gui/ip-address/${item.ip}`;

      const div = document.createElement('div');
      div.className = 'feed-item' + (i === 0 ? ' new-item' : '');
      div.innerHTML = `
      <div class="fi-top">
        <span class="fi-type ${t.cls}">${t.label}</span>
        <span class="fi-src" data-country="${item.src}" role="button">${item.src}</span>
        <span class="fi-arr">→</span>
        <span class="fi-tgt" data-country="${item.tgt}" role="button">${item.tgt}</span>
        <span class="fi-time">${item.time}</span>
      </div>
      <div class="fi-bot">
        <a class="fi-ip-link" href="${vtUrl}" target="_blank" rel="noopener noreferrer" title="Look up on VirusTotal">${item.ip}</a>
        ${item.family ? `<span class="fi-family">${item.family}</span>` : ''}
        <span class="fi-sev" style="color:${sevColor}">${sev}</span>
      </div>`;
      list.appendChild(div);
    });
  }

  function renderStats() {
    const rate = perMinute.length;
    setText('ts-rate',  rate);
    setText('r-unique', uniqueIPs.size);
    // When real feed data is loaded, it controls these fields
    if (!window.AZIMUTH_REALSTATS) {
      setText('ts-total',     totalCount.toLocaleString());
      setText('ts-countries', Object.keys(attackerMap).length);
      setText('r-critical',   critCount);
      setText('r-high',       highCount);
      setText('r-medium',     medCount);
    }
  }

  function renderAttackers() {
    const sorted = Object.entries(attackerMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max    = sorted[0] ? sorted[0][1] : 1;

    document.getElementById('attackers').innerHTML = sorted.map(([country, count], i) => `
      <div class="attacker-row">
        <span class="att-rank">${i + 1}</span>
        <span class="att-flag">${FLAGS[country] || '🌐'}</span>
        <span class="att-country">${country}</span>
        <div class="att-bar-wrap">
          <div class="att-bar" style="width:${Math.round(count / max * 100)}%"></div>
        </div>
        <span class="att-count">${count}</span>
      </div>`).join('');
  }

  function renderTargets() {
    const el = document.getElementById('targets');
    if (!el) return;
    const sorted = Object.entries(targetMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max    = sorted[0] ? sorted[0][1] : 1;

    el.innerHTML = sorted.map(([country, count], i) => `
      <div class="attacker-row">
        <span class="att-rank">${i + 1}</span>
        <span class="att-flag">${FLAGS[country] || '🌐'}</span>
        <span class="att-country">${country}</span>
        <div class="att-bar-wrap">
          <div class="att-bar tgt-bar" style="width:${Math.round(count / max * 100)}%"></div>
        </div>
        <span class="att-count tgt-count">${count}</span>
      </div>`).join('');
  }

  function renderBreakdown() {
    if (window.AZIMUTH_REALSTATS) return;  // real feed controls breakdown
    const total = Object.values(typeMap).reduce((a, b) => a + b, 0) || 1;
    Object.keys(TYPES).forEach(k => {
      const pct = Math.round((typeMap[k] || 0) / total * 100);
      const fill = document.getElementById('bd-' + k);
      const pctEl = document.getElementById('bpct-' + k);
      if (fill)  fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    });
  }

  /* ── Filter ─────────────────────────────────────────────────── */
  function setFilter(f) {
    activeFilter = f;
    renderFeed();
  }

  function setSearch(q) {
    activeSearch = q.toLowerCase().trim();
    renderFeed();
  }

  /* ── Queries ─────────────────────────────────────────────────── */
  function getCountryStats(country) {
    const out      = attackerMap[country] || 0;
    const inCount  = targetMap[country] || 0;
    const srcTypes = feedItems.filter(f => f.src === country).map(f => f.type);
    const topThreat = srcTypes.length
      ? TYPES[srcTypes.sort((a, b) => srcTypes.filter(v => v === b).length - srcTypes.filter(v => v === a).length)[0]].label
      : null;
    return { out, in: inCount, topThreat };
  }

  function getAttackerMap() { return attackerMap; }

  function getAllEvents() { return [...feedItems]; }

  function getTimeline(buckets) {
    const now    = Date.now();
    const result = new Array(buckets).fill(0);
    perMinute.forEach(t => {
      const ageS = Math.floor((now - t) / 1000);
      if (ageS < buckets) result[buckets - 1 - ageS]++;
    });
    return result;
  }

  /* ── Helpers ─────────────────────────────────────────────────── */
  function randomIP() {
    return `${rr(1,254)}.${rr(0,254)}.${rr(0,254)}.${rr(1,254)}`;
  }
  function rr(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function timeStr() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ── Batch ingest from real feed (no animation) ─────────────── */
  function ingestBatch(events) {
    events.forEach(e => {
      if (e.src) attackerMap[e.src] = (attackerMap[e.src] || 0) + 1;
      if (e.tgt) targetMap[e.tgt]   = (targetMap[e.tgt]   || 0) + 1;
    });
    renderAttackers();
    renderTargets();
    // Tell map to redraw heatmap with new data
    if (window.AzimuthMap) window.AzimuthMap.invalidateHeat();
  }

  function getTopTargetsOf(country) {
    const counts = {};
    feedItems.filter(f => f.src === country).forEach(f => {
      counts[f.tgt] = (counts[f.tgt] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  function getTopSourcesOf(country) {
    const counts = {};
    feedItems.filter(f => f.tgt === country).forEach(f => {
      counts[f.src] = (counts[f.src] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  function getTypeBreakdownOf(country) {
    const counts = {};
    feedItems.filter(f => f.src === country).forEach(f => {
      counts[f.type] = (counts[f.type] || 0) + 1;
    });
    return counts;
  }

  function getMinuteHistory() { return minuteHistory; }
  function getTypeMap()      { return { ...typeMap }; }

  return { addEvent, ingestBatch, setFilter, setSearch, getCountryStats, getAttackerMap, getAllEvents, getTimeline, getMinuteHistory, getTargetMap: () => targetMap, getTopTargetsOf, getTopSourcesOf, getTypeBreakdownOf, getTypeMap };
})();

document.getElementById('feed-list').addEventListener('click', e => {
  const el = e.target.closest('[data-country]');
  if (el && window.AzimuthDrawer) window.AzimuthDrawer.open(el.dataset.country);
});
