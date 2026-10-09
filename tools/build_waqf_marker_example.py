#!/usr/bin/env python3
"""Build one visual placement example using three real PDF necessity stops.

Matching remains text-based. The existing word layout is used only to position
an SVG overlay above the unchanged Hafs page image.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = 504
SOURCE_ROWS = [4, 5, 8]


def read_js(path):
    return json.loads(path.read_text().rsplit('=', 1)[1].strip().rstrip(';'))


def build_example():
    report = json.loads((ROOT / 'data/waqf-pilot/report.json').read_text())
    source = next(page for page in report['pages'] if page['pdfPage'] == 500)
    layout = read_js(ROOT / f'data/ayah-layout-pages/{PAGE}.js')
    quran = read_js(ROOT / 'data/quran-data.js')
    ayat = {f"{a['s']}:{a['a']}": a['ar'] for a in quran}
    width, height = layout['page']['w'], layout['page']['h']
    markers = []
    for number in SOURCE_ROWS:
        row = next(row for row in source['rows'] if row['row'] == number)
        match = row.get('match')
        if row['stopSymbol'] != 'ف' or not match or match['page'] != PAGE or match['existingMarks']:
            raise ValueError(f'Example must be an unambiguous additional fa stop: {row["id"]}')
        ref, index = match['ref'], match['endWord']
        boxes = layout['ayat'][ref]
        real_tokens = [token for token in ayat[ref].split() if any('\u0621' <= c <= '\u063a' or '\u0641' <= c <= '\u064a' for c in token)]
        # The selected ayat are entirely on this page. Refuse to map different
        # text/layout tokenization by guessing or scaling word indices.
        positions = {w['i'] for b in boxes for w in b.get('words', [])}
        if positions != set(range(1, len(real_tokens) + 1)) or real_tokens[index-1] != match['stopAfter']:
            raise ValueError(f'Text and layout word indices need reconciliation: {ref}')
        line_box = next(b for b in boxes if any(w['i'] == index for w in b.get('words', [])))
        word = next(w for w in line_box['words'] if w['i'] == index)
        following = next((w for w in line_box['words'] if w['i'] == index+1), None)
        # Arabic ends on the left. Place in the trailing gap, not above the
        # center of the word or at its right-hand starting edge.
        trailing_edge = word['x']
        if following and following['x'] + following['w'] <= trailing_edge:
            x = (trailing_edge + following['x'] + following['w']) / 2
        else:
            x = max(0, trailing_edge - 0.006)
        # Float above the word's vocalization, keeping its existing ink clear.
        y = word['y'] - 0.003
        markers.append({
            'id': row['id'], 'symbol': 'ف', 'stopType': row['stopType'],
            'source': {'pdfPage': 500, 'row': number, 'phrase': row['phrase'], 'attribution': row['attribution']},
            'ref': ref, 'endWord': index, 'stopAfter': match['stopAfter'],
            'matchedText': match['matchedText'], 'line': line_box['l'], 'wordBox': word,
            'x': round(x, 6), 'y': round(y, 6),
        })
    return {'version': 1, 'prototype': True, 'page': PAGE, 'pdfPage': 500,
            'imageWidth': width, 'imageHeight': height, 'coordinateSpace': 'image-fraction',
            'markers': markers}


def main():
    data = build_example()
    out = ROOT / 'data/waqf-pilot'
    (out / 'marker-example.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    template = (ROOT / 'tools/waqf_marker_example.html').read_text()
    (out / 'marker-example.html').write_text(template.replace('__EXAMPLE__', json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')))
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
