window.AzimuthFeed = (() => {
  const { TYPES, FLAGS } = window.AZIMUTH_DATA;

  const MAX_FEED = 80;

  let feedItems    = [];
  let attackerMap  = {};
  let targetMap    = {};
  let typeMap      = {};
  let uniqueIPs    = new Set();
  let totalCount   = 0;
  let perMinute    = [];
  let minuteHistory = [];

  function addEvent(attack, countStats = true) {
    const ip  = attack.ip || '';
    const now = Date.now();

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
    const last   = minuteHistory[minuteHistory.length - 1];
    if (last && last.min === minKey) {
      last.count++;
      last.types[attack.type] = (last.types[attack.type] || 0) + 1;
    } else {
      minuteHistory.push({ min: minKey, count: 1, types: { [attack.type]: 1 } });
      if (minuteHistory.length > 30) minuteHistory.shift();
    }

    feedItems.unshift({
      src: attack.src, tgt: attack.tgt, type: attack.type,
      ip, time: timeStr(),
      family:     attack.family     || '',
      first_seen: attack.first_seen || '',
      asn:        attack.asn        || '',
      lat:        attack.lat        || 0,
      lon:        attack.lon        || 0,
    });
    if (feedItems.length > MAX_FEED) feedItems.pop();

    renderFeed(true);
    if (countStats) {
      renderStats();
      renderLeaderboard(attackerMap, 'attackers', 'att-bar',         'att-count');
      renderLeaderboard(targetMap,   'targets',   'att-bar tgt-bar', 'att-count tgt-count');
    }
  }

  function buildFeedItem(item) {
    const t        = TYPES[item.type];
    const age      = ageStr(item.first_seen);
    const asnShort = item.asn ? item.asn.split(' ').slice(0, 2).join(' ') : '';

    const div = document.createElement('div');
    div.className = 'feed-item t-' + item.type + '-row';

    const ipEl = item.ip
      ? `<a class="fi-ip-link" href="https://www.virustotal.com/gui/ip-address/${item.ip}" target="_blank" rel="noopener noreferrer" title="Look up on VirusTotal">${item.ip}</a>`
      : `<span class="fi-ip-link fi-ip-agg">Aggregate data</span>`;

    div.innerHTML = `
      <div class="fi-top">
        <span class="fi-type ${t.cls}">${t.label}</span>
        <span class="fi-src" data-country="${item.src}" role="button">${item.src}</span>
        <span class="fi-arr">→</span>
        <span class="fi-tgt" data-country="${item.tgt}" role="button">${item.tgt}</span>
        ${age ? `<span class="fi-time">${age}</span>` : ''}
      </div>
      <div class="fi-bot">
        ${ipEl}
        ${item.family ? `<span class="fi-family">${item.family}</span>` : ''}
        ${asnShort    ? `<span class="fi-asn" title="${item.asn}">${asnShort}</span>` : ''}
      </div>`;
    return div;
  }

  /* ── Smooth scroll drive ────────────────────────────────────── */
  let _cachedItemH = 0;
  let _scrollPos   = 0;
  let _scrollRaf   = null;
  let _scrollTs    = null;
  let _scrollRate  = 0;

  function driveScroll(list) {
    if (_scrollRaf) return;
    _scrollTs = null;
    function step(ts) {
      if (_scrollTs === null) { _scrollTs = ts; _scrollRaf = requestAnimationFrame(step); return; }
      const dt = Math.min(ts - _scrollTs, 50); // clamp for tab-switch spikes
      _scrollTs = ts;
      _scrollPos = Math.max(0, _scrollPos - dt * _scrollRate);
      list.scrollTop = _scrollPos;
      if (_scrollPos > 0) { _scrollRaf = requestAnimationFrame(step); }
      else                { _scrollPos = 0; _scrollRaf = null; }
    }
    _scrollRaf = requestAnimationFrame(step);
  }

  function renderFeed(isNewItem = false) {
    const list = document.getElementById('feed-list');

    if (isNewItem && feedItems.length > 0) {
      const el = buildFeedItem(feedItems[0]);
      list.insertBefore(el, list.firstChild);
      if (!_cachedItemH) _cachedItemH = el.offsetHeight || 52; // measure once
      _scrollPos += _cachedItemH;
      list.scrollTop = _scrollPos;
      _scrollRate = _cachedItemH / 330; // drain in ~330ms
      driveScroll(list);
      while (list.children.length > 35) list.lastChild.remove();
      return;
    }

    // Full rebuild
    list.innerHTML = '';
    _scrollPos = 0;
    feedItems.slice(0, 35).forEach(item => list.appendChild(buildFeedItem(item)));
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

  function getTopCounterparts(country, filterField, countField) {
    const counts = {};
    feedItems.filter(f => f[filterField] === country).forEach(f => {
      counts[f[countField]] = (counts[f[countField]] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  function ingestBatch(events) {
    attackerMap = {};
    targetMap   = {};
    typeMap     = {};
    events.forEach(e => {
      if (e.src)  attackerMap[e.src]  = (attackerMap[e.src]  || 0) + 1;
      if (e.tgt)  targetMap[e.tgt]    = (targetMap[e.tgt]    || 0) + 1;
      if (e.type) typeMap[e.type]     = (typeMap[e.type]     || 0) + 1;
    });
    renderLeaderboard(attackerMap, 'attackers', 'att-bar',         'att-count');
    renderLeaderboard(targetMap,   'targets',   'att-bar tgt-bar', 'att-count tgt-count');
    if (window.AzimuthMap) window.AzimuthMap.invalidateHeat();
  }

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
  function pad(n)        { return String(n).padStart(2, '0'); }
  function setText(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }

  return {
    addEvent,
    ingestBatch,
    getCountryStats,
    getAttackerMap:      () => attackerMap,
    getTargetMap:        () => targetMap,
    getAllEvents:         () => [...feedItems],
    getMinuteHistory:    () => minuteHistory,
    getTopTargetsOf:     c  => getTopCounterparts(c, 'src', 'tgt'),
    getTopSourcesOf:     c  => getTopCounterparts(c, 'tgt', 'src'),
    getTypeBreakdownOf:  country => {
      const counts = {};
      feedItems.filter(f => f.src === country).forEach(f => {
        counts[f.type] = (counts[f.type] || 0) + 1;
      });
      return counts;
    },
  };
})();

document.getElementById('feed-list').addEventListener('click', e => {
  const el = e.target.closest('[data-country]');
  if (el && window.AzimuthDrawer) window.AzimuthDrawer.open(el.dataset.country);
});
