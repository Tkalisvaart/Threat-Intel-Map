#!/usr/bin/env python3
"""
Azimuth dev server.
Serves static files AND proxies ThreatFox + IP geolocation so the
browser never hits CORS walls.

Run:  python3 serve.py
Then open http://localhost:8080
"""
from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
import urllib.request
import time
import threading
import random

THREATFOX_URL = 'https://threatfox-api.abuse.ch/api/v1/'
IPAPI_BATCH   = 'http://ip-api.com/batch'
CACHE_TTL     = 60   # seconds between ThreatFox refreshes

# Countries the frontend knows about (must match js/data.js GEO keys)
KNOWN_COUNTRIES = {
    'China', 'United States', 'Russia', 'Brazil', 'India', 'Germany',
    'Netherlands', 'France', 'United Kingdom', 'South Korea', 'Japan',
    'Ukraine', 'Vietnam', 'Iran', 'Turkey', 'Indonesia', 'Mexico',
    'Pakistan', 'Nigeria', 'South Africa', 'Australia', 'Canada',
    'Argentina', 'Egypt', 'Romania', 'Bulgaria', 'Poland',
    'North Korea', 'Belarus', 'Israel',
}

# Plausible target countries per threat type (real targets aren't in the feed)
TARGETS = {
    'malware':  ['United States', 'Germany', 'United Kingdom', 'Australia', 'Canada'],
    'phishing': ['United States', 'United Kingdom', 'Germany', 'France', 'Australia'],
    'c2':       ['United States', 'Germany', 'Japan', 'United Kingdom', 'France'],
    'exploit':  ['United States', 'Germany', 'France', 'Japan', 'South Korea'],
    'recon':    ['United States', 'Germany', 'Japan', 'United Kingdom', 'Australia'],
    'ddos':     ['United States', 'Germany', 'France', 'South Korea', 'Japan'],
}

_cache = {'data': [], 'ts': 0}
_lock  = threading.Lock()


def map_threat_type(raw):
    t = (raw or '').lower()
    if 'botnet' in t or 'payload' in t or 'malware' in t:
        return 'malware'
    if 'phishing' in t:
        return 'phishing'
    if 'c2' in t or 'cc' in t or 'command' in t:
        return 'c2'
    if 'exploit' in t:
        return 'exploit'
    if 'recon' in t or 'scan' in t:
        return 'recon'
    return 'malware'


def fetch_iocs():
    # 1. Pull latest IOCs from ThreatFox
    payload = json.dumps({'query': 'get_iocs', 'days': 1}).encode()
    req = urllib.request.Request(
        THREATFOX_URL,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=12) as r:
        data = json.loads(r.read())

    ip_iocs = [
        ioc for ioc in (data.get('data') or [])
        if ioc.get('ioc_type') == 'ip:port'
    ][:80]

    if not ip_iocs:
        return []

    # 2. Batch geolocate all IPs in one request (ip-api allows up to 100)
    ips = [ioc['ioc_value'].split(':')[0] for ioc in ip_iocs]
    geo_payload = json.dumps([{'query': ip} for ip in ips]).encode()
    geo_req = urllib.request.Request(
        IPAPI_BATCH,
        data=geo_payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(geo_req, timeout=12) as r:
        geo_results = json.loads(r.read())

    country_map = {
        r['query']: r.get('country')
        for r in geo_results
        if r.get('status') == 'success'
    }

    # 3. Build events
    events = []
    for ioc in ip_iocs:
        ip  = ioc['ioc_value'].split(':')[0]
        src = country_map.get(ip)
        if not src or src not in KNOWN_COUNTRIES:
            continue
        ttype   = map_threat_type(ioc.get('threat_type', ''))
        options = [c for c in TARGETS.get(ttype, ['United States']) if c != src]
        tgt     = random.choice(options) if options else 'United States'
        events.append({'src': src, 'tgt': tgt, 'type': ttype})

    return events


def get_iocs():
    with _lock:
        if time.time() - _cache['ts'] > CACHE_TTL:
            try:
                _cache['data'] = fetch_iocs()
                _cache['ts']   = time.time()
                print(f'[ThreatFox] refreshed — {len(_cache["data"])} events')
            except Exception as e:
                print(f'[ThreatFox] error: {e}')
        return _cache['data']


class AzimuthHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] == '/api/iocs':
            events = get_iocs()
            body   = json.dumps(events).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def log_message(self, fmt, *args):
        print('[HTTP]', fmt % args)


if __name__ == '__main__':
    print('Azimuth server → http://localhost:8080')
    HTTPServer(('0.0.0.0', 8080), AzimuthHandler).serve_forever()
