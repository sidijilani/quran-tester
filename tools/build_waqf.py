#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pdfplumber>=0.11,<0.12"]
# ///
"""Extract every source table and export supplemental stops by Madani page.

Phrase matching uses Hafs text, never image pixels. Quran.com word text bridges
the local verse tokens to the existing layout's positions, including joined
vocatives. Unknown wording, order conflicts and uncertain geometry are audited,
not guessed. The pilot and its examples are preserved.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from functools import lru_cache
import json
from pathlib import Path
import re

import pdfplumber

from build_waqf_pilot import ROOT, MARKS, TYPES, Reference, normalize, rtl_text, read_js, resolve_order, sha256, js_write

# Source title mistakes verified against the printed page number and its Hafs
# text. Corrections change the chapter scope only; original titles are retained.
TITLE_CORRECTIONS = {
    (153, 151): (6, 7), (154, 152): (6, 7), (155, 153): (6, 7),
    (191, 189): (8, 9), (430, 426): (19, 33), (431, 427): (19, 33),
    (440, 436): (34, 35), (453, 454): (36, 38), (480, 484): (34, 42),
    (507, 512): (47, 48), (512, 517): (50, 49), (554, 584): (73, 79),
    (555, 590): (83, 85), (556, 598): (83, 98),
}
NAME_ALIASES = {
    'توبة': 9, 'الانبئاء': 21, 'االقصص': 28, 'سباء': 34,
    'شورى': 42, 'الحاثية': 45, 'الأحقاب': 46, 'الرحمان': 55,
}
SOURCE_TYPES = {**TYPES, 'لازم': {'code': 'lazim', 'meaning': 'Source labels this stop لازم'}}
# Explicit orthographic differences between the two Hafs text encodings, after
# layout_normalize. Never accept an arbitrary one-to-one word substitution.
LAYOUT_SPELLING_PAIRS = {
    ('ويبسط', 'ويبصط'), ('لرب', 'لربو'), ('فن', 'فين'), ('نب', 'نبي'),
    ('بلغدة', 'بلغدوة'), ('ري', 'ر'), ('بسطة', 'بصطة'), ('ومله', 'ومليه'),
    ('سريكم', 'سوريكم'), ('صلتك', 'صلوتك'), ('وملهم', 'ومليهم'),
    ('لدي', 'لد'), ('لقصي', 'لقص'), ('وري', 'ور'), ('كمشكة', 'كمشكوة'),
    ('تري', 'تر'), ('تني', 'تن'), ('قصي', 'قص'), ('لنجة', 'لنجوة'),
    ('ومنة', 'ومنوة'), ('طغي', 'طغ'), ('يلفهم', 'لفهم'),
}


def parse_title(text, names, pdf_page, previous=None):
    compact = normalize(text)
    is_page = 'صفحة' in compact
    aliases = {**names, **{normalize(k): v for k, v in NAME_ALIASES.items()}}
    bare = compact.startswith('سورة') or compact in aliases
    if not is_page and not bare:
        return None
    if not is_page and re.search(r'(?:^|\s)(?:ج|ف|لازم)(?:\s|$)', text):
        return None  # A stop after the word سورة, not a new chapter title.
    if is_page:
        number_text = re.sub(r'\s*\+\s*', '+', text)
        numbers = re.findall(r'\d+(?:\+\d+)*', number_text)
        if pdf_page == 99 and numbers == ['7', '9']:
            pages = [97]  # The two separated RTL digit glyphs print 97.
        elif len(numbers) == 1:
            pages = sorted({int(n) for n in numbers[0].split('+')})
        else:
            raise ValueError(f'PDF {pdf_page}: cannot read heading numbers: {text!r}')
    elif previous:
        pages = previous['mushafPages']
    else:
        raise ValueError(f'PDF {pdf_page}: chapter heading lacks a page context: {text!r}')
    if not pages or any(n < 1 or n > 604 for n in pages):
        raise ValueError(f'PDF {pdf_page}: invalid mushaf page in {text!r}')
    # Search names longest first; a short chapter name must not match inside
    # another title (e.g. الحجر inside الحجرات, or ص inside القصص).
    rest = re.sub(r'^(?:ا?صفحة).*?(?:من(?:سورة)?|سورة)', '', compact)
    rest = re.sub(r'\d+', '', rest)
    if compact in ('صفحةعدد', 'صفحة'):
        rest = ''
    spans = []
    for name, surah in sorted(aliases.items(), key=lambda pair: -len(pair[0])):
        for found in re.finditer(re.escape(name), rest):
            start, end = found.span()
            if len(name) <= 2 and not (rest == name or start == 0 or rest[:start].endswith(('سورة', 'بداية'))):
                continue
            if any(start < right and end > left for left, right, _ in spans):
                continue
            spans.append((start, end, surah))
    surahs = list(dict.fromkeys(s for _, _, s in sorted(spans)))
    if not surahs and is_page and previous and compact in ('صفحةعدد', 'صفحة'):
        surahs = previous['surahs']
    # A page-only heading after a combined chapter heading retains that scope.
    if not surahs and is_page and previous and not ('سورة' in compact or 'من' in compact):
        surahs = previous['surahs']
    result = {'title': text, 'mushafPages': pages, 'surahs': surahs,
              'surah': surahs[0] if len(surahs) == 1 else None, 'surahName': rest}
    if pdf_page == 99 and re.findall(r'\d+', text) == ['7', '9']:
        result['numberRecovery'] = 'Separated RTL heading digits: 97'
    for page in pages:
        correction = TITLE_CORRECTIONS.get((pdf_page, page))
        if correction and surahs == [correction[0]]:
            result['titleCorrection'] = {'printedSurah': correction[0], 'matchedSurah': correction[1],
                                         'reason': 'Printed page and its verse text identify the chapter; source chapter title is incorrect'}
            result['surahs'] = [correction[1]]
            result['surah'] = correction[1]
    return result


def extract_full_page(pdf, number, reference, previous=None):
    page = pdf.pages[number - 1].dedupe_chars()
    if not page.chars or not rtl_text(page).strip():
        if page.images and number != 557:
            raise ValueError(f'PDF {number}: image-only content must be inspected')
        # PDF 557 is an inspected image of prose about pauses, not a stop table.
        status = 'prose_image' if page.images else 'blank'
        return {'pdfPage': number, 'status': status, 'headings': [], 'rows': [], 'skippedRows': []}, previous
    if number == 558 and 'المجموعة' in rtl_text(page):
        return {'pdfPage': number, 'status': 'credits', 'headings': [], 'rows': [], 'skippedRows': []}, previous
    headings = []
    current = previous
    for line in page.extract_text_lines():
        bbox = (max(0, line['x0']-1), max(0, line['top']-1), min(page.width, line['x1']+1), min(page.height, line['bottom']+1))
        text = rtl_text(page, bbox)
        heading = parse_title(text, reference.names, number, current)
        if heading:
            heading.update(top=line['top'], bbox=list(bbox), pdfPage=number)
            headings.append(heading)
            current = heading
    tables = page.find_tables()
    if not tables:
        raise ValueError(f'PDF {number}: nonblank content has no table')
    if previous:
        carried = {**previous, 'top': -1, 'bbox': None, 'inheritedFromPdfPage': previous['pdfPage']}
        headings.insert(0, carried)
    if not headings:
        raise ValueError(f'PDF {number}: table has no chapter/page context')
    rows, skipped, seen = [], [], set()
    for table in tables:
        # Use the majority of three-column rows to recover cells when a source
        # row is missing its vertical rules. Do not split the Arabic string.
        column_sets = Counter(tuple(round(c[2], 1) for c in row.cells[:2])
                              for row in table.rows if len(row.cells) >= 3 and all(row.cells[:3])
                              and row.cells[0][2]-row.cells[0][0] < (table.bbox[2]-table.bbox[0])*0.8)
        boundaries = column_sets.most_common(1)[0][0] if column_sets else None
        for table_row in table.rows:
            bbox = list(table_row.bbox)
            key = tuple(round(v, 1) for v in bbox)
            if key in seen:
                continue
            seen.add(key)
            cells = table_row.cells
            texts = [rtl_text(page, cell) if cell else '' for cell in cells]
            joined = ' '.join(t for t in texts if t)
            if not joined.strip():
                skipped.append({'bbox': bbox, 'reason': 'blank'})
                continue
            if 'صفحة' in normalize(joined) or normalize(joined).startswith('سورة') or normalize(joined) in {normalize(k) for k in NAME_ALIASES} | set(reference.names):
                skipped.append({'bbox': bbox, 'reason': 'embedded heading'})
                continue
            if 'نوعالوقف' in normalize(joined) or normalize(joined).startswith('لمنيسند'):
                skipped.append({'bbox': bbox, 'reason': 'column headings'})
                continue
            recovered = False
            if len(cells) >= 3 and cells[0] and not cells[1] and not cells[2] and boundaries:
                edges = [bbox[0], *boundaries, bbox[2]]
                texts = [rtl_text(page, (edges[i], bbox[1], edges[i+1], bbox[3])) for i in range(3)]
                recovered = True
            if len(texts) < 3 or any(t.strip() for t in texts[3:]):
                raise ValueError(f'PDF {number}: unrecognized table structure: {texts!r}')
            phrase, symbol = texts[2].strip(), texts[1].strip()
            if not normalize(phrase):
                if not normalize(texts[0]) and (not symbol or symbol in SOURCE_TYPES):
                    skipped.append({'bbox': bbox, 'reason': 'empty stop placeholder', 'stopSymbol': symbol})
                    continue
                raise ValueError(f'PDF {number}: populated row without a phrase: {texts!r}')
            applicable = [h for h in headings if h['top'] < bbox[1]]
            if not applicable:
                raise ValueError(f'PDF {number}: row has no preceding heading')
            category_symbol = symbol if symbol in SOURCE_TYPES else normalize(symbol)
            source_type = SOURCE_TYPES.get(category_symbol, {'code': 'unspecified', 'meaning': 'Source category absent or unrecognized'})
            issues = [] if category_symbol in SOURCE_TYPES else ['missing_stop_category' if not symbol else 'unrecognized_stop_category']
            rows.append({'id': f'pdf-{number}-row-{len(rows)+1}', 'pdfPage': number, 'row': len(rows)+1,
                         'bbox': bbox, 'heading': applicable[-1], 'phrase': phrase,
                         'stopSymbol': symbol, 'stopType': source_type['code'], 'categoryIssues': issues,
                         'attribution': texts[0], 'recoveredColumns': recovered,
                         'rawCellsLtr': [page.crop(c).extract_text() if c else '' for c in cells]})
    return {'pdfPage': number, 'status': 'tables', 'width': page.width, 'height': page.height,
            'tableCount': len(tables), 'headings': headings, 'rows': rows, 'skippedRows': skipped}, current


def layout_normalize(text):
    """Orthographic skeleton ONLY for bridging two Hafs text tokenizations.

    This deliberately broader normalization never participates in PDF matching.
    Full ordered verses and minimum-cost boundary consensus guard the bridge.
    """
    text = text.replace('ىٰ', 'ا').replace('ىِۦ', 'يي').replace('ئ', 'ء').replace('ؤ', 'ء')
    text = normalize(text.replace('\u0670', 'ا').replace('\u06e7', 'ي'))
    for a, b in [('صلواة', 'صلاة'), ('صلوة', 'صلاة'), ('زكواة', 'زكاة'),
                 ('زكوة', 'زكاة'), ('حيواة', 'حياة'), ('حيوة', 'حياة')]:
        text = text.replace(a, b)
    text = text.translate(str.maketrans({'ا': None, 'ء': None}))
    return re.sub(r'(.)\1+', r'\1', text)


def align_word_ends(local_words, metadata_words):
    """Return endpoints shared by ALL minimum-cost whole-verse alignments.

    Exact one-to-one words cost zero; known joined/split text costs one per
    boundary removed. A one-to-one orthographic substitution costs four and is
    recorded. No arbitrary nonmatching merge or approximate index scaling.
    """
    left = [w['text'] for w in local_words]
    right = [w['ar'] for w in metadata_words]

    @lru_cache(None)
    def options(i, j):
        values = []
        for a in range(1, min(3, len(left)-i)+1):
            for b in range(1, min(3, len(right)-j)+1):
                if a > 1 and b > 1:
                    continue
                l, r = ''.join(left[i:i+a]), ''.join(right[j:j+b])
                if layout_normalize(l) == layout_normalize(r):
                    values.append((a, b, a+b-2))
                elif a == b == 1 and (layout_normalize(l), layout_normalize(r)) in LAYOUT_SPELLING_PAIRS:
                    values.append((a, b, 4))
                elif normalize(l) == 'وانلو' and normalize(r) == 'والو':
                    values.append((a, b, a+b-2))  # Joined Uthmani وَأَلَّوِ.
        return values

    @lru_cache(None)
    def cost(i, j):
        if i == len(left) and j == len(right):
            return 0
        return min((weight+cost(i+a, j+b) for a, b, weight in options(i, j)), default=float('inf'))

    if cost(0, 0) == float('inf'):
        return {}, {'status': 'unreconciled', 'localWords': len(left), 'layoutWords': len(right)}
    possibilities, changes, visited = defaultdict(set), [], set()

    def walk(i, j):
        if (i, j) in visited:
            return
        visited.add((i, j))
        for a, b, weight in options(i, j):
            if weight+cost(i+a, j+b) != cost(i, j):
                continue
            for internal in range(i+1, i+a):
                possibilities[internal].add(None)  # Inside a joined image word.
            possibilities[i+a].add(metadata_words[j+b-1]['i'])
            if weight:
                changes.append({'localRange': [i+1, i+a], 'layoutRange': [metadata_words[j]['i'], metadata_words[j+b-1]['i']],
                                'localText': ' '.join(left[i:i+a]), 'layoutText': ' '.join(right[j:j+b]),
                                'kind': 'orthographic_substitution' if a == b == 1 else 'joined_or_split_words'})
            walk(i+a, j+b)

    walk(0, 0)
    mapping = {i: next(iter(values)) for i, values in possibilities.items() if len(values) == 1 and None not in values}
    return mapping, {'status': 'aligned', 'localWords': len(left), 'layoutWords': len(right),
                     'cost': cost(0, 0), 'changes': changes, 'unmappedWordEnds': sorted(set(range(1, len(left)+1))-set(mapping))}


class WordLocator:
    def __init__(self, root, reference):
        self.reference = reference
        self.word_source = read_json(root / 'data/sources/waqf-qurancom-words.json')
        self.metadata = self.word_source['verses']
        self.maps, self.alignment, self.layout = {}, {}, {}
        for ref, words in reference.words.items():
            self.maps[ref], self.alignment[ref] = align_word_ends(words, self.metadata[ref])
        for n in range(1, 605):
            self.layout[n] = read_js(root / f'data/ayah-layout-pages/{n}.js')

    def locate(self, anchor):
        ref, local_index = anchor['ref'], anchor['endWord']
        index = self.maps[ref].get(local_index)
        if index is None:
            return None, 'word_boundary_not_proven_in_layout'
        word = next(w for w in self.metadata[ref] if w['i'] == index)
        # Existing image layouts determine the physical page. The upstream
        # word text snapshot occasionally reports an adjacent page; retain
        # that discrepancy rather than moving a mark away from its image.
        hits = [(p, b, w) for p in anchor['versePages']
                for b in self.layout[p]['ayat'].get(ref, [])
                for w in b.get('words', []) if w['i'] == index]
        if len(hits) != 1:
            return None, 'layout_word_box_missing_or_duplicate'
        page, line, box = hits[0]
        payload = self.layout[page]
        if line['l'] != word['line']:
            return None, 'word_text_and_layout_line_disagree'
        # The gap may cross an ayah boundary; inspect all words on this line.
        following = [w for bs in payload['ayat'].values() for b in bs if b['l'] == line['l']
                     for w in b.get('words', []) if w['x']+w['w'] <= box['x']]
        next_edge = max((w['x']+w['w'] for w in following), default=None)
        w, h = payload['page']['w'], payload['page']['h']
        # Stay close to this word even when a large gap contains an ayah medallion
        # or a printed stop glyph; the far end of that gap is not our endpoint.
        x = box['x']-min(4/w, (box['x']-next_edge)/2) if next_edge is not None else max(0, box['x']-4/w)
        # Identical to the approved prototype: 17 px lozenge, lowered 7 px.
        size = 17
        top = box['y']*h-3-17+7
        if top < 24:
            # The first line has no interline space above it. Keep its smaller
            # marker in the word gap below the ornamental header.
            top, size = 24, 12
        line_top = top+size*0.93+2
        line_bottom = (box['y']+box['h'])*h-4
        geometry = {'x': round(x, 6), 'top': round(top/h, 6), 'size': size,
                    'lineTop': round(line_top/h, 6), 'lineBottom': round(max(line_top, line_bottom)/h, 6)}
        # Thin separators need a real clear gap; never route through a word box.
        placement_issue = 'no_clear_gap_for_separator' if next_edge is not None and (box['x']-next_edge)*w < 0.99 else None
        if not (0 < geometry['x'] < 1 and 0 <= geometry['top'] < geometry['lineBottom'] <= 1):
            return None, 'marker_outside_page'
        return {'page': page, 'layoutWord': index, 'layoutText': word['ar'], 'line': line['l'],
                'wordMetadataPage': word['page'], 'wordMetadataPageMismatch': page != word['page'],
                'wordBox': box, 'geometry': geometry,
                'placementIssue': placement_issue,
                'sourcePageHints': anchor['sourcePageHints'], 'pageHintMismatch': page not in anchor['sourcePageHints'],
                'imageExistingMarks': sorted({c for c in word['ar'] if c in MARKS}),
                'layoutMappingChanged': local_index != index}, None


def read_json(path):
    return json.loads(path.read_text())


def build_reference(root):
    reference = Reference(root)
    word_pages = read_json(root/'data/sources/waqf-qurancom-words.json')['verses']
    layout_pages = defaultdict(list)
    for page in range(1, 605):
        for ref in read_js(root/f'data/ayah-layout-pages/{page}.js')['ayat']:
            layout_pages[ref].append(page)
    differences = {}
    for ref, words in word_pages.items():
        upstream = sorted({w['page'] for w in words})
        actual = sorted(layout_pages.get(ref, reference.pages_by_ref[ref]))
        old = reference.pages_by_ref[ref]
        if actual != upstream or actual != old:
            differences[ref] = {'legacyVersePages': old, 'wordMetadataPages': upstream, 'imageLayoutPages': actual}
        reference.pages_by_ref[ref] = actual
        for page in actual:
            if ref not in reference.refs_by_page[page]:
                reference.refs_by_page[page].append(ref)
    # Preserve legacy verse context during phrase search: the source is a Qalun
    # table and a verse/page hint need not share the Hafs image's boundary. Its
    # exact word endpoint is assigned using the existing image word layout,
    # after reconciling the local verse with the upstream word text.
    reference.page_reconciliation = differences
    return reference


def match_full_page(source, reference, transcriptions):
    groups = defaultdict(list)
    for row in source['rows']:
        correction = transcriptions.get(row['id'])
        if correction:
            if row['phrase'] != correction['extractedPhrase']:
                raise ValueError(f'Correction no longer matches {row["id"]}')
            row['transcription'] = correction
        phrase = correction['transcribedPhrase'] if correction else row['phrase']
        heading = row['heading']
        pages, surahs = heading['mushafPages'], heading['surahs']
        present = {int(ref.split(':')[0]) for n in pages for ref in reference.refs_by_page[n]}
        row['headingIssues'] = [] if set(surahs) & present else ['unrecognized_or_conflicting_chapter_title']
        row['candidates'] = [c for c in reference.candidates(phrase, pages, None) if int(c['ref'].split(':')[0]) in surahs]
        row['matchStatus'] = 'heading_conflict' if row['headingIssues'] else 'unmatched'
        row['reviewStatus'] = 'pending'
        row['classification'] = 'unresolved'
        if row['headingIssues'] or not row['candidates']:
            row['samePageSuggestions'] = reference.candidates(phrase, pages, None)
        groups[heading['top']].append(row)
    for rows in groups.values():
        resolve_order(rows)
    for row in source['rows']:
        if row['matchStatus'] == 'ambiguous':
            row['ambiguity'] = {'groupId': row['id'], 'candidateCount': len(row['feasibleCandidates']),
                                'reason': 'Repeated source wording remains ambiguous after row order checks'}
            row['potentialMatches'] = row['feasibleCandidates']


def compile_stops(sources, reference, locator):
    page_stops, issues, used_rows = defaultdict(list), [], set()
    for source in sources:
        for row in source['rows']:
            matches = row.get('potentialMatches', [row['match']] if row.get('match') else [])
            if not matches:
                issues.append({'sourceRowId': row['id'], 'pdfPage': row['pdfPage'], 'phrase': row['phrase'],
                               'pageHints': row['heading']['mushafPages'], 'reason': row['matchStatus']})
            for match in matches:
                position, error = locator.locate(match)
                if error:
                    issues.append({'sourceRowId': row['id'], 'pdfPage': row['pdfPage'], 'phrase': row['phrase'],
                                   'pageHints': row['heading']['mushafPages'], 'ref': match['ref'], 'endWord': match['endWord'], 'reason': error})
                    continue
                marks = sorted(set(match['existingMarks']) | set(position['imageExistingMarks']))
                classification = 'existing_mark' if marks else 'ayah_end' if match['ayahEnd'] else 'additional'
                ambiguous = bool(row.get('ambiguity'))
                display_requested = classification == 'additional' or ambiguous
                if display_requested and position['placementIssue']:
                    issues.append({'sourceRowId': row['id'], 'pdfPage': row['pdfPage'], 'phrase': row['phrase'],
                                   'pageHints': row['heading']['mushafPages'], 'ref': match['ref'],
                                   'endWord': match['endWord'], 'reason': position['placementIssue']})
                stop = {'id': f'{row["id"]}:{match["ref"]}:{match["endWord"]}', 'sourceRowId': row['id'],
                        'ref': match['ref'], 'startWord': match['startWord'], 'endWord': match['endWord'],
                        'phrase': row['phrase'], 'matchedText': match['matchedText'], 'stopAfter': match['stopAfter'],
                        'stopSymbol': row['stopSymbol'], 'stopType': row['stopType'], 'categoryIssues': row['categoryIssues'],
                        'classification': classification, 'existingMarks': marks, 'ambiguous': ambiguous,
                        'ambiguity': row.get('ambiguity'), 'displayRequested': display_requested,
                        'display': display_requested and not position['placementIssue'],
                        'source': {'pdfPage': row['pdfPage'], 'row': row['row'], 'attribution': row['attribution'],
                                   'printedTitle': row['heading']['title'], 'titleCorrection': row['heading'].get('titleCorrection')},
                        **position}
                page_stops[position['page']].append(stop)
                used_rows.add(row['id'])
    # Different source rows can propose the same boundary. Keep provenance in
    # stops; draw only one marker there, with all supporting rows attached.
    pages = {}
    for n in range(1, 605):
        stops = sorted(page_stops[n], key=lambda s: (tuple(map(int, s['ref'].split(':'))), s['endWord'], s['sourceRowId']))
        grouped = {}
        for stop in stops:
            if not stop['display']:
                continue
            key = (stop['ref'], stop['endWord'])
            if key not in grouped:
                grouped[key] = {'id': f'{stop["ref"]}:{stop["endWord"]}', 'ref': stop['ref'], 'endWord': stop['endWord'],
                                'stopAfter': stop['stopAfter'], 'geometry': stop['geometry'], 'ambiguous': stop['ambiguous'],
                                'sourceIds': [], 'ambiguityGroups': [], 'stopTypes': []}
            marker = grouped[key]
            marker['ambiguous'] |= stop['ambiguous']
            marker['sourceIds'].append(stop['id'])
            if stop['stopType'] not in marker['stopTypes']:
                marker['stopTypes'].append(stop['stopType'])
            if stop['ambiguity'] and stop['ambiguity']['groupId'] not in marker['ambiguityGroups']:
                marker['ambiguityGroups'].append(stop['ambiguity']['groupId'])
        for marker in grouped.values():
            marker['stopType'] = next((kind for kind in ('lazim', 'jaiz', 'necessity', 'unspecified') if kind in marker['stopTypes']), 'unspecified')
        pages[n] = {'version': 1, 'page': n, 'imageWidth': locator.layout[n]['page']['w'],
                    'imageHeight': locator.layout[n]['page']['h'], 'stops': stops, 'markers': list(grouped.values()),
                    'unresolved': [i for i in issues if n in i['pageHints']]}
    return pages, issues, used_rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=ROOT/'data/Woukoufet-Al-Koran-V2.pdf')
    parser.add_argument('--output', type=Path, default=ROOT/'data/waqf')
    args = parser.parse_args()
    reference = build_reference(ROOT)
    correction_source = read_json(ROOT/'data/sources/waqf-pilot-transcriptions.json')
    if correction_source['pdfSha256'] != sha256(args.pdf):
        parser.error('Source PDF changed: transcription and title corrections must be checked again')
    corrections = {c['id']: c for c in correction_source['corrections']}
    sources, previous = [], None
    with pdfplumber.open(args.pdf) as pdf:
        pdf_count = len(pdf.pages)
        for number in range(5, pdf_count+1):
            source, previous = extract_full_page(pdf, number, reference, previous)
            match_full_page(source, reference, corrections)
            sources.append(source)
            pdf.pages[number-1].close()
            if number % 50 == 0:
                print(f'Scanned PDF page {number}/{pdf_count}', flush=True)
    locator = WordLocator(ROOT, reference)
    pages, issues, used_rows = compile_stops(sources, reference, locator)
    rows = [r for p in sources for r in p['rows']]
    stops = [s for p in pages.values() for s in p['stops']]
    summary = {'scannedPdfPages': len(sources), 'tablePdfPages': sum(s['status'] == 'tables' for s in sources),
               'sourceRows': len(rows), 'locatedSourceRows': len(used_rows), 'locatedStops': len(stops),
               'newStopLocations': sum(s['classification'] == 'additional' for s in stops),
               'existingStopLocations': sum(s['classification'] == 'existing_mark' for s in stops),
               'ayahEndLocations': sum(s['classification'] == 'ayah_end' for s in stops),
               'displayedMarkers': sum(len(p['markers']) for p in pages.values()),
               'pagesWithMarkers': sum(bool(p['markers']) for p in pages.values()),
               'ambiguousSourceRows': sum(r['matchStatus'] == 'ambiguous' for r in rows),
               'ambiguousMarkers': sum(m['ambiguous'] for p in pages.values() for m in p['markers']),
               'unlocatedSourceRows': len(rows)-len(used_rows), 'unresolvedLocations': len(issues),
               'matchStatuses': dict(Counter(r['matchStatus'] for r in rows)),
               'issueReasons': dict(Counter(i['reason'] for i in issues)),
               'stopSymbols': dict(Counter(r['stopSymbol'] for r in rows))}
    source_meta = {'file': 'data/Woukoufet-Al-Koran-V2.pdf', 'sha256': sha256(args.pdf), 'totalPdfPages': pdf_count,
                   'reading': 'Qalun an Nafi (introduction, PDF page 3)', 'scannedPdfRange': [5, pdf_count]}
    reference_meta = {'reading': 'Hafs', 'textSha256': sha256(ROOT/'data/quran-data.js'),
                      'pageMetadataSha256': sha256(ROOT/'data/line-bands.js'),
                      'wordMetadataSha256': sha256(ROOT/'data/sources/waqf-qurancom-words.json'),
                      'wordMetadataSource': locator.word_source['source'], 'matching': 'local verse text only',
                      'placementPages': 'existing local image word layouts; upstream line agreement required'}
    reference_meta['pageReconciliation'] = reference.page_reconciliation
    out = args.output
    (out/'pages').mkdir(parents=True, exist_ok=True)
    for n, payload in pages.items():
        js_write(out/f'pages/{n}.js', 'QURAN_WAQF_PAGES', payload, n)
    manifest = {'version': 1, 'source': source_meta, 'reference': reference_meta, 'summary': summary,
                'markerStyle': {'size': 17, 'separatorWidth': 1, 'lowering': 7,
                                'jaiz': {'ink': '#873d50', 'shape': 'filled_lozenge'},
                                'necessity': {'ink': '#737373', 'shape': 'open_lozenge'},
                                'unspecified': {'ink': '#947039', 'shape': 'open_lozenge'}},
                'pages': {str(n): {'markers': len(p['markers']), 'stops': len(p['stops']),
                                  'ambiguous': sum(m['ambiguous'] for m in p['markers']), 'unresolved': len(p['unresolved'])}
                          for n, p in pages.items()}}
    js_write(out/'manifest.js', 'QURAN_WAQF_MANIFEST', manifest)
    audit = {'version': 1, 'source': source_meta, 'reference': reference_meta, 'summary': summary,
             'stopTypes': SOURCE_TYPES, 'pages': sources, 'issues': issues,
             'wordAlignment': {r: a for r, a in locator.alignment.items() if a.get('changes') or a['status'] != 'aligned'}}
    (out/'report.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2)+'\n')
    (out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
