# Azimuth — Cyber Threat Intelligence Map

A real-time threat intelligence visualization dashboard powered by live Abuse.ch ThreatFox data.
No build step required.

---

## Quick Start

```bash
python3 serve.py
```

Open http://localhost:8080

The server handles everything: static files, ThreatFox polling, and IP geolocation.
Real IOCs appear on the map within seconds of starting. The simulation runs alongside
real data, so the map stays active even if the feed is temporarily unavailable.

---

## How the Live Feed Works

```
Browser → GET /api/iocs → serve.py → ThreatFox API  (get today's IOCs)
                                    → ip-api.com/batch (geolocate all IPs)
                                    ← [{src, tgt, type}, ...]
         drip-feed events over 55s
         poll again every 60s
```

`serve.py` acts as a proxy so the browser never hits external APIs directly (which
would fail due to CORS). Results are cached for 60 seconds server-side, so page
refreshes don't re-hit the upstream APIs.

You can confirm real data is flowing by opening the browser console — you'll see:

```
[ThreatFox] 34 real events queued
```

---

## API Endpoint

### `GET /api/iocs`

Returns the latest batch of geolocated threat events, ready to ingest.

**Response**

```json
[
  { "src": "China",  "tgt": "United States", "type": "malware"  },
  { "src": "Russia", "tgt": "Germany",       "type": "c2"       },
  ...
]
```

| Field  | Type   | Values |
|--------|--------|--------|
| `src`  | string | Country name — must be a key in `js/data.js` `GEO` |
| `tgt`  | string | Country name — must be a key in `js/data.js` `GEO` |
| `type` | string | `malware` · `ddos` · `phishing` · `recon` · `c2` · `exploit` |

**Cache:** 60 seconds. Upstream sources: Abuse.ch ThreatFox, ip-api.com batch.

---

## Public JavaScript API

The frontend exposes `window.Azimuth` for injecting events programmatically.

```javascript
// Inject a single event
window.Azimuth.ingest({ src: 'China', tgt: 'United States', type: 'malware' });

// Playback controls
window.Azimuth.pause();
window.Azimuth.resume();
window.Azimuth.clear();   // remove all arcs from the map
```

`src` and `tgt` must match keys in `AZIMUTH_DATA.GEO` (`js/data.js`).
Unknown countries are silently dropped.

### Connecting a different feed

Poll any CTI source and call `Azimuth.ingest()` for each event:

```javascript
// Example: AlienVault OTX
const OTX_KEY = 'YOUR_FREE_KEY'; // register at otx.alienvault.com

async function pollOTX() {
  const res  = await fetch('https://otx.alienvault.com/api/v1/pulses/subscribed?limit=20', {
    headers: { 'X-OTX-API-KEY': OTX_KEY },
  });
  const data = await res.json();
  // extract indicators, geolocate, then:
  window.Azimuth.ingest({ src: 'Russia', tgt: 'Germany', type: 'phishing' });
}

setInterval(pollOTX, 60_000);
```

```javascript
// Example: CrowdSec CTI (50 queries/day free — app.crowdsec.net)
async function checkIP(ip) {
  const res = await fetch(`https://cti.api.crowdsec.net/v2/smoke/${ip}`, {
    headers: { 'x-api-key': 'YOUR_KEY' },
  });
  return res.json();
}
```

---

## File Structure

```
azimuth/
├── index.html                    # App shell + layout
├── serve.py                      # Dev server + /api/iocs proxy
├── css/
│   └── style.css                 # All styles (JetBrains Mono + Syne fonts)
├── js/
│   ├── data.js                   # Geo data, flags, attack type definitions
│   ├── map.js                    # D3 Natural Earth map + Canvas arc renderer
│   ├── feed.js                   # Feed list, stats, leaderboard rendering
│   └── app.js                    # Orchestration, simulation loop, public API
└── .github/
    └── workflows/deploy.yml      # GitHub Pages auto-deploy
```

---

## Customization

| What | Where |
|------|-------|
| Colors / theme | `css/style.css` `:root` variables |
| Add a country | `js/data.js` → `GEO` and `FLAGS`, then `serve.py` → `KNOWN_COUNTRIES` |
| Add attack types | `js/data.js` → `TYPES` |
| Adjust spawn rate | `js/app.js` → `scheduleNext()` delay |
| Max concurrent arcs | `js/map.js` → `MAX_ARCS` |
| Feed history length | `js/feed.js` → `MAX_FEED` |
| ThreatFox poll interval | `js/app.js` → `setInterval(pollRealFeed, ...)` |
| Backend cache TTL | `serve.py` → `CACHE_TTL` |

---

## Deploying to GitHub Pages

Static hosting serves the simulation only (no backend, no real data).
The frontend detects the missing `/api/iocs` endpoint and falls back gracefully.

Push to `main` — the included GitHub Actions workflow deploys automatically.
In your repo settings → **Pages** → set Source to **GitHub Actions**.

---

## Dependencies (loaded from CDN, no install)

- [D3.js v7](https://d3js.org) — map projection + geo math
- [TopoJSON v3](https://github.com/topojson/topojson) — world topology
- [world-atlas v2](https://github.com/topojson/world-atlas) — country shapes
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) — monospace font
- [Syne](https://fonts.google.com/specimen/Syne) — display font

---

## License

MIT — use freely, attribution appreciated.
