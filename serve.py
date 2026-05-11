#!/usr/bin/env python3
"""
Azimuth local dev server.

Run:  python3 serve.py
Then open http://localhost:8080

The server refreshes data/iocs.json immediately on startup, then every hour,
by running scripts/fetch_iocs.py in the background.

Optional API keys — create a .env file in this directory:
  ABUSEIPDB_KEY=your_key
  THREATFOX_KEY=your_key
  MAXMIND_ACCOUNT_ID=your_account_id
  MAXMIND_LICENSE_KEY=your_license_key
"""

import os
import socket
import sys
import subprocess
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PORT             = 8080
ROOT             = Path(__file__).parent
REFRESH_INTERVAL = 3600  # seconds between data refreshes


def load_dotenv():
    env_file = ROOT / '.env'
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, val = line.partition('=')
        os.environ.setdefault(key.strip(), val.strip())


def run_fetch():
    print('[intel] refreshing threat data...')
    try:
        result = subprocess.run(
            [sys.executable, str(ROOT / 'scripts' / 'fetch_iocs.py')],
            cwd=str(ROOT),
            timeout=300,
        )
        status = 'complete' if result.returncode == 0 else f'exited {result.returncode}'
        print(f'[intel] {status}')
    except Exception as e:
        print(f'[intel] error: {e}')


def refresh_loop():
    run_fetch()
    while True:
        time.sleep(REFRESH_INTERVAL)
        run_fetch()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        code = args[1] if len(args) > 1 else ''
        if code not in ('200', '304'):
            print('[http]', fmt % args)


if __name__ == '__main__':
    skip_refresh = any(a in ('-skip-ioc-refresh', '--skip-ioc-refresh') for a in sys.argv)

    load_dotenv()

    print(f'Azimuth dev server → http://localhost:{PORT}')
    keys = [k for k in ('ABUSEIPDB_KEY', 'THREATFOX_KEY', 'MAXMIND_ACCOUNT_ID') if os.environ.get(k)]
    if keys:
        print(f'  API keys: {", ".join(keys)}')
    else:
        print('  No .env found — AbuseIPDB / ThreatFox / MaxMind feeds will be skipped or limited')
    if skip_refresh:
        print('  IOC refresh: disabled (--skip-ioc-refresh)')
    print()

    try:
        HTTPServer.allow_reuse_address = True
        server = HTTPServer(('0.0.0.0', PORT), Handler)
        print(f'Ready — open http://localhost:{PORT}')
        if not skip_refresh:
            threading.Thread(target=refresh_loop, daemon=True).start()
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
