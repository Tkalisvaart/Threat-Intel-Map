#!/usr/bin/env python3
"""
Fetch attack data from Cloudflare Radar API and write data/iocs.json + data/cf_meta.json.
Run by GitHub Actions on a schedule.
"""
import json
import os
import random
import time
import urllib.request
import urllib.parse
from pathlib import Path

_ROOT      = Path(__file__).parent.parent
_IOCS_FILE = _ROOT / 'data' / 'iocs.json'
_META_FILE = _ROOT / 'data' / 'cf_meta.json'

CF_TOKEN = os.environ.get('CF_TOKEN', '')
CF_BASE  = 'https://api.cloudflare.com/client/v4/radar'

ISO_TO_COUNTRY = {
    'CN': 'China',          'US': 'United States', 'RU': 'Russia',
    'BR': 'Brazil',         'IN': 'India',         'DE': 'Germany',
    'NL': 'Netherlands',    'FR': 'France',        'GB': 'United Kingdom',
    'KR': 'South Korea',    'JP': 'Japan',         'UA': 'Ukraine',
    'VN': 'Vietnam',        'IR': 'Iran',          'TR': 'Turkey',
    'ID': 'Indonesia',      'MX': 'Mexico',        'PK': 'Pakistan',
    'NG': 'Nigeria',        'ZA': 'South Africa',  'AU': 'Australia',
    'CA': 'Canada',         'AR': 'Argentina',     'EG': 'Egypt',
    'RO': 'Romania',        'BG': 'Bulgaria',      'PL': 'Poland',
    'KP': 'North Korea',    'BY': 'Belarus',       'IL': 'Israel',
    'HK': 'Hong Kong',      'SG': 'Singapore',     'TW': 'Taiwan',
    'TH': 'Thailand',       'MY': 'Malaysia',      'PH': 'Philippines',
    'CZ': 'Czech Republic', 'HU': 'Hungary',       'RS': 'Serbia',
    'MD': 'Moldova',        'KZ': 'Kazakhstan',    'LT': 'Lithuania',
    'LV': 'Latvia',         'EE': 'Estonia',       'FI': 'Finland',
    'SE': 'Sweden',         'NO': 'Norway',        'DK': 'Denmark',
    'ES': 'Spain',          'PT': 'Portugal',      'IT': 'Italy',
    'GR': 'Greece',         'CH': 'Switzerland',   'AT': 'Austria',
    'BE': 'Belgium',        'CL': 'Chile',         'CO': 'Colombia',
    'PE': 'Peru',           'VE': 'Venezuela',     'SA': 'Saudi Arabia',
    'AE': 'UAE',            'MA': 'Morocco',       'DZ': 'Algeria',
    'BD': 'Bangladesh',     'LK': 'Sri Lanka',     'MM': 'Myanmar',
    'NP': 'Nepal',          'SK': 'Slovakia',      'HR': 'Croatia',
    'AZ': 'Azerbaijan',     'GE': 'Georgia',       'AM': 'Armenia',
    'UZ': 'Uzbekistan',     'KE': 'Kenya',         'TZ': 'Tanzania',
    'ET': 'Ethiopia',       'GH': 'Ghana',         'CI': 'Ivory Coast',
    'CM': 'Cameroon',       'AO': 'Angola',        'MZ': 'Mozambique',
    'ZW': 'Zimbabwe',       'ZM': 'Zambia',        'UG': 'Uganda',
    'RW': 'Rwanda',         'SD': 'Sudan',         'CD': 'DR Congo',
    'SN': 'Senegal',        'LY': 'Libya',         'TN': 'Tunisia',
    'SO': 'Somalia',        'NA': 'Namibia',       'BW': 'Botswana',
    'MG': 'Madagascar',     'ML': 'Mali',          'MW': 'Malawi',
    'BF': 'Burkina Faso',   'NE': 'Niger',         'TG': 'Togo',
    'BJ': 'Benin',          'GN': 'Guinea',        'MU': 'Mauritius',
    'IQ': 'Iraq',           'SY': 'Syria',         'JO': 'Jordan',
    'KW': 'Kuwait',         'QA': 'Qatar',         'BH': 'Bahrain',
    'OM': 'Oman',           'LB': 'Lebanon',       'YE': 'Yemen',
    'PS': 'Palestine',      'AF': 'Afghanistan',   'KG': 'Kyrgyzstan',
    'TJ': 'Tajikistan',     'TM': 'Turkmenistan',  'KH': 'Cambodia',
    'LA': 'Laos',           'MN': 'Mongolia',      'AL': 'Albania',
    'BA': 'Bosnia',         'MK': 'North Macedonia','ME': 'Montenegro',
    'IS': 'Iceland',        'LU': 'Luxembourg',    'MT': 'Malta',
    'CY': 'Cyprus',         'IE': 'Ireland',       'SI': 'Slovenia',
    'BO': 'Bolivia',        'EC': 'Ecuador',       'PY': 'Paraguay',
    'UY': 'Uruguay',        'CU': 'Cuba',          'DO': 'Dominican Republic',
    'HN': 'Honduras',       'GT': 'Guatemala',     'SV': 'El Salvador',
    'CR': 'Costa Rica',     'PA': 'Panama',        'NI': 'Nicaragua',
    'GY': 'Guyana',         'TT': 'Trinidad and Tobago', 'JM': 'Jamaica',
    'HT': 'Haiti',          'NZ': 'New Zealand',   'PG': 'Papua New Guinea',
    'FJ': 'Fiji',
}

CENTROIDS = {
    'China':               ( 35.86,  104.19),
    'United States':       ( 37.09,  -95.71),
    'Russia':              ( 61.52,  105.31),
    'Brazil':              (-14.24,  -51.93),
    'India':               ( 20.59,   78.96),
    'Germany':             ( 51.16,   10.45),
    'Netherlands':         ( 52.13,    5.29),
    'France':              ( 46.23,    2.21),
    'United Kingdom':      ( 55.38,   -3.44),
    'South Korea':         ( 35.91,  127.77),
    'Japan':               ( 36.20,  138.25),
    'Ukraine':             ( 48.38,   31.17),
    'Vietnam':             ( 14.06,  108.28),
    'Iran':                ( 32.43,   53.69),
    'Turkey':              ( 38.96,   35.24),
    'Indonesia':           ( -0.79,  113.92),
    'Mexico':              ( 23.63, -102.55),
    'Pakistan':            ( 30.38,   69.35),
    'Nigeria':             (  9.08,    8.68),
    'South Africa':        (-30.56,   22.94),
    'Australia':           (-25.27,  133.78),
    'Canada':              ( 56.13, -106.35),
    'Argentina':           (-38.42,  -63.62),
    'Egypt':               ( 26.82,   30.80),
    'Romania':             ( 45.94,   24.97),
    'Bulgaria':            ( 42.73,   25.49),
    'Poland':              ( 51.92,   19.14),
    'North Korea':         ( 40.34,  127.51),
    'Belarus':             ( 53.71,   27.95),
    'Israel':              ( 31.05,   34.85),
    'Hong Kong':           ( 22.40,  114.11),
    'Singapore':           (  1.35,  103.82),
    'Taiwan':              ( 23.70,  120.96),
    'Thailand':            ( 15.87,  100.99),
    'Malaysia':            (  4.21,  101.98),
    'Philippines':         ( 12.88,  121.77),
    'Czech Republic':      ( 49.82,   15.47),
    'Hungary':             ( 47.16,   19.50),
    'Serbia':              ( 44.02,   21.01),
    'Moldova':             ( 47.41,   28.37),
    'Kazakhstan':          ( 48.02,   66.92),
    'Lithuania':           ( 55.17,   23.88),
    'Latvia':              ( 56.88,   24.60),
    'Estonia':             ( 58.60,   25.01),
    'Finland':             ( 61.92,   25.75),
    'Sweden':              ( 60.13,   18.64),
    'Norway':              ( 60.47,    8.47),
    'Denmark':             ( 56.26,    9.50),
    'Spain':               ( 40.46,   -3.75),
    'Portugal':            ( 39.40,   -8.22),
    'Italy':               ( 41.87,   12.57),
    'Greece':              ( 39.07,   21.82),
    'Switzerland':         ( 46.82,    8.23),
    'Austria':             ( 47.52,   14.55),
    'Belgium':             ( 50.50,    4.47),
    'Chile':               (-35.68,  -71.54),
    'Colombia':            (  4.57,  -74.30),
    'Peru':                ( -9.19,  -75.02),
    'Venezuela':           (  6.42,  -66.59),
    'Saudi Arabia':        ( 23.89,   45.08),
    'UAE':                 ( 23.42,   53.85),
    'Morocco':             ( 31.79,   -7.09),
    'Algeria':             ( 28.03,    1.66),
    'Bangladesh':          ( 23.68,   90.36),
    'Sri Lanka':           (  7.87,   80.77),
    'Myanmar':             ( 21.91,   95.96),
    'Nepal':               ( 28.39,   84.12),
    'Slovakia':            ( 48.67,   19.70),
    'Croatia':             ( 45.10,   15.20),
    'Azerbaijan':          ( 40.14,   47.58),
    'Georgia':             ( 42.32,   43.36),
    'Armenia':             ( 40.07,   45.04),
    'Uzbekistan':          ( 41.38,   64.59),
    'Kenya':               ( -0.02,   37.91),
    'Tanzania':            ( -6.37,   34.89),
    'Ethiopia':            (  9.15,   40.49),
    'Ghana':               (  7.95,   -1.02),
    'Ivory Coast':         (  7.54,   -5.55),
    'Cameroon':            (  7.37,   12.35),
    'Angola':              (-11.20,   17.87),
    'Mozambique':          (-18.67,   35.53),
    'Zimbabwe':            (-19.02,   29.15),
    'Zambia':              (-13.13,   27.85),
    'Uganda':              (  1.37,   32.29),
    'Rwanda':              ( -1.94,   29.87),
    'Sudan':               ( 12.86,   30.22),
    'DR Congo':            ( -4.04,   21.76),
    'Senegal':             ( 14.50,  -14.45),
    'Libya':               ( 26.34,   17.23),
    'Tunisia':             ( 33.89,    9.54),
    'Somalia':             (  5.15,   46.20),
    'Namibia':             (-22.96,   18.49),
    'Botswana':            (-22.33,   24.68),
    'Madagascar':          (-18.77,   46.87),
    'Mali':                ( 17.57,   -3.99),
    'Malawi':              (-13.25,   34.30),
    'Burkina Faso':        ( 12.36,   -1.56),
    'Niger':               ( 17.61,    8.08),
    'Togo':                (  8.62,    0.82),
    'Benin':               (  9.31,    2.32),
    'Guinea':              ( 11.75,  -15.74),
    'Mauritius':           (-20.35,   57.55),
    'Iraq':                ( 33.22,   43.68),
    'Syria':               ( 34.80,   38.99),
    'Jordan':              ( 30.59,   36.24),
    'Kuwait':              ( 29.31,   47.48),
    'Qatar':               ( 25.35,   51.18),
    'Bahrain':             ( 26.00,   50.56),
    'Oman':                ( 21.47,   55.98),
    'Lebanon':             ( 33.85,   35.86),
    'Yemen':               ( 15.55,   48.52),
    'Palestine':           ( 31.95,   35.23),
    'Afghanistan':         ( 33.93,   67.71),
    'Kyrgyzstan':          ( 41.20,   74.77),
    'Tajikistan':          ( 38.86,   71.28),
    'Turkmenistan':        ( 38.97,   59.56),
    'Cambodia':            ( 12.57,  104.99),
    'Laos':                ( 19.86,  102.50),
    'Mongolia':            ( 46.86,  103.85),
    'Albania':             ( 41.15,   20.17),
    'Bosnia':              ( 43.92,   17.68),
    'North Macedonia':     ( 41.61,   21.75),
    'Montenegro':          ( 42.71,   19.37),
    'Iceland':             ( 64.96,  -19.02),
    'Luxembourg':          ( 49.82,    6.13),
    'Malta':               ( 35.94,   14.37),
    'Cyprus':              ( 35.13,   33.43),
    'Ireland':             ( 53.41,   -8.24),
    'Slovenia':            ( 46.15,   14.99),
    'Bolivia':             (-16.29,  -63.59),
    'Ecuador':             ( -1.83,  -78.18),
    'Paraguay':            (-23.44,  -58.44),
    'Uruguay':             (-32.52,  -55.77),
    'Cuba':                ( 21.52,  -77.78),
    'Dominican Republic':  ( 18.74,  -70.16),
    'Honduras':            ( 15.20,  -86.24),
    'Guatemala':           ( 15.78,  -90.23),
    'El Salvador':         ( 13.79,  -88.90),
    'Costa Rica':          (  9.75,  -83.75),
    'Panama':              (  8.54,  -80.78),
    'Nicaragua':           ( 12.87,  -85.21),
    'Guyana':              (  4.86,  -58.93),
    'Trinidad and Tobago': ( 10.69,  -61.22),
    'Jamaica':             ( 18.11,  -77.30),
    'Haiti':               ( 18.97,  -72.29),
    'New Zealand':         (-40.90,  174.89),
    'Papua New Guinea':    ( -6.31,  143.96),
    'Fiji':                (-17.71,  178.07),
}

# CF managed rules category → (our attack type, family label)
L7_CAT_MAP = {
    'BOT':          ('recon',    'Bot Traffic'),
    'DOS':          ('ddos',     'HTTP Flood'),
    'HTTP_ANOMALY': ('exploit',  'HTTP Anomaly'),
    'SQLI':         ('exploit',  'SQL Injection'),
    'XSS':          ('exploit',  'Cross-Site Scripting'),
    'RCE':          ('exploit',  'Remote Code Execution'),
    'LFI':          ('exploit',  'Local File Inclusion'),
    'MALWARE':      ('malware',  'Malware Delivery'),
    'PHISHING':     ('phishing', 'Phishing Attack'),
    'CREDENTIAL':   ('c2',       'Credential Stuffing'),
    'BROKEN_AUTH':  ('c2',       'Auth Bypass'),
}

# Human-readable labels for CF Radar vector/protocol keys
L3_VECTOR_LABELS = {
    'UDP_FLOOD':           'UDP Flood',
    'SYN_FLOOD':           'SYN Flood',
    'ACK_FLOOD':           'ACK Flood',
    'TCP_RESET_FLOOD':     'TCP Reset Flood',
    'ICMP_FLOOD':          'ICMP Flood',
    'GRE_FLOOD':           'GRE Flood',
    'DNS_AMPLIFICATION':   'DNS Amplification',
    'NTP_AMPLIFICATION':   'NTP Amplification',
    'SSDP_AMPLIFICATION':  'SSDP Amplification',
    'MEMCACHED_AMPLIFICATION': 'Memcached Amp',
    'CLDAP_AMPLIFICATION': 'CLDAP Amplification',
    'ESP':                 'ESP Flood',
    'UNKNOWN':             'Unknown Vector',
}


def cf_get(path, params=None):
    url = CF_BASE + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {CF_TOKEN}',
        'Content-Type': 'application/json',
        'User-Agent': 'azimuth-threat-map/1.0',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    if not data.get('success'):
        raise RuntimeError(f'{data.get("errors")}')
    return data['result']


def _parse_locations(top_list, iso_key):
    out = []
    for row in top_list:
        iso     = (row.get(iso_key) or '').upper()
        country = ISO_TO_COUNTRY.get(iso)
        if not country:
            continue
        try:
            pct = float(row['value'])
        except (KeyError, ValueError):
            continue
        if pct > 0:
            out.append((country, pct))
    return out


def _parse_summary(summary_dict, label_map=None):
    """Parse a CF summary_0 dict → {label: float_pct}, skipping NONE/UNKNOWN if data exists."""
    out = {}
    for key, val in summary_dict.items():
        try:
            pct = float(val)
        except (TypeError, ValueError):
            continue
        if pct <= 0:
            continue
        label = (label_map or {}).get(key, key.replace('_', ' ').title())
        out[label] = pct
    return out


def fetch_l3():
    origin_r = cf_get('/attacks/layer3/top/locations/origin', {'limit': 20, 'dateRange': '1d'})
    target_r = cf_get('/attacks/layer3/top/locations/target', {'limit': 20, 'dateRange': '1d'})
    origins  = _parse_locations(origin_r.get('top_0', []), 'originCountryAlpha2')
    targets  = _parse_locations(target_r.get('top_0', []), 'targetCountryAlpha2')
    return origins, targets


def fetch_l7():
    origin_r = cf_get('/attacks/layer7/top/locations/origin', {'limit': 20, 'dateRange': '1d'})
    target_r = cf_get('/attacks/layer7/top/locations/target', {'limit': 20, 'dateRange': '1d'})
    origins  = _parse_locations(origin_r.get('top_0', []), 'originCountryAlpha2')
    targets  = _parse_locations(target_r.get('top_0', []), 'targetCountryAlpha2')
    return origins, targets


def fetch_l3_vectors():
    """L3 attack vector breakdown — returns {label: pct} dict."""
    result = cf_get('/attacks/layer3/summary/vector', {'dateRange': '1d'})
    raw = result.get('summary_0', {})
    return _parse_summary(raw, L3_VECTOR_LABELS)


def fetch_l3_protocols():
    """L3 protocol breakdown — returns {label: pct} dict."""
    result = cf_get('/attacks/layer3/summary/protocol', {'dateRange': '1d'})
    raw = result.get('summary_0', {})
    labels = {'UDP': 'UDP', 'TCP': 'TCP', 'ICMP': 'ICMP', 'GRE': 'GRE'}
    return _parse_summary(raw, labels)


def fetch_l7_methods():
    """L7 HTTP method breakdown — returns {label: pct} dict."""
    result = cf_get('/attacks/layer7/summary/http_method', {'dateRange': '1d'})
    raw = result.get('summary_0', {})
    out = {}
    for method, val in raw.items():
        try:
            pct = float(val)
        except (TypeError, ValueError):
            continue
        if pct > 0:
            out[f'HTTP {method} Flood'] = pct
    return out


def fetch_l7_industry_targets():
    """L7 top targeted industries — returns {label: pct} dict."""
    result = cf_get('/attacks/layer7/top/industry', {'limit': 10, 'dateRange': '1d'})
    out = {}
    for row in result.get('top_0', []):
        name = row.get('name') or row.get('value') or ''
        try:
            pct = float(row.get('value', 0))
        except (TypeError, ValueError):
            pct = 0
        # Sometimes 'name' and 'value' are swapped — find the string key
        for k, v in row.items():
            if isinstance(v, str) and not v.replace('.', '').isdigit():
                name = v
                break
        if name and pct > 0:
            out[name] = pct
    return out


def fetch_l7_categories():
    """Returns {type: {family: pct}} from CF managed rules categories, or None on failure."""
    result = cf_get('/attacks/layer7/summary/managed_rules_categories', {'dateRange': '1d'})
    raw = result.get('summary_0', {})
    by_type = {}
    for key, val in raw.items():
        info = L7_CAT_MAP.get(key)
        if not info:
            continue
        mtype, family = info
        try:
            pct = float(val)
        except (TypeError, ValueError):
            continue
        if pct > 0:
            by_type.setdefault(mtype, {})[family] = pct
    return by_type if by_type else None


def fetch_bgp_hijacks():
    """Fetch recent BGP hijack events and map to attack events."""
    result  = cf_get('/bgp/hijacks/events', {'dateRange': '7d', 'perPage': 50, 'sortBy': 'TIME', 'sortOrder': 'DESC'})
    raw     = result.get('events', [])
    events  = []
    for ev in raw:
        hijackers = ev.get('hijackerAsns', [])
        origins   = ev.get('originAsns', [])
        if not hijackers or not origins:
            continue
        h_cc = (hijackers[0].get('countryCode') or '').upper()
        o_cc = (origins[0].get('countryCode')   or '').upper()
        src  = ISO_TO_COUNTRY.get(h_cc)
        tgt  = ISO_TO_COUNTRY.get(o_cc)
        if not src or not tgt or src == tgt:
            continue
        lat, lon = CENTROIDS.get(src, (0.0, 0.0))
        asn_name = hijackers[0].get('asnName', '')
        events.append({
            'src': src, 'tgt': tgt, 'type': 'exploit',
            'ip': '', 'family': 'BGP Hijack',
            'first_seen': (ev.get('eventDatetime') or '')[:10],
            'source': 'cloudflare',
            'lat': lat, 'lon': lon,
            'city': '', 'asn': asn_name,
        })
    return events


def generate_events(origins, targets, mtype, families, n):
    """
    Generate n weighted events from origin/target country distributions.
    families: dict of {name: weight} for realistic family name assignment.
    """
    if not origins or not targets or not families:
        return []
    src_c, src_w = zip(*origins)
    tgt_c, tgt_w = zip(*targets)
    fam_names    = list(families.keys())
    fam_weights  = list(families.values())
    events = []
    for _ in range(n):
        src = random.choices(src_c, weights=src_w)[0]
        pairs = [(c, w) for c, w in zip(tgt_c, tgt_w) if c != src]
        if not pairs:
            continue
        tc, tw  = zip(*pairs)
        tgt     = random.choices(tc, weights=tw)[0]
        family  = random.choices(fam_names, weights=fam_weights)[0]
        lat, lon = CENTROIDS.get(src, (0.0, 0.0))
        events.append({
            'src': src, 'tgt': tgt, 'type': mtype,
            'ip': '', 'family': family, 'first_seen': '',
            'source': 'cloudflare',
            'lat': lat, 'lon': lon,
            'city': '', 'asn': '',
        })
    return events


def main():
    if not CF_TOKEN:
        print('ERROR: CF_TOKEN environment variable not set')
        return

    events = []

    # ── L3 origin/target distributions ───────────────────────────────
    print('Fetching L3 top locations...')
    l3_origins, l3_targets = [], []
    try:
        l3_origins, l3_targets = fetch_l3()
        print(f'  {len(l3_origins)} origins, {len(l3_targets)} targets')
    except Exception as e:
        print(f'  L3 locations failed: {e}')

    # ── L7 origin/target distributions ───────────────────────────────
    print('Fetching L7 top locations...')
    l7_origins, l7_targets = [], []
    try:
        l7_origins, l7_targets = fetch_l7()
        print(f'  {len(l7_origins)} origins, {len(l7_targets)} targets')
    except Exception as e:
        print(f'  L7 locations failed: {e}')

    # ── L3 vector breakdown → family names for events ─────────────────
    print('Fetching L3 attack vectors...')
    l3_vectors = {'Network DDoS': 100.0}
    try:
        l3_vectors = fetch_l3_vectors() or l3_vectors
        print(f'  {len(l3_vectors)} vectors: {", ".join(l3_vectors.keys())}')
    except Exception as e:
        print(f'  L3 vectors unavailable: {e}')

    # ── L3 protocol breakdown (for meta display) ──────────────────────
    print('Fetching L3 protocols...')
    l3_protocols = {}
    try:
        l3_protocols = fetch_l3_protocols()
        print(f'  {l3_protocols}')
    except Exception as e:
        print(f'  L3 protocols unavailable: {e}')

    # ── L7 method breakdown → family names for events ─────────────────
    print('Fetching L7 HTTP methods...')
    l7_methods = {'HTTP Flood': 100.0}
    try:
        l7_methods = fetch_l7_methods() or l7_methods
        print(f'  {len(l7_methods)} methods: {", ".join(l7_methods.keys())}')
    except Exception as e:
        print(f'  L7 methods unavailable: {e}')

    # ── L7 industry targets (meta only) ───────────────────────────────
    print('Fetching L7 targeted industries...')
    l7_industries = {}
    try:
        l7_industries = fetch_l7_industry_targets()
        print(f'  {len(l7_industries)} industries')
    except Exception as e:
        print(f'  L7 industries unavailable: {e}')

    # ── BGP hijack events ─────────────────────────────────────────────
    print('Fetching BGP hijack events...')
    bgp_events = []
    try:
        bgp_events = fetch_bgp_hijacks()
        print(f'  {len(bgp_events)} hijack events')
    except Exception as e:
        print(f'  BGP hijacks unavailable: {e}')

    # ── L7 attack category breakdown → per-type event generation ─────────
    print('Fetching L7 attack categories...')
    l7_cats = None
    try:
        l7_cats = fetch_l7_categories()
        if l7_cats:
            print(f'  {len(l7_cats)} types: {", ".join(l7_cats.keys())}')
        else:
            print('  No category data returned, falling back to exploit')
    except Exception as e:
        print(f'  L7 categories unavailable: {e}')

    # ── Generate weighted events ──────────────────────────────────────
    l3 = generate_events(l3_origins, l3_targets, 'ddos', l3_vectors, 900)

    FALLBACK_L7_CATS = {
        'recon':    {'Bot Traffic': 32.0, 'Automated Scanner': 14.0},
        'exploit':  {'HTTP Anomaly': 12.0, 'SQL Injection': 6.0,
                     'Cross-Site Scripting': 4.0, 'Remote Code Execution': 2.5,
                     'Local File Inclusion': 1.5},
        'ddos':     {'HTTP Flood': 18.0},
        'malware':  {'Malware Delivery': 5.0},
        'phishing': {'Phishing Attack': 3.0},
        'c2':       {'Credential Stuffing': 1.5, 'Auth Bypass': 0.5},
    }

    l7 = []
    cats = l7_cats if (l7_cats and l7_origins and l7_targets) else FALLBACK_L7_CATS
    if l7_origins and l7_targets:
        total_pct = sum(sum(f.values()) for f in cats.values()) or 1
        for mtype, families in cats.items():
            n = max(1, round(600 * sum(families.values()) / total_pct))
            l7.extend(generate_events(l7_origins, l7_targets, mtype, families, n))

    events = l3 + l7 + bgp_events
    random.shuffle(events)

    print(f'Total: {len(l3)} L3 + {len(l7)} L7 + {len(bgp_events)} BGP = {len(events)} events')

    # ── Write iocs.json ───────────────────────────────────────────────
    _IOCS_FILE.parent.mkdir(exist_ok=True)
    _IOCS_FILE.write_text(json.dumps(events, separators=(',', ':')))
    print(f'Wrote {len(events)} events → {_IOCS_FILE}')

    # ── Write cf_meta.json ────────────────────────────────────────────
    meta = {
        'l3_vectors':    l3_vectors,
        'l3_protocols':  l3_protocols,
        'l7_methods':    l7_methods,
        'l7_industries': l7_industries,
        'bgp_count':     len(bgp_events),
        'l3_count':      len(l3),
        'l7_count':      len(l7),
        'updatedAt':     time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    _META_FILE.write_text(json.dumps(meta, indent=2))
    print(f'Wrote metadata → {_META_FILE}')


if __name__ == '__main__':
    main()
