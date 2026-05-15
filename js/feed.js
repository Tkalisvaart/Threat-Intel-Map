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
  let uniqueIPs    = new Set();
  let totalCount   = 0;
  let perMinute    = [];  // timestamps for rate calc
  let minuteHistory = []; // [{min, count, types:{}}] — last 30 minutes
  let activeFilter = 'all';
  let activeSearch = '';

  /* ── Public: ingest an attack event ───────────────────────── */
  function addEvent(attack, countStats = true) {
    const ip       = attack.ip || '';
    const now      = Date.now();
    const typeInfo = TYPES[attack.type];

    if (countStats) {
      totalCount++;
      attackerMap[attack.src] = (attackerMap[attack.src] || 0) + 1;
      targetMap[attack.tgt]   = (targetMap[attack.tgt]   || 0) + 1;
      typeMap[attack.type]    = (typeMap[attack.type]    || 0) + 1;
      if (ip) uniqueIPs.add(ip);
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
    const ipEl = item.ip
      ? `<a class="fi-ip-link" href="${vtUrl}" target="_blank" rel="noopener noreferrer" title="Look up on VirusTotal">${item.ip}</a>${portBadge}`
      : `<span class="fi-ip-link fi-ip-agg">Aggregate data</span>`;

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
        ${ipEl}
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

    // Incremental update: prepend one new item with FLIP push-down animation
    if (isNewItem && list.children.length > 0 && items.length > 0) {
      const newItem = items[0];
      if (activeFilter === 'all' || newItem.type === activeFilter) {
        // FLIP: snapshot positions of items that will shift down
        const shifting = Array.from(list.children).slice(0, 14);
        const tops = shifting.map(el => el.getBoundingClientRect().top);

        list.insertBefore(buildFeedItem(newItem, true), list.firstChild);

        // Snap each item back to its old screen position, then animate down
        shifting.forEach((el, i) => {
          const dy = el.getBoundingClientRect().top - tops[i];
          if (!dy) return;
          el.style.transition = 'none';
          el.style.transform  = `translateY(${-dy}px)`;
        });

        void list.offsetHeight; // force reflow

        shifting.forEach(el => {
          el.style.transition = 'transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)';
          el.style.transform  = '';
        });

        setTimeout(() => shifting.forEach(el => {
          el.style.transform  = '';
          el.style.transition = '';
        }), 380);

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
    if (!window.AZIMUTH_REALSTATS) {
      setText('ts-total',     totalCount.toLocaleString());
      setText('ts-countries', Object.keys(attackerMap).length);
      setText('r-unique',     uniqueIPs.size);
    }
  }

  function renderLeaderboard(dataMap, containerId, barCls, cntCls) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const sorted = Object.entries(dataMap).sort((a, b) => b[1] - a[1]).slice(0, 15);
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
    typeMap     = {};
    events.forEach(e => {
      if (e.src)  attackerMap[e.src]  = (attackerMap[e.src]  || 0) + 1;
      if (e.tgt)  targetMap[e.tgt]    = (targetMap[e.tgt]    || 0) + 1;
      if (e.type) typeMap[e.type]     = (typeMap[e.type]     || 0) + 1;
    });
    renderLeaderboard(attackerMap, 'attackers', 'att-bar', 'att-count');
    renderLeaderboard(targetMap,   'targets',   'att-bar tgt-bar', 'att-count tgt-count');
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

  return { addEvent, ingestBatch, setFilter, setSearch, getCountryStats, getAttackerMap, getAllEvents, getTimeline, getMinuteHistory, getTargetMap: () => targetMap, getTopTargetsOf, getTopSourcesOf, getTypeBreakdownOf, getTypeMap };
})();

document.getElementById('feed-list').addEventListener('click', e => {
  const el = e.target.closest('[data-country]');
  if (el && window.AzimuthDrawer) window.AzimuthDrawer.open(el.dataset.country);
});
