#!/usr/bin/env python3
"""
Fetch threat intel from abuse.ch and write data/iocs.json.
Run by GitHub Actions on a schedule — no CORS restrictions server-side.
"""
import concurrent.futures
import json
import os
import random
import socket
import time
import urllib.request
from pathlib import Path

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


def geolocate_ips(ips):
    """Batch-geolocate IPs via ip-api.com (free, no key, 100 IPs/request)."""
    if not ips:
        return {}
    results = {}
    chunks = [ips[i:i + 100] for i in range(0, len(ips), 100)]
    for idx, chunk in enumerate(chunks):
        payload = json.dumps([{'query': ip} for ip in chunk]).encode()
        req = urllib.request.Request(
            'http://ip-api.com/batch',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            batch = json.loads(r.read())
        for entry in batch:
            if entry.get('status') == 'success':
                country = ISO_TO_COUNTRY.get(entry.get('countryCode', ''))
                if country:
                    results[entry['query']] = country
        if idx + 1 < len(chunks):
            time.sleep(2)  # ip-api free tier: ~45 req/min
    return results


def fetch_feodo():
    req = urllib.request.Request(
        'https://feodotracker.abuse.ch/downloads/ipblocklist.json',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        entries = json.loads(r.read())

    mapped, unmapped = [], []
    for e in entries:
        cc  = (e.get('country') or '').upper()
        src = ISO_TO_COUNTRY.get(cc)
        if src:
            mapped.append((e, src))
        elif e.get('ip_address'):
            unmapped.append(e)

    if unmapped:
        try:
            extra = geolocate_ips([e['ip_address'] for e in unmapped])
            for e in unmapped:
                src = extra.get(e['ip_address'])
                if src:
                    mapped.append((e, src))
        except Exception:
            pass

    events = []
    for e, src in mapped:
        mtype      = map_malware_type(e.get('malware', ''))
        ip         = e.get('ip_address', '')
        family     = e.get('malware', '')
        first_seen = (e.get('first_seen') or '')[:10]
        events.append({'src': src, 'tgt': pick_target(mtype, src), 'type': mtype, 'ip': ip, 'family': family, 'first_seen': first_seen})
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
    sample = random.sample(hosts, min(200, len(hosts)))
    print(f'  OpenPhish: resolving {len(sample)} hosts...')
    host_to_ip = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=30) as pool:
        futures = {pool.submit(_resolve, h): h for h in sample}
        done, _ = concurrent.futures.wait(futures, timeout=30)
        for fut in done:
            host = futures[fut]
            ip = fut.result()
            if ip:
                host_to_ip[host] = ip

    unique_ips = list(set(host_to_ip.values()))
    if not unique_ips:
        return []

    geo = geolocate_ips(unique_ips)
    ip_to_country = {ip: geo.get(ip) for ip in unique_ips if geo.get(ip)}

    events = []
    seen_ips = set()
    for host, ip in host_to_ip.items():
        src = ip_to_country.get(ip)
        if src and ip not in seen_ips:
            seen_ips.add(ip)
            events.append({'src': src, 'tgt': pick_target('phishing', src), 'type': 'phishing', 'ip': ip, 'family': 'Phishing Site', 'first_seen': ''})
    return events


def fetch_blocklist_de():
    """Fetch attack IPs from Blocklist.de by category — no API key required."""
    feeds = [
        ('https://lists.blocklist.de/lists/ssh.txt',        'recon',   'SSH Brute Force'),
        ('https://lists.blocklist.de/lists/apache.txt',     'exploit', 'Web Exploit'),
        ('https://lists.blocklist.de/lists/bots.txt',       'ddos',    'Botnet'),
        ('https://lists.blocklist.de/lists/bruteforce.txt', 'recon',   'Brute Force'),
        ('https://lists.blocklist.de/lists/mail.txt',       'malware', 'Mail Spam'),
    ]
    ip_entries = []
    seen = set()

    for url, mtype, family_label in feeds:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'azimuth-threat-map/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                lines = r.read().decode('utf-8').splitlines()
            ips = [ln.strip() for ln in lines if ln.strip() and not ln.startswith('#')]
            sample = random.sample(ips, min(50, len(ips)))
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
        src = geo.get(ip)
        if src:
            events.append({'src': src, 'tgt': pick_target(mtype, src), 'type': mtype, 'ip': ip, 'family': family_label, 'first_seen': ''})
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

    sample = random.sample(ips, min(80, len(ips)))
    print(f'  Emerging Threats: geolocating {len(sample)} IPs...')
    geo = geolocate_ips(sample)

    events = []
    for ip in sample:
        src = geo.get(ip)
        if src:
            events.append({'src': src, 'tgt': pick_target('malware', src), 'type': 'malware', 'ip': ip, 'family': 'Compromised Host', 'first_seen': ''})
    return events


def fetch_abuseipdb(api_key):
    """Fetch blacklisted IPs from AbuseIPDB verbose endpoint."""
    CAT_TYPE = {
        4:  'ddos',
        7:  'phishing',
        14: 'recon', 18: 'recon', 22: 'recon', 5: 'recon',
        15: 'exploit', 16: 'exploit', 20: 'exploit', 21: 'exploit',
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

    sample = random.sample(entries, min(150, len(entries)))

    events = []
    for entry in sample:
        cc      = (entry.get('countryCode') or '').upper()
        src     = ISO_TO_COUNTRY.get(cc)
        if not src:
            continue
        ip         = entry.get('ipAddress', '')
        mtype      = pick_type(entry.get('categories', []))
        first_seen = (entry.get('lastReportedAt') or '')[:10]
        confidence = entry.get('abuseConfidenceScore', 0)
        events.append({'src': src, 'tgt': pick_target(mtype, src), 'type': mtype, 'ip': ip, 'family': 'AbuseIPDB', 'first_seen': first_seen, 'confidence': confidence})
    return events


def main():
    events = []

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

    abuseipdb_key = os.environ.get('ABUSEIPDB_KEY', '')
    if abuseipdb_key:
        print('Fetching AbuseIPDB...')
        try:
            ab = fetch_abuseipdb(abuseipdb_key)
            events.extend(ab)
            print(f'  {len(ab)} events')
        except Exception as e:
            print(f'  AbuseIPDB failed: {e}')
    else:
        print('Skipping AbuseIPDB (ABUSEIPDB_KEY not set)')

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

    out = Path(__file__).parent.parent / 'data' / 'iocs.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(events, separators=(',', ':')))
    print(f'Wrote {len(events)} indicators → {out}')


if __name__ == '__main__':
    main()
