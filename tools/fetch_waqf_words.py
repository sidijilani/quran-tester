#!/usr/bin/env python3
"""Cache Quran.com word text for the offline waqf-to-layout bridge.

This fetches text and metadata, never images. The import itself uses the saved
snapshot and does not need a network connection. Use --refresh deliberately:
upstream word positions can change and require a fresh layout audit.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
URL = ('https://api.quran.com/api/v4/verses/by_page/{page}'
       '?words=true&word_fields=line_number,page_number,position,text_uthmani&per_page=all')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Replace cached upstream responses')
    parser.add_argument('--output', type=Path, default=ROOT/'data/sources/waqf-qurancom-words.json')
    args = parser.parse_args()
    cache = ROOT/'tmp/waqf/quran-words-pages'
    cache.mkdir(parents=True, exist_ok=True)

    def fetch(page):
        path = cache/f'{page}.json'
        if not path.exists() or args.refresh:
            result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--retry', '3',
                                     '--max-time', '60', URL.format(page=page)],
                                    check=True, capture_output=True, text=True)
            data = json.loads(result.stdout)
            if not data.get('verses') or data.get('pagination', {}).get('next_page'):
                raise ValueError(f'Incomplete upstream response for page {page}')
            path.write_text(result.stdout)
        return json.loads(path.read_text())

    verses = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for data in pool.map(fetch, range(1, 605)):
            for verse in data['verses']:
                words = [{'i': int(w['position']), 'ar': w['text_uthmani'],
                          'page': int(w['page_number']), 'line': int(w['line_number'])}
                         for w in verse['words'] if w['char_type_name'] == 'word']
                ref = verse['verse_key']
                if ref in verses and verses[ref] != words:
                    raise ValueError(f'Conflicting word metadata for {ref}')
                if len({w['i'] for w in words}) != len(words) or not words:
                    raise ValueError(f'Invalid word positions for {ref}')
                verses[ref] = words
    if len(verses) != 6236:
        raise ValueError(f'Expected all 6236 verses; received {len(verses)}')
    destination = args.output
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = {'version': 1, 'source': URL,
               'snapshotCreatedAt': datetime.now(timezone.utc).isoformat(), 'verses': verses}
    destination.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':'))+'\n')
    print(f'Saved {len(verses)} verses to {destination}')


if __name__ == '__main__':
    main()
