# Azimuth — Cyber Threat Intelligence Map

A real-time threat intelligence dashboard that pulls live IOC data from five public
threat feeds, geolocates the source IPs, and visualises the attacks as animated arcs
on an interactive globe or flat map. Runs entirely as a static site — no backend, no
build step, no API keys required to get started.

---

## Features

- **Live threat feeds** — Feodo Tracker, OpenPhish, Blocklist.de, Emerging Threats,
  and (optionally) AbuseIPDB refresh every hour via GitHub Actions
- **Globe & flat map** — drag-rotatable orthographic globe or Natural Earth projection,
  switchable at runtime
- **Attack arcs** — animated great-circle arcs colour-coded by threat type with
  impact pulse rings on landing
- **Heatmap** — radial glow overlay showing attack origin and target density
- **Attack feed** — live event stream with real malicious IPs, malware family names,
  and one-click VirusTotal lookups
- **Country detail drawer** — click any city dot or country name to see attack counts,
  type breakdown, top targets, and recent indicators for that country
- **Search** — filter the feed by IP address, country, family name, or threat type
- **24-hour history chart** — stacked bar chart of attack-type distribution across the
  last 24 hourly data refreshes, persisted in localStorage
- **Export** — PNG snapshot or CSV download of the current feed

---

## Data Flow

```
┌────────────────────────────────────────────────────────────────┐
│                   GitHub Actions  (hourly cron)                │
│                                                                │
│  Feodo Tracker ─────────────────────────────────────────────┐  │
│  (banking trojan C2 IPs)          has country code          │  │
│                                                             │  │
│  OpenPhish ──→ parallel DNS ──────────────────────────────  │  │
│  (phishing URLs)   resolve domains to IPs                   │  │
│                                                             ▼  │
│  Blocklist.de ──────────────────────────────────── ip-api.com  │
│  (ssh / apache / bots / bruteforce / mail)          batch geo  │
│                                                      (100/req) │
│  Emerging Threats ──────────────────────────────────────────┘  │
│  (compromised hosts)                                           │
│                                                                │
│  AbuseIPDB ── (optional: set ABUSEIPDB_KEY secret)             │
│  (high-confidence blacklist, categories→types)  ← country      │
│                       code in response, no geolocation needed  │
│                                                                │
│              writes  data/iocs.json                            │
│  [{src, tgt, type, ip, family, first_seen}, ...]               │
└───────────────────────┬────────────────────────────────────────┘
                        │  git commit + push
                        ▼
               ┌─────────────────┐
               │  GitHub Pages   │  (static hosting, auto-deployed)
               └────────┬────────┘
                        │  fetch every 60s (If-Modified-Since)
                        │  → 304 Not Modified = skip, saves bandwidth
                        ▼
               ┌──────────────────────────────────────────────────┐
               │                    Browser                       │
               │                                                  │
               │  pollRealFeed()                                  │
               │   ├── setRealFeedStats()  → right panel stats    │
               │   ├── saveHistorySnapshot() → localStorage       │
               │   └── drip 60 events over 55s via spawnAttack()  │
               │           │                                      │
               │    ┌──────┴──────┐                               │
               │    ▼             ▼                               │
               │  map.js       feed.js                            │
               │  addArc()     addEvent()                         │
               │  heatmap      feed list + leaderboards           │
               │  globe/flat   country drawer                     │
               └──────────────────────────────────────────────────┘
```

**Threat types and their sources:**

| Type | Source feed | Severity |
|------|-------------|----------|
| `c2` | Feodo Tracker (Emotet, QakBot, IcedID…) | CRITICAL |
| `exploit` | Blocklist.de apache, AbuseIPDB categories 15/16/20/21 | CRITICAL |
| `malware` | Blocklist.de mail, Emerging Threats, AbuseIPDB | CRITICAL |
| `phishing` | OpenPhish (DNS-resolved), AbuseIPDB category 7 | HIGH |
| `ddos` | Blocklist.de bots, AbuseIPDB category 4 | HIGH |
| `recon` | Blocklist.de ssh/bruteforce, AbuseIPDB categories 5/14/18/22 | MEDIUM |

---

## Code Structure

```
azimuth/
├── index.html                  # App shell — grid layout, all HTML panels
├── serve.py                    # Local dev server (static files only)
├── css/
│   └── style.css               # All styles; CSS custom properties in :root
├── js/
│   ├── data.js                 # Static lookup tables (GEO, FLAGS, TYPES, SCENARIOS)
│   ├── map.js                  # Map/globe renderer
│   ├── feed.js                 # Feed + stats rendering
│   └── app.js                  # Orchestration, poll loop, drawer, history
├── scripts/
│   └── fetch_iocs.py           # Data fetcher (run by GitHub Actions)
├── data/
│   └── iocs.json               # Live output — committed each hour by Actions
└── .github/
    └── workflows/
        ├── fetch-intel.yml     # Hourly data refresh
        └── deploy.yml          # GitHub Pages deploy on push
```

### `js/data.js`
Pure static data — no logic. Defines three lookup tables used everywhere:
- `GEO` — `{country: [lon, lat]}` for ~70 countries; controls where arcs originate/land
- `FLAGS` — country → emoji flag string
- `TYPES` — threat type metadata: display label, arc colour, CSS class, severity
- `SCENARIOS` — fallback simulation events used when the live feed is unavailable

### `js/map.js`
Dual-canvas renderer wrapping D3.

**Two canvases:**
- `#map-bg` (bgCanvas) — persistent globe background, only redrawn when the rotation
  changes. Draws the ocean sphere, country fills, and borders via `d3.geoPath`.
- `#map-canvas` (canvas) — cleared every animation frame. Draws arcs, heatmap blobs,
  particles, and pulse rings.

**Arc lifecycle:** `addArc()` pushes an arc object with `progress=0`. The `frame()`
loop increments `progress` each tick. Points along the arc are computed as a quadratic
Bézier (flat map) or great-circle interpolation (globe). At `progress ≥ 0.97` an
impact pulse ring is spawned at the target. Arcs fade out over `ttl` milliseconds then
are garbage-collected.

**Heatmap:** Country weights from `attackerMap` and `targetMap` are rendered as radial
gradients — red for attack origins, cyan for targets. An offscreen canvas caches the
result and is only redrawn every 800ms (flat map). In globe mode the cache is skipped
because the projection changes every frame with auto-rotation.

**Globe drag:** Mouse/touch delta is converted to rotation angles. A 4-second idle
timer re-enables auto-rotation after a drag ends.

### `js/feed.js`
Manages all runtime state for the panels. On every `addEvent()` call it updates
five counters (`attackerMap`, `targetMap`, `typeMap`, `critCount`…) then re-renders
the four panel sections: feed list, stats bar, top attackers, top targets, and
type-breakdown bars.

**Search:** `activeSearch` is applied as a second filter pass after the type filter.
Matches against IP, src country, tgt country, family name, and type string.

**Country queries:** `getCountryStats()`, `getTopTargetsOf()`, `getTopSourcesOf()`,
and `getTypeBreakdownOf()` are called by the drawer in `app.js` to populate the
country detail panel on demand.

### `js/app.js`
Orchestration layer. Responsibilities:

- **Clock + uptime** — 1s interval ticking the topbar clock and session timer.
- **Simulation loop** — `scheduleNext()` fires `spawnAttack()` every 0.7–2s using
  the hardcoded `SCENARIOS` array. This keeps the map active before live data loads
  and in the fallback case.
- **Live feed poll** — `pollRealFeed()` fetches `data/iocs.json` with
  `If-Modified-Since` every 60 seconds. On a successful (non-304) response it calls
  `setRealFeedStats()` (populates the panel with real counts), `saveHistorySnapshot()`
  (writes a timestamped snapshot to localStorage), then drip-feeds up to 60 randomly
  sampled events over 55 seconds to animate naturally.
- **24h history** — `drawHistory()` reads `azimuth_24h` from localStorage and renders
  a stacked bar chart on `#history-canvas`. Each bar represents one hourly data load;
  bar segments are colour-coded by threat type.
- **Country drawer** — `AzimuthDrawer.open(country)` is called when a city dot is
  clicked on the map or a country name is clicked in the feed. Populates and slides in
  the `#country-drawer` panel.

### `scripts/fetch_iocs.py`
Run by GitHub Actions every hour. Fetches all five threat feeds in sequence, maps each
IP to a source country (either from the feed's built-in country code or via
`ip-api.com/batch` geolocation in chunks of 100), then for each matched IP emits 2–7
events amplifying the raw indicator count to better reflect victim scale. Each event
carries `{src, tgt, type, ip, family, first_seen}`. The output is written atomically
to `data/iocs.json` and committed.

AbuseIPDB (when enabled via `ABUSEIPDB_KEY`) uses the `/v2/blacklist?verbose` endpoint
which returns country codes directly, so no geolocation round-trip is needed for those
entries.

---

## Quick Start

```bash
python3 serve.py
```

Open [http://localhost:8080](http://localhost:8080). The site loads `data/iocs.json`
directly from the filesystem — no proxy needed. The local copy is refreshed hourly by
GitHub Actions when deployed; run `python3 scripts/fetch_iocs.py` manually to update
it locally.

---

## API Key (optional)

One optional API key unlocks the AbuseIPDB feed:

| Key | Where to get it | Where to add it |
|-----|-----------------|-----------------|
| `ABUSEIPDB_KEY` | [abuseipdb.com](https://www.abuseipdb.com) — free account, 1 000 checks/day | GitHub repo → Settings → Secrets → Actions → `ABUSEIPDB_KEY` |

Without the key the other four feeds still run and produce ~1 200+ events per refresh.

---

## Customization

| What | Where |
|------|-------|
| Colours / theme | `css/style.css` `:root` variables |
| Add a country | `js/data.js` → `GEO` and `FLAGS`; `scripts/fetch_iocs.py` → `ISO_TO_COUNTRY` |
| Add an attack type | `js/data.js` → `TYPES`; add a `TARGETS` entry in `fetch_iocs.py` |
| Spawn rate (simulation) | `js/app.js` → `scheduleNext()` delay range |
| Max concurrent arcs | `js/map.js` → `MAX_ARCS` |
| Feed history length | `js/feed.js` → `MAX_FEED` |
| Data refresh interval | `.github/workflows/fetch-intel.yml` → cron schedule |
| Poll interval (browser) | `js/app.js` → `setInterval(pollRealFeed, 60_000)` |

---

## Inject custom events

The frontend exposes `window.Azimuth` for programmatic event injection:

```javascript
// Single event — src/tgt must be keys in AZIMUTH_DATA.GEO
window.Azimuth.ingest({ src: 'Russia', tgt: 'Germany', type: 'phishing' });

// Playback controls
window.Azimuth.pause();
window.Azimuth.resume();
window.Azimuth.clear();
```

---

## Deploying to GitHub Pages

Push to `main` — the included workflow deploys automatically. In your repo settings →
**Pages** → set Source to **GitHub Actions**. The hourly `fetch-intel.yml` workflow
then keeps `data/iocs.json` fresh on the deployed site.

---

## Dependencies (CDN, no install)

| Library | Purpose |
|---------|---------|
| [D3.js v7](https://d3js.org) | Map projection, geo math, great-circle interpolation |
| [TopoJSON v3](https://github.com/topojson/topojson) | Decoding world topology |
| [world-atlas v2](https://github.com/topojson/world-atlas) | Country shape data |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Monospace UI font |
| [Syne](https://fonts.google.com/specimen/Syne) | Display / heading font |

---

## License

MIT — use freely, attribution appreciated.
