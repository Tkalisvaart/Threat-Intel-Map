#!/usr/bin/env python3
"""
Fetch threat intel from abuse.ch and write data/iocs.json.
Run by GitHub Actions on a schedule — no CORS restrictions server-side.
"""
import json
import random
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
    if any(x in f for x in ('cobalt', 'asyncrat', 'remcos', 'njrat', 'plugx', 'quasar',
                             'darkcomet', 'nanocore', 'xworm', 'sliver', 'havoc', 'metasploit')):
        return 'c2'
    if any(x in f for x in ('ransomware', 'lockbit', 'blackcat', 'clop', 'conti',
                             'revil', 'hive', 'sodinokibi', 'akira', 'phobos')):
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
    if any(x in t for x in ('c2', 'cc', 'command', 'beacon')):
        return 'c2'
    if 'exploit' in t:
        return 'exploit'
    if any(x in t for x in ('recon', 'scan')):
        return 'recon'
    return 'malware'


def fetch_feodo():
    req = urllib.request.Request(
        'https://feodotracker.abuse.ch/downloads/ipblocklist.json',
        headers={'User-Agent': 'azimuth-threat-map/1.0'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        entries = json.loads(r.read())
    events = []
    for e in entries:
        cc  = (e.get('country') or '').upper()
        src = ISO_TO_COUNTRY.get(cc)
        if not src:
            continue
        mtype = map_malware_type(e.get('malware', ''))
        events.append({'src': src, 'tgt': pick_target(mtype, src), 'type': mtype})
    return events


def fetch_urlhaus():
    """URLhaus — malware URLs with hosting country, no auth required."""
    req = urllib.request.Request(
        'https://urlhaus-api.abuse.ch/v1/urls/recent/',
        data=b'limit=200',
        headers={'Content-Type': 'application/x-www-form-urlencoded',
                 'User-Agent': 'azimuth-threat-map/1.0'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())

    events = []
    for url in (data.get('urls') or []):
        cc  = (url.get('country') or '').upper()
        src = ISO_TO_COUNTRY.get(cc)
        if not src:
            continue
        threat = (url.get('threat') or '').lower()
        if 'phish' in threat:
            mtype = 'phishing'
        elif 'exploit' in threat:
            mtype = 'exploit'
        else:
            mtype = 'malware'
        events.append({'src': src, 'tgt': pick_target(mtype, src), 'type': mtype})
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

    print('Fetching URLhaus...')
    try:
        uh = fetch_urlhaus()
        events.extend(uh)
        print(f'  {len(uh)} events')
    except Exception as e:
        print(f'  URLhaus failed: {e}')

    # Shuffle so replay looks varied
    random.shuffle(events)

    out = Path(__file__).parent.parent / 'data' / 'iocs.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(events, separators=(',', ':')))
    print(f'Wrote {len(events)} events → {out}')


if __name__ == '__main__':
    main()
