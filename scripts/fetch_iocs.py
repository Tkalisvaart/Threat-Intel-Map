#!/usr/bin/env python3
"""
Fetch threat intel from abuse.ch and write data/iocs.json.
Run by GitHub Actions on a schedule — no CORS restrictions server-side.
"""
import concurrent.futures
import ipaddress
import json
import os
import random
import socket
import time
import urllib.request
from pathlib import Path

_META_FILE = Path(__file__).parent.parent / 'data' / 'fetch_meta.json'
_IOCS_FILE = Path(__file__).parent.parent / 'data' / 'iocs.json'
# AbuseIPDB free tier allows only 5 blacklist requests/day — enforce a 23-hour cooldown.
_ABUSEIPDB_COOLDOWN = 23 * 3600
# CINS Score: be polite — refresh at most every 6 hours.
_CINS_COOLDOWN = 6 * 3600


def _load_meta():
    try:
        return json.loads(_META_FILE.read_text())
    except Exception:
        return {}


def _save_meta(meta):
    _META_FILE.parent.mkdir(exist_ok=True)
    _META_FILE.write_text(json.dumps(meta, indent=2))


def _abuseipdb_ready(meta):
    last = meta.get('abuseipdb_last_fetch', 0)
    elapsed = time.time() - last
    if elapsed < _ABUSEIPDB_COOLDOWN:
        remaining_h = (_ABUSEIPDB_COOLDOWN - elapsed) / 3600
        print(f'  Skipping AbuseIPDB — fetched {elapsed/3600:.1f}h ago, cooldown {remaining_h:.1f}h remaining')
        return False
    return True


def _cached_abuseipdb_events():
    """Return existing AbuseIPDB events already in iocs.json."""
    try:
        existing = json.loads(_IOCS_FILE.read_text())
        cached = [e for e in existing if e.get('family') == 'AbuseIPDB' or e.get('source') == 'abuseipdb']
        for e in cached:
            e.setdefault('source', 'abuseipdb')
        print(f'  Reusing {len(cached)} cached AbuseIPDB events from iocs.json')
        return cached
    except Exception:
        return []


def _github_raw_iocs_url():
    """Derive the raw GitHub URL for iocs.json from the git remote origin."""
    try:
        import subprocess
        result = subprocess.run(
            ['git', 'remote', 'get-url', 'origin'],
            capture_output=True, text=True,
            cwd=str(Path(__file__).parent.parent),
        )
        remote = result.stdout.strip()
        # Strip embedded credentials (https://user:token@github.com/...)
        if '@github.com' in remote:
            remote = 'https://github.com/' + remote.split('@github.com/', 1)[1]
        # https://github.com/USER/REPO.git → https://raw.githubusercontent.com/USER/REPO/main/data/iocs.json
        raw = remote.replace('https://github.com/', 'https://raw.githubusercontent.com/')
        raw = raw.removesuffix('.git')
        return raw + '/main/data/iocs.json'
    except Exception:
        return None


def _github_abuseipdb_events():
    """Fetch AbuseIPDB events from the GitHub-hosted iocs.json (kept fresh by CI)."""
    url = _github_raw_iocs_url()
    if not url:
        raise RuntimeError('Could not determine GitHub raw URL from git remote')
    req = urllib.request.Request(url, headers={'User-Agent': 'azimuth-threat-map/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    events = [e for e in data if e.get('source') == 'abuseipdb' or e.get('family') == 'AbuseIPDB']
    for e in events:
        e.setdefault('source', 'abuseipdb')
    print(f'  Fetched {len(events)} AbuseIPDB events from GitHub iocs.json')
    return events


def _cins_ready(meta):
    last = meta.get('cins_last_fetch', 0)
    elapsed = time.time() - last
    if elapsed < _CINS_COOLDOWN:
        remaining_h = (_CINS_COOLDOWN - elapsed) / 3600
        print(f'  Skipping CINS Score — fetched {elapsed/3600:.1f}h ago, cooldown {remaining_h:.1f}h remaining')
        return False
    return True


def _cached_cins_events():
    try:
        existing = json.loads(_IOCS_FILE.read_text())
        cached = [e for e in existing if e.get('family') == 'CINS Score' or e.get('source') == 'cins']
        for e in cached:
            e.setdefault('source', 'cins')
        print(f'  Reusing {len(cached)} cached CINS Score events from iocs.json')
        return cached
    except Exception:
        return []

# Load MaxMind GeoLite2 databases if available (downloaded by CI before this script runs).
# Falls back to ip-api.com batch API when databases are absent.
_DB_DIR = Path(__file__).parent.parent
try:
    import geoip2.database
    import geoip2.errors
    _city_reader = geoip2.database.Reader(str(_DB_DIR / 'GeoLite2-City.mmdb'))
    _asn_reader  = geoip2.database.Reader(str(_DB_DIR / 'GeoLite2-ASN.mmdb'))
    _USE_MAXMIND = True
    print('GeoLite2 databases loaded — using MaxMind for geolocation')
except Exception:
    _city_reader = None
    _asn_reader  = None
    _USE_MAXMIND = False
    print('MaxMind databases not found — falling back to ip-api.com')

# Must match GEO keys in js/data.js
KNOWN_COUNTRIES = {
    'China', 'United States', 'Russia', 'Brazil', 'India', 'Germany',
    'Netherlands', 'France', 'United Kingdom', 'South Korea', 'Japan',
    'Ukraine', 'Vietnam', 'Iran', 'Turkey', 'Indonesia', 'Mexico',
    'Pakistan', 'Nigeria', 'South Africa', 'Australia', 'Canada',
    'Argentina', 'Egypt', 'Romania', 'Bulgaria', 'Poland',
    'North Korea', 'Belarus', 'Israel', 'Hong Kong', 'Singapore',
    'Taiwan', 'Thailand', 'Malaysia', 'Philippines', 'Czech Republic',
    'Hungary', 'Serbia', 'Moldova', 'Kazakhstan', 'Lithuania',
    'Latvia', 'Estonia', 'Finland', 'Sweden', 'Norway', 'Denmark',
    'Spain', 'Portugal', 'Italy', 'Greece', 'Switzerland', 'Austria',
    'Belgium', 'Chile', 'Colombia', 'Peru', 'Venezuela', 'Saudi Arabia',
    'UAE', 'Morocco', 'Algeria', 'Bangladesh', 'Sri Lanka', 'Myanmar',
    'Nepal', 'Slovakia', 'Croatia', 'Azerbaijan', 'Georgia', 'Armenia',
    'Uzbekistan',
}

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
    'UZ': 'Uzbekistan',
}

TARGETS = {
    'malware':  ['United States', 'Germany', 'United Kingdom', 'Australia', 'Canada', 'France', 'Japan', 'Netherlands'],
    'phishing': ['United States', 'United Kingdom', 'Germany', 'France', 'Australia', 'Canada', 'Japan'],
    'c2':       ['United States', 'Germany', 'Japan', 'United Kingdom', 'France', 'Netherlands', 'Australia'],
    'exploit':  ['United States', 'Germany', 'France', 'Japan', 'South Korea', 'Australia', 'Canada'],
    'recon':    ['United States', 'Germany', 'Japan', 'United Kingdom', 'Australia', 'France', 'Netherlands'],
    'ddos':     ['United States', 'Germany', 'France', 'South Korea', 'Japan', 'Netherlands', 'United Kingdom'],
}


def pick_target(mtype, src):
    options = [c for c in TARGETS.get(mtype, TARGETS['malware']) if c != src]
    return random.choice(options) if options else 'United States'


def map_malware_type(family):
    f = (family or '').lower()
    if any(x in f for x in (
        # RATs / post-exploitation frameworks
        'cobalt', 'asyncrat', 'remcos', 'njrat', 'plugx', 'quasar',
        'darkcomet', 'nanocore', 'xworm', 'sliver', 'havoc', 'metasploit',
        # Banking trojans / loaders — all C2-driven
        'emotet', 'qakbot', 'qbot', 'icedid', 'dridex', 'trickbot',
        'bazarloader', 'bumblebee', 'gootkit', 'ursnif', 'zloader',
        'amadey', 'systembc', 'pikabot', 'latrodectus',
        # Info-stealers with C2 check-in
        'stealc', 'redline', 'raccoon', 'lumma', 'vidar', 'formbook',
        'agent tesla', 'lokibot', 'snake keylogger',
    )):
        return 'c2'
    if any(x in f for x in (
        'ransomware', 'lockbit', 'blackcat', 'clop', 'conti',
        'revil', 'hive', 'sodinokibi', 'akira', 'phobos',
        'blackbasta', 'rhysida', 'play', 'medusa',
    )):
        return 'exploit'
    if 'phish' in f:
        return 'phishing'
    if any(x in f for x in ('scan', 'recon', 'masscan', 'zmap')):
        return 'recon'
    if any(x in f for x in ('ddos', 'flood', 'mirai', 'bashlite', 'moobot')):
        return 'ddos'
    return 'malware'


def map_threat_type(raw):
    t = (raw or '').lower()
    if 'phish' in t:
        return 'phishing'
    if any(x in t for x in ('c2', 'cc', 'command', 'beacon', 'botnet')):
        return 'c2'
    if 'exploit' in t:
        return 'exploit'
    if any(x in t for x in ('recon', 'scan')):
        return 'recon'
    return 'malware'


def _is_public_ip(ip):
    try:
        return not ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def _geolocate_maxmind(ips):
    """Geolocate IPs using local MaxMind GeoLite2 databases — no rate limits."""
    results = {}
    for ip in ips:
        if not _is_public_ip(ip):
            continue
        try:
            city = _city_reader.city(ip)
            cc = city.country.iso_code or ''
            country = ISO_TO_COUNTRY.get(cc)
            if not country:
                continue
            asn_str = ''
            if _asn_reader:
                try:
                    asn = _asn_reader.asn(ip)
                    asn_str = f'AS{asn.autonomous_system_number} {asn.autonomous_system_organization}'
                except Exception:
                    pass
            results[ip] = {
                'country': country,
                'lat':     round(city.location.latitude  or 0, 4),
                'lon':     round(city.location.longitude or 0, 4),
                'city':    city.city.name or '',
                'asn':     asn_str,
            }
        except Exception:
            pass
    return results


def _geolocate_ipapi(ips):
    """Batch-geolocate IPs via ip-api.com free tier. Returns {ip: {country, lat, lon, city, asn}}."""
    import urllib.error
    results = {}
    chunks = [ips[i:i + 100] for i in range(0, len(ips), 100)]
    for idx, chunk in enumerate(chunks):
        payload = json.dumps([
            {'query': ip, 'fields': 'status,country,countryCode,lat,lon,city,regionName,as,query'}
            for ip in chunk
        ]).encode()
        req = urllib.request.Request(
            'http://ip-api.com/batch',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    batch = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = 60 * (attempt + 1)
                    print(f'  ip-api.com rate limited — waiting {wait}s before retry...')
                    time.sleep(wait)
                else:
                    raise
        else:
            print('  ip-api.com: max retries hit, skipping remaining IPs')
            break
        for entry in batch:
            if entry.get('status') == 'success':
                country = ISO_TO_COUNTRY.get(entry.get('countryCode', ''))
                if country:
                    results[entry['query']] = {
                        'country': country,
                        'lat': round(entry.get('lat', 0), 4),
                        'lon': round(entry.get('lon', 0), 4),
                        'city': entry.get('city', ''),
                        'asn': entry.get('as', ''),
                    }
        if idx + 1 < len(chunks):
            time.sleep(3)
    return results


def geolocate_ips(ips):
    """Geolocate IPs. Uses MaxMind GeoLite2 if available, falls back to ip-api.com."""
    if not ips:
        return {}
    return _geolocate_maxmind(ips) if _USE_MAXMIND else _geolocate_ipapi(ips)


def fetch_feodo():
    req = urllib.request.Request(
        'https://feodotracker.abuse.ch/downloads/ipblocklist.json',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        entries = json.loads(r.read())

    # Geolocate all IPs in one pass — unmapped ones need full lookup, mapped ones
    # already have a country from Feodo's own field but still need lat/lon/ASN.
    pre_mapped = {}  # ip → country from Feodo metadata
    all_ips = []
    for e in entries:
        ip = e.get('ip_address', '')
        if not ip:
            continue
        cc  = (e.get('country') or '').upper()
        src = ISO_TO_COUNTRY.get(cc)
        if src:
            pre_mapped[ip] = src
        all_ips.append(ip)

    geo_detail = {}
    try:
        geo_detail = geolocate_ips(list(set(all_ips)))
    except Exception:
        pass

    events = []
    for e in entries:
        ip     = e.get('ip_address', '')
        if not ip:
            continue
        g   = geo_detail.get(ip, {})
        src = g.get('country') or pre_mapped.get(ip)
        if not src:
            continue
        mtype      = map_malware_type(e.get('malware', ''))
        family     = e.get('malware', '')
        first_seen = (e.get('first_seen') or '')[:10]
        port       = e.get('port', 0) or 0
        events.append({
            'src': src, 'tgt': pick_target(mtype, src), 'type': mtype,
            'ip': ip, 'family': family, 'first_seen': first_seen, 'port': port,
            'source': 'feodo',
            'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
            'city': g.get('city', ''), 'asn': g.get('asn', ''),
        })
    return events


def _resolve(host):
    """Resolve a hostname to an IPv4 address with a short timeout."""
    try:
        socket.setdefaulttimeout(2)
        return socket.gethostbyname(host)
    except Exception:
        return None
    finally:
        socket.setdefaulttimeout(None)


def fetch_openphish():
    """Fetch active phishing URLs from OpenPhish — no API key."""
    req = urllib.request.Request(
        'https://openphish.com/feed.txt',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        lines = r.read().decode('utf-8').splitlines()

    seen_hosts = set()
    hosts = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        try:
            host = line.split('://', 1)[-1].split('/')[0].split('@')[-1]
            if ':' in host:
                host = host.rsplit(':', 1)[0]
            if host and host not in seen_hosts:
                seen_hosts.add(host)
                hosts.append(host)
        except Exception:
            continue

    if not hosts:
        return []

    # Resolve all hosts to IPs (mix of raw IPs and domain lookups) in parallel
    sample = random.sample(hosts, min(500, len(hosts)))
    print(f'  OpenPhish: resolving {len(sample)} hosts...')
    host_to_ip = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=60) as pool:
        futures = {pool.submit(_resolve, h): h for h in sample}
        done, _ = concurrent.futures.wait(futures, timeout=60)
        for fut in done:
            host = futures[fut]
            ip = fut.result()
            if ip:
                host_to_ip[host] = ip

    unique_ips = list(set(host_to_ip.values()))
    if not unique_ips:
        return []

    geo = geolocate_ips(unique_ips)
    ip_to_country = {ip: geo[ip]['country'] for ip in unique_ips if ip in geo}

    events = []
    seen_ips = set()
    for host, ip in host_to_ip.items():
        src = ip_to_country.get(ip)
        if src and ip not in seen_ips:
            seen_ips.add(ip)
            g = geo.get(ip, {})
            events.append({
                'src': src, 'tgt': pick_target('phishing', src), 'type': 'phishing',
                'ip': ip, 'family': 'Phishing Site', 'first_seen': '',
                'source': 'openphish',
                'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
                'city': g.get('city', ''), 'asn': g.get('asn', ''),
            })
    return events


def fetch_blocklist_de():
    """Fetch attack IPs from Blocklist.de by category — no API key required."""
    feeds = [
        ('https://lists.blocklist.de/lists/ssh.txt',        'recon',    'SSH Brute Force'),
        ('https://lists.blocklist.de/lists/apache.txt',     'exploit',  'Web Exploit'),
        ('https://lists.blocklist.de/lists/bots.txt',       'ddos',     'Botnet'),
        ('https://lists.blocklist.de/lists/mail.txt',       'phishing', 'Mail Spam'),
        ('https://lists.blocklist.de/lists/imap.txt',       'recon',    'IMAP Brute Force'),
        ('https://lists.blocklist.de/lists/ftp.txt',        'recon',    'FTP Brute Force'),
        ('https://lists.blocklist.de/lists/strongips.txt',  'exploit',  'Persistent Attacker'),
        ('https://lists.blocklist.de/lists/sip.txt',        'recon',    'VoIP Scan'),
    ]
    ip_entries = []
    seen = set()

    for url, mtype, family_label in feeds:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'azimuth-threat-map/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                lines = r.read().decode('utf-8').splitlines()
            ips = [ln.strip() for ln in lines if ln.strip() and not ln.startswith('#')]
            sample = random.sample(ips, min(100, len(ips)))
            for ip in sample:
                if ip not in seen:
                    seen.add(ip)
                    ip_entries.append((ip, mtype, family_label))
        except Exception:
            pass

    if not ip_entries:
        return []

    print(f'  Blocklist.de: geolocating {len(ip_entries)} IPs...')
    geo = geolocate_ips([ip for ip, _, _ in ip_entries])

    events = []
    for ip, mtype, family_label in ip_entries:
        g = geo.get(ip, {})
        src = g.get('country')
        if src:
            events.append({
                'src': src, 'tgt': pick_target(mtype, src), 'type': mtype,
                'ip': ip, 'family': family_label, 'first_seen': '',
                'source': 'blocklist',
                'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
                'city': g.get('city', ''), 'asn': g.get('asn', ''),
            })
    return events


def fetch_emerging_threats():
    """Fetch compromised IPs from Emerging Threats — no API key required."""
    req = urllib.request.Request(
        'https://rules.emergingthreats.net/blockrules/compromised-ips.txt',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        lines = r.read().decode('utf-8').splitlines()

    ips = [ln.strip() for ln in lines if ln.strip() and not ln.startswith('#')]
    if not ips:
        return []

    sample = random.sample(ips, min(200, len(ips)))
    print(f'  Emerging Threats: geolocating {len(sample)} IPs...')
    geo = geolocate_ips(sample)

    events = []
    for ip in sample:
        g = geo.get(ip, {})
        src = g.get('country')
        if src:
            events.append({
                'src': src, 'tgt': pick_target('malware', src), 'type': 'malware',
                'ip': ip, 'family': 'Compromised Host', 'first_seen': '',
                'source': 'emergingthreats',
                'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
                'city': g.get('city', ''), 'asn': g.get('asn', ''),
            })
    return events


def fetch_abuseipdb(api_key):
    """Fetch blacklisted IPs from AbuseIPDB verbose endpoint."""
    CAT_TYPE = {
        4:  'ddos',
        7:  'phishing',
        14: 'recon', 18: 'recon', 22: 'recon', 5: 'recon',
        15: 'exploit', 16: 'exploit', 20: 'exploit', 21: 'exploit',
    }
    CAT_FAMILY = {
        4:  'DDoS Attack',
        5:  'FTP Brute-Force',
        7:  'Phishing',
        11: 'Email Spam',
        14: 'Port Scan',
        15: 'Hacking',
        16: 'SQL Injection',
        18: 'Brute-Force',
        20: 'Exploited Host',
        21: 'Web App Attack',
        22: 'SSH Brute-Force',
        23: 'IoT Attack',
    }
    TYPE_FAMILY = {
        'ddos':     'DDoS Attack',
        'phishing': 'Phishing',
        'recon':    'Port Scan',
        'exploit':  'Web Attack',
        'malware':  'Malware',
        'c2':       'C2 Beacon',
    }
    TYPE_PRIORITY = ['ddos', 'exploit', 'phishing', 'recon', 'malware']

    def pick_type(categories):
        types = set()
        for c in (categories or []):
            t = CAT_TYPE.get(c)
            if t:
                types.add(t)
        for t in TYPE_PRIORITY:
            if t in types:
                return t
        return 'malware'

    def pick_family(categories, mtype):
        for cat in (categories or []):
            if cat in CAT_FAMILY:
                return CAT_FAMILY[cat]
        return TYPE_FAMILY.get(mtype, 'Malware')

    req = urllib.request.Request(
        'https://api.abuseipdb.com/api/v2/blacklist?confidenceMinimum=90&limit=1000&verbose',
        headers={
            'Key': api_key,
            'Accept': 'application/json',
            'User-Agent': 'azimuth-threat-map/1.0',
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())

    entries = data.get('data', [])
    if not entries:
        return []

    sample = random.sample(entries, min(1000, len(entries)))

    # Collect IPs for enrichment
    ip_list = [entry.get('ipAddress', '') for entry in sample if entry.get('ipAddress')]
    print(f'  AbuseIPDB: enriching {len(ip_list)} IPs with coordinates...')
    geo_detail = {}
    try:
        geo_detail = geolocate_ips(ip_list)
    except Exception:
        pass

    events = []
    for entry in sample:
        cc      = (entry.get('countryCode') or '').upper()
        src     = ISO_TO_COUNTRY.get(cc)
        if not src:
            continue
        ip         = entry.get('ipAddress', '')
        # Blacklist verbose endpoint puts categories inside reports[], not at top level
        all_cats = []
        for report in (entry.get('reports') or []):
            all_cats.extend(report.get('categories') or [])
        mtype        = pick_type(all_cats)
        family       = pick_family(all_cats, mtype)
        first_seen   = (entry.get('lastReportedAt') or '')[:10]
        confidence   = entry.get('abuseConfidenceScore', 0)
        total_reports = entry.get('totalReports', 0)
        g            = geo_detail.get(ip, {})
        events.append({
            'src': src, 'tgt': pick_target(mtype, src), 'type': mtype,
            'ip': ip, 'family': family, 'first_seen': first_seen,
            'confidence': confidence, 'total_reports': total_reports,
            'source': 'abuseipdb',
            'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
            'city': g.get('city', ''), 'asn': g.get('asn', ''),
        })
    return events


def fetch_threatfox(api_key=''):
    """Fetch recent IP:port IOCs from ThreatFox (abuse.ch).
    Uses authenticated API (days=7) when a key is available, otherwise falls back
    to the public ip:port export which requires no authentication.
    """
    iocs = []

    if api_key:
        payload = json.dumps({'query': 'get_iocs', 'days': 7}).encode()
        headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'azimuth-threat-map/1.0',
            'Auth-Key': api_key,
        }
        req = urllib.request.Request(
            'https://threatfox-api.abuse.ch/api/v1/',
            data=payload, headers=headers, method='POST',
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        status = data.get('query_status')
        if status == 'ok':
            iocs = data.get('data', []) or []
        else:
            print(f'  ThreatFox API returned status={status!r} — falling back to public export')
            api_key = ''  # trigger public fallback

    if not api_key:
        # Public JSON export — no auth needed, updated every ~5 min.
        # Format: date-keyed dict {"YYYY-MM-DD HH:MM:SS": [ioc, ...], ...}
        req = urllib.request.Request(
            'https://threatfox.abuse.ch/export/json/ip-port/recent/',
            headers={'User-Agent': 'azimuth-threat-map/1.0'},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = json.loads(r.read())
        if isinstance(raw, list):
            iocs = raw
        elif isinstance(raw, dict):
            if 'data' in raw:
                iocs = raw['data'] or []
            else:
                # Date-keyed export: {"2025-05-10 00:00:00": [ioc, ...], ...}
                for v in raw.values():
                    if isinstance(v, list):
                        iocs.extend(v)

    seen = set()
    ip_entries = []

    for ioc in iocs:
        # API responses have ioc_type; public export is implicitly ip:port
        if api_key and ioc.get('ioc_type') != 'ip:port':
            continue
        # API uses 'ioc_value'; public export uses 'ioc'
        ioc_value = ioc.get('ioc_value') or ioc.get('ioc', '')
        try:
            if ioc_value.startswith('['):
                ip = ioc_value[1:ioc_value.index(']')]
            else:
                ip = ioc_value.rsplit(':', 1)[0]
        except Exception:
            continue
        if not ip or ip in seen:
            continue
        seen.add(ip)

        family     = ioc.get('malware_printable', '') or ''
        confidence = ioc.get('confidence_level', 50)
        first_seen = (ioc.get('first_seen') or '')[:10]
        mtype      = map_malware_type(family) if family else map_threat_type(ioc.get('threat_type', ''))
        port       = 0
        try:
            port = int(ioc_value.rsplit(':', 1)[1])
        except Exception:
            pass

        ip_entries.append({
            'ip': ip, 'family': family or 'ThreatFox IOC', 'mtype': mtype,
            'confidence': confidence, 'first_seen': first_seen, 'port': port,
        })

    if not ip_entries:
        return []

    print(f'  ThreatFox: geolocating {len(ip_entries)} IPs...')
    geo = geolocate_ips([e['ip'] for e in ip_entries])

    events = []
    for entry in ip_entries:
        g = geo.get(entry['ip'], {})
        src = g.get('country')
        if not src:
            continue
        events.append({
            'src': src, 'tgt': pick_target(entry['mtype'], src),
            'type': entry['mtype'], 'ip': entry['ip'],
            'family': entry['family'], 'first_seen': entry['first_seen'],
            'confidence': entry['confidence'], 'port': entry['port'],
            'source': 'threatfox',
            'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
            'city': g.get('city', ''), 'asn': g.get('asn', ''),
        })
    return events


def fetch_ipsum():
    """Fetch high-confidence malicious IPs from IPsum (GitHub-hosted multi-feed aggregator).
    IPsum aggregates 30+ public threat intelligence lists; each IP's score is the number
    of lists it appears on. We sample IPs with score >= 5 for high confidence.
    Hosted on GitHub raw content — no IP-based restrictions from CI runners.
    """
    req = urllib.request.Request(
        'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        lines = r.read().decode('utf-8', errors='ignore').splitlines()

    high_conf = []
    medium_conf = []
    for ln in lines:
        ln = ln.strip()
        if not ln or ln.startswith('#'):
            continue
        parts = ln.split('\t')
        if len(parts) < 2:
            continue
        ip, score_str = parts[0], parts[1]
        try:
            score = int(score_str)
        except ValueError:
            continue
        if not _is_public_ip(ip):
            continue
        if score >= 5:
            high_conf.append((ip, score))
        elif score >= 3:
            medium_conf.append((ip, score))

    # Prefer high-confidence IPs; fill up to 600 with medium-confidence
    selected = high_conf + random.sample(medium_conf, min(max(0, 600 - len(high_conf)), len(medium_conf)))
    selected = selected[:400]
    random.shuffle(selected)

    if not selected:
        return []

    print(f'  IPsum: geolocating {len(selected)} IPs (high-conf: {len(high_conf)})...')
    geo = geolocate_ips([ip for ip, _ in selected])

    events = []
    for ip, score in selected:
        g = geo.get(ip, {})
        src = g.get('country')
        if src:
            events.append({
                'src': src, 'tgt': pick_target('malware', src), 'type': 'malware',
                'ip': ip, 'family': 'IPsum', 'first_seen': '',
                'confidence': min(99, 50 + score * 5),
                'source': 'ipsum',
                'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
                'city': g.get('city', ''), 'asn': g.get('asn', ''),
            })
    return events


def fetch_cins():
    """Fetch high-confidence malicious IPs from CINS Score — no API key required."""
    req = urllib.request.Request(
        'https://cinsscore.com/list/ci-badguys.txt',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        lines = r.read().decode('utf-8').splitlines()

    ips = [ln.strip() for ln in lines if ln.strip() and not ln.startswith('#') and _is_public_ip(ln.strip())]
    if not ips:
        return []

    sample = random.sample(ips, min(400, len(ips)))
    print(f'  CINS Score: geolocating {len(sample)} IPs...')
    geo = geolocate_ips(sample)

    events = []
    for ip in sample:
        g = geo.get(ip, {})
        src = g.get('country')
        if src:
            events.append({
                'src': src, 'tgt': pick_target('recon', src), 'type': 'recon',
                'ip': ip, 'family': 'CINS Score', 'first_seen': '',
                'source': 'cins',
                'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
                'city': g.get('city', ''), 'asn': g.get('asn', ''),
            })
    return events


def fetch_urlhaus(api_key=''):
    """Fetch recent malware URLs from URLhaus (abuse.ch). Requires a free abuse.ch API key."""
    headers = {'User-Agent': 'azimuth-threat-map/1.0'}
    if api_key:
        headers['Auth-Key'] = api_key
    req = urllib.request.Request(
        'https://urlhaus-api.abuse.ch/v1/urls/recent/',
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())

    if api_key and (data.get('query_status') == 'unknown_auth_key' or data.get('error') == 'Unauthorized'):
        raise ValueError('URLhaus API key invalid — get a free key at abuse.ch/register')

    urls = data.get('urls', [])
    if not urls:
        return []

    seen_hosts = set()
    host_entries = []
    for url_entry in urls:
        url    = url_entry.get('url', '')
        status = url_entry.get('url_status', '')
        tags   = url_entry.get('tags') or []
        threat = url_entry.get('threat', '')
        try:
            host = url.split('://', 1)[-1].split('/')[0].split('@')[-1]
            if ':' in host and not host.startswith('['):
                host = host.rsplit(':', 1)[0]
        except Exception:
            continue
        if not host or host in seen_hosts:
            continue
        seen_hosts.add(host)
        family = tags[0] if tags else (threat or 'URLhaus')
        host_entries.append({'host': host, 'status': status, 'family': family})

    # Prioritise online (active) threats
    online  = [e for e in host_entries if e['status'] == 'online']
    offline = [e for e in host_entries if e['status'] != 'online']
    sample  = (random.sample(online, min(200, len(online))) +
               random.sample(offline, min(100, len(offline))))

    print(f'  URLhaus: resolving {len(sample)} hosts ({len(online)} active)...')
    host_to_ip = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
        futures = {pool.submit(_resolve, e['host']): e for e in sample}
        done, _ = concurrent.futures.wait(futures, timeout=60)
        for fut in done:
            entry = futures[fut]
            ip = fut.result()
            if ip:
                host_to_ip[entry['host']] = (ip, entry)

    if not host_to_ip:
        return []

    unique_ips = list({ip for ip, _ in host_to_ip.values()})
    geo = geolocate_ips(unique_ips)

    events = []
    seen_ips: set = set()
    for host, (ip, entry) in host_to_ip.items():
        if ip in seen_ips:
            continue
        seen_ips.add(ip)
        g = geo.get(ip, {})
        src = g.get('country')
        if not src:
            continue
        mtype = map_malware_type(entry['family'])
        events.append({
            'src': src, 'tgt': pick_target(mtype, src), 'type': mtype,
            'ip': ip, 'family': entry['family'], 'first_seen': '',
            'active': entry['status'] == 'online',
            'source': 'urlhaus',
            'lat': g.get('lat', 0), 'lon': g.get('lon', 0),
            'city': g.get('city', ''), 'asn': g.get('asn', ''),
        })
    return events


def main():
    events = []
    meta = _load_meta()

    print('Fetching Feodo Tracker...')
    try:
        feodo = fetch_feodo()
        events.extend(feodo)
        print(f'  {len(feodo)} events')
    except Exception as e:
        print(f'  Feodo failed: {e}')

    print('Fetching OpenPhish...')
    try:
        openphish = fetch_openphish()
        events.extend(openphish)
        print(f'  {len(openphish)} events')
    except Exception as e:
        print(f'  OpenPhish failed: {e}')

    print('Fetching Blocklist.de...')
    try:
        bld = fetch_blocklist_de()
        events.extend(bld)
        print(f'  {len(bld)} events')
    except Exception as e:
        print(f'  Blocklist.de failed: {e}')

    print('Fetching Emerging Threats...')
    try:
        et = fetch_emerging_threats()
        events.extend(et)
        print(f'  {len(et)} events')
    except Exception as e:
        print(f'  Emerging Threats failed: {e}')

    print('Checking CINS Score rate limit (max 1 fetch per 6 hours)...')
    if _cins_ready(meta):
        print('Fetching CINS Score...')
        try:
            cins = fetch_cins()
            events.extend(cins)
            print(f'  {len(cins)} events')
            meta['cins_last_fetch'] = time.time()
        except Exception as e:
            print(f'  CINS Score failed: {e}')
            events.extend(_cached_cins_events())
    else:
        events.extend(_cached_cins_events())

    def _abuseipdb_github_fallback(reason):
        print(f'  {reason} — pulling AbuseIPDB events from GitHub iocs.json...')
        try:
            events.extend(_github_abuseipdb_events())
        except Exception as e2:
            print(f'  GitHub fallback failed: {e2} — using local cache')
            events.extend(_cached_abuseipdb_events())

    abuseipdb_key = os.environ.get('ABUSEIPDB_KEY', '')
    if abuseipdb_key:
        print('Checking AbuseIPDB rate limit (max 1 call per 23 hours)...')
        if _abuseipdb_ready(meta):
            print('Fetching AbuseIPDB...')
            try:
                ab = fetch_abuseipdb(abuseipdb_key)
                events.extend(ab)
                print(f'  {len(ab)} events')
                meta['abuseipdb_last_fetch'] = time.time()
            except Exception as e:
                _abuseipdb_github_fallback(f'AbuseIPDB API failed: {e}')
        else:
            _abuseipdb_github_fallback('AbuseIPDB on cooldown')
    else:
        _abuseipdb_github_fallback('No ABUSEIPDB_KEY set')

    threatfox_key = os.environ.get('THREATFOX_KEY', '')
    print('Fetching ThreatFox...')
    try:
        tf = fetch_threatfox(threatfox_key)
        events.extend(tf)
        print(f'  {len(tf)} indicators')
    except Exception as e:
        print(f'  ThreatFox failed: {e}')

    print('Fetching URLhaus...')
    try:
        uh = fetch_urlhaus(threatfox_key)  # key is optional; works without one
        events.extend(uh)
        print(f'  {len(uh)} indicators')
    except Exception as e:
        print(f'  URLhaus failed: {e}')

    print('Fetching IPsum (multi-feed aggregator)...')
    try:
        ip_sum = fetch_ipsum()
        events.extend(ip_sum)
        print(f'  {len(ip_sum)} events')
    except Exception as e:
        print(f'  IPsum failed: {e}')

    # Deduplicate by IP — keep first (richest) entry per IP across all feeds
    seen_ips: set = set()
    deduped = []
    for e in events:
        ip = e.get('ip', '')
        if ip and ip in seen_ips:
            continue
        if ip:
            seen_ips.add(ip)
        deduped.append(e)
    events = deduped

    random.shuffle(events)

    _save_meta(meta)

    out = _IOCS_FILE
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(events, separators=(',', ':')))
    print(f'Wrote {len(events)} indicators → {out}')


if __name__ == '__main__':
    main()
