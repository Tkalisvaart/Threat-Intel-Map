/**
 * feed.js — Attack feed, statistics, and leaderboard rendering
 */

window.AzimuthFeed = (() => {
  const { TYPES, FLAGS } = window.AZIMUTH_DATA;

  const MAX_FEED = 80;

  let feedItems    = [];
  let attackerMap  = {};  // country → count (IOC origin)
  let targetMap    = {};  // country → count (estimated target, kept for drawer)
  let typeMap      = {};  // type → count
  let familyMap    = {};  // family → count
  let uniqueIPs    = new Set();
  let totalCount   = 0;
  let perMinute    = [];  // timestamps for rate calc
  let minuteHistory = []; // [{min, count, types:{}}] — last 30 minutes
  let activeFilter = 'all';
  let activeSearch = '';

  /* ── Public: ingest an attack event ───────────────────────── */
  function addEvent(attack, countStats = true) {
    const ip       = attack.ip || randomIP();
    const now      = Date.now();
    const typeInfo = TYPES[attack.type];

    if (countStats) {
      totalCount++;
      attackerMap[attack.src] = (attackerMap[attack.src] || 0) + 1;
      targetMap[attack.tgt]   = (targetMap[attack.tgt]   || 0) + 1;
      typeMap[attack.type]    = (typeMap[attack.type]    || 0) + 1;
      if (attack.family) familyMap[attack.family] = (familyMap[attack.family] || 0) + 1;
      uniqueIPs.add(ip);
    }

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

    feedItems.unshift({ src: attack.src, tgt: attack.tgt, type: attack.type, ip, time: timeStr(), family: attack.family || '', first_seen: attack.first_seen || '', confidence: attack.confidence || 0, active: attack.active || false, port: attack.port || 0, asn: attack.asn || '', city: attack.city || '', lat: attack.lat || 0, lon: attack.lon || 0 });
    if (feedItems.length > MAX_FEED) feedItems.pop();

    renderFeed(true);
    renderStats();
    renderLeaderboard(attackerMap, 'attackers', 'att-bar', 'att-count');
    renderLeaderboard(targetMap,   'targets',   'att-bar tgt-bar', 'att-count tgt-count');
    renderTopFamilies();
    renderBreakdown();
  }

  /* ── Rendering ─────────────────────────────────────────────── */
  function buildFeedItem(item, isNew) {
    const t        = TYPES[item.type];
    const vtUrl    = `https://www.virustotal.com/gui/ip-address/${item.ip}`;
    const age      = ageStr(item.first_seen);
    const confBadge   = item.confidence >= 90
      ? `<span class="fi-conf">CONF ${item.confidence}%</span>` : '';
    const activeBadge = item.active
      ? `<span class="fi-active">LIVE</span>` : '';
    const portBadge   = item.port
      ? `<span class="fi-port">:${item.port}</span>` : '';
    const asnShort    = item.asn ? item.asn.split(' ').slice(0, 2).join(' ') : '';
    const asnBadge    = asnShort
      ? `<span class="fi-asn" title="${item.asn}">${asnShort}</span>` : '';

    const div = document.createElement('div');
    div.className = 'feed-item' + (isNew ? ' new-item' : '');
    div.innerHTML = `
      <div class="fi-top">
        <span class="fi-type ${t.cls}">${t.label}</span>
        ${activeBadge}
        <span class="fi-src" data-country="${item.src}" role="button">${item.src}</span>
        <span class="fi-arr">→</span>
        <span class="fi-tgt" data-country="${item.tgt}" role="button">${item.tgt}</span>
        ${age ? `<span class="fi-time">${age}</span>` : ''}
      </div>
      <div class="fi-bot">
        <a class="fi-ip-link" href="${vtUrl}" target="_blank" rel="noopener noreferrer" title="Look up on VirusTotal">${item.ip}</a>${portBadge}
        ${item.family ? `<span class="fi-family">${item.family}</span>` : ''}
        ${asnBadge}
        ${confBadge}
      </div>`;
    return div;
  }

  function renderFeed(isNewItem = false) {
    const list = document.getElementById('feed-list');

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

    const total = (window.AZIMUTH_REALSTATS && window.AZIMUTH_TOTAL_COUNT)
      ? window.AZIMUTH_TOTAL_COUNT : items.length;
    const countEl = document.getElementById('feed-count');
    if (window.AZIMUTH_REALSTATS && (activeFilter !== 'all' || activeSearch)) {
      countEl.textContent = items.length + ' of ' + total.toLocaleString() + ' indicators';
    } else {
      countEl.textContent = total.toLocaleString() + ' indicators';
    }

    // Incremental update: prepend one new item, drop the last — no full rebuild
    if (isNewItem && list.children.length > 0 && items.length > 0) {
      const newItem = items[0];
      if (activeFilter === 'all' || newItem.type === activeFilter) {
        list.insertBefore(buildFeedItem(newItem, true), list.firstChild);
        while (list.children.length > 35) list.lastChild.remove();
        return;
      }
    }

    // Full rebuild (initial load, filter change, search change)
    list.innerHTML = '';
    items.slice(0, 35).forEach((item, i) => {
      list.appendChild(buildFeedItem(item, i === 0 && isNewItem));
    });
  }

  function renderStats() {
    setText('ts-rate', perMinute.length);
    if (!window.AZIMUTH_REALSTATS) {
      setText('ts-total',     totalCount.toLocaleString());
      setText('ts-countries', Object.keys(attackerMap).length);
      setText('r-unique',     uniqueIPs.size);
    }
  }

  function renderLeaderboard(dataMap, containerId, barCls, cntCls) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const sorted = Object.entries(dataMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max    = sorted[0] ? sorted[0][1] : 1;
    el.innerHTML = sorted.map(([country, count], i) => `
      <div class="attacker-row">
        <span class="att-rank">${i + 1}</span>
        <span class="att-flag">${FLAGS[country] || '🌐'}</span>
        <span class="att-country">${country}</span>
        <div class="att-bar-wrap">
          <div class="${barCls}" style="width:${Math.round(count / max * 100)}%"></div>
        </div>
        <span class="${cntCls}">${count}</span>
      </div>`).join('');
  }

  function renderTopFamilies() {
    const el = document.getElementById('top-families');
    if (!el) return;
    const sorted = Object.entries(familyMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = sorted[0] ? sorted[0][1] : 1;
    el.innerHTML = sorted.map(([family, count], i) => `
      <div class="attacker-row">
        <span class="att-rank">${i + 1}</span>
        <span class="att-country fam-name">${family}</span>
        <div class="att-bar-wrap">
          <div class="tgt-bar" style="width:${Math.round(count / max * 100)}%"></div>
        </div>
        <span class="tgt-count">${count}</span>
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
    const srcTypes = feedItems.filter(f => f.src === country).map(f => f.type);
    let topThreat = null;
    if (srcTypes.length) {
      const freq = {};
      srcTypes.forEach(t => { freq[t] = (freq[t] || 0) + 1; });
      topThreat = TYPES[Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]].label;
    }
    return { out: attackerMap[country] || 0, in: targetMap[country] || 0, topThreat };
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
  function ageStr(first_seen) {
    if (!first_seen) return '';
    const d = new Date(first_seen);
    if (isNaN(d)) return '';
    const days = Math.floor((Date.now() - d) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return '1d ago';
    if (days < 30)  return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
  }

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
    // Reset and rebuild from the authoritative dataset on every poll
    attackerMap = {};
    targetMap   = {};
    familyMap   = {};
    typeMap     = {};
    events.forEach(e => {
      if (e.src)    attackerMap[e.src]    = (attackerMap[e.src]    || 0) + 1;
      if (e.tgt)    targetMap[e.tgt]      = (targetMap[e.tgt]      || 0) + 1;
      if (e.family) familyMap[e.family]   = (familyMap[e.family]   || 0) + 1;
      if (e.type)   typeMap[e.type]       = (typeMap[e.type]       || 0) + 1;
    });
    renderLeaderboard(attackerMap, 'attackers', 'att-bar', 'att-count');
    renderLeaderboard(targetMap,   'targets',   'att-bar tgt-bar', 'att-count tgt-count');
    renderTopFamilies();
    if (window.AzimuthMap) window.AzimuthMap.invalidateHeat();
  }

  function getTopCounterparts(country, filterField, countField) {
    const counts = {};
    feedItems.filter(f => f[filterField] === country).forEach(f => {
      counts[f[countField]] = (counts[f[countField]] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  function getTopTargetsOf(country) { return getTopCounterparts(country, 'src', 'tgt'); }
  function getTopSourcesOf(country) { return getTopCounterparts(country, 'tgt', 'src'); }

  function getTypeBreakdownOf(country) {
    const counts = {};
    feedItems.filter(f => f.src === country).forEach(f => {
      counts[f.type] = (counts[f.type] || 0) + 1;
    });
    return counts;
  }

  function getMinuteHistory() { return minuteHistory; }
  function getTypeMap()      { return { ...typeMap }; }

  return { addEvent, ingestBatch, setFilter, setSearch, getCountryStats, getAttackerMap, getAllEvents, getTimeline, getMinuteHistory, getTargetMap: () => targetMap, getTopTargetsOf, getTopSourcesOf, getTypeBreakdownOf, getTypeMap, getFamilyMap: () => ({ ...familyMap }) };
})();

document.getElementById('feed-list').addEventListener('click', e => {
  const el = e.target.closest('[data-country]');
  if (el && window.AzimuthDrawer) window.AzimuthDrawer.open(el.dataset.country);
});
