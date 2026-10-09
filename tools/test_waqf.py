"""Full-import regressions and independent checks of the generated corpus."""
import unittest
from unittest.mock import patch

import pdfplumber

from build_waqf import (
    ROOT, Reference, WordLocator, align_word_ends, extract_full_page,
    match_full_page, parse_title, read_json, read_js, normalize, sha256, build_reference,
)


class WaqfFullTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference = build_reference(ROOT)
        cls.locator = WordLocator(ROOT, cls.reference)
        cls.corrections = {c['id']: c for c in read_json(ROOT/'data/sources/waqf-pilot-transcriptions.json')['corrections']}

    def extract(self, number, previous=None):
        with pdfplumber.open(ROOT/'data/Woukoufet-Al-Koran-V2.pdf') as pdf:
            source, heading = extract_full_page(pdf, number, self.reference, previous)
        match_full_page(source, self.reference, self.corrections)
        return source, heading

    def test_separated_digits_and_combined_pages(self):
        source, _ = self.extract(99)
        self.assertEqual(source['headings'][-1]['mushafPages'], [97])
        source, _ = self.extract(379)
        self.assertEqual(source['headings'][-1]['mushafPages'], [375, 376])

    def test_missing_vertical_rules_recover_actual_columns(self):
        source, _ = self.extract(282)
        recovered = [r for r in source['rows'] if r['recoveredColumns']]
        self.assertEqual([(r['phrase'], r['stopSymbol'], r['attribution']) for r in recovered], [('ءامنوا', 'ج', 'أشموني')])

    def test_missing_category_is_retained(self):
        source, _ = self.extract(120)
        row = next(r for r in source['rows'] if r['phrase'] == 'فسادا')
        self.assertEqual(row['stopSymbol'], '')
        self.assertEqual(row['categoryIssues'], ['missing_stop_category'])
        self.assertIn('match', row)

    def test_lazim_and_unusual_category_are_not_reclassified(self):
        source, _ = self.extract(311)
        row = next(r for r in source['rows'] if r['stopSymbol'] == 'لازم')
        self.assertEqual(row['stopType'], 'lazim')
        source, _ = self.extract(391)
        row = next(r for r in source['rows'] if r['phrase'] == 'وبينك')
        self.assertEqual(row['stopSymbol'], 'ه')
        self.assertEqual(row['stopType'], 'unspecified')
        self.assertTrue(any(r['reason'] == 'empty stop placeholder' for r in source['skippedRows']))

    def test_continuation_inherits_last_heading_not_next_one(self):
        _, last = self.extract(337)
        source, _ = self.extract(338, last)
        self.assertEqual(source['rows'][0]['heading']['mushafPages'], [334])
        self.assertEqual(source['rows'][0]['heading']['inheritedFromPdfPage'], 337)
        self.assertEqual(source['rows'][0]['match']['ref'], '22:17')

    def test_chapter_change_inside_same_page(self):
        source, _ = self.extract(363)
        chapters = {r['match']['ref'].split(':')[0] for r in source['rows'] if r.get('match')}
        self.assertEqual(chapters, {'24', '25'})

    def test_page_only_title_inherits_real_chapters(self):
        source, _ = self.extract(534)
        later = [r for r in source['rows'] if r['heading']['mushafPages'] == [552]]
        self.assertTrue(later)
        self.assertTrue(all(r['match']['ref'].startswith('61:') for r in later if r.get('match')))
        self.assertTrue(all(not r['headingIssues'] for r in later))

    def test_word_surah_is_not_a_chapter_heading(self):
        source, _ = self.extract(504)
        row = next(r for r in source['rows'] if r['phrase'] == 'سورة')
        self.assertTrue(row['candidates'])
        self.assertEqual({c['ref'] for c in row['candidates']}, {'47:20'})
        self.assertTrue(all(not r['headingIssues'] for r in source['rows']))

    def test_header_correction_preserves_printed_title(self):
        source, _ = self.extract(153)
        heading = source['rows'][0]['heading']
        self.assertIn('الأنعام', heading['title'])
        self.assertEqual(heading['surahs'], [7])
        self.assertEqual(source['rows'][0]['match']['ref'], '7:1')

    def test_joined_vocative_does_not_shift_rabbakum(self):
        mapping = self.locator.maps['2:21']
        self.assertNotIn(1, mapping)  # يا is inside the joined image word.
        self.assertEqual(mapping[2], 1)
        self.assertEqual(mapping[5], 4)  # ربكم, not الذي.
        anchor = self.reference.anchor('2:21', 4, 4, [4])
        position, error = self.locator.locate(anchor)
        self.assertIsNone(error)
        self.assertEqual(position['layoutWord'], 4)
        self.assertEqual(normalize(position['layoutText']), normalize('ربكم'))

    def test_unknown_text_is_not_accepted_as_spelling_variant(self):
        mapping, audit = align_word_ends([{'text': 'كلمة'}], [{'i': 1, 'ar': 'مختلفة'}])
        self.assertEqual(mapping, {})
        self.assertEqual(audit['status'], 'unreconciled')

    def test_spanning_verse_gets_page_from_word_layout(self):
        # The current Madani metadata has whole-ayah pages. Exercise a spanning
        # metadata fixture while keeping the real word/page source independent.
        ref = '2:21'
        with patch.dict(self.reference.pages_by_ref, {ref: [4, 5]}):
            anchor = self.reference.anchor(ref, 4, 4, [4, 5])
            self.assertIsNone(anchor['page'])
            position, error = self.locator.locate(anchor)
        self.assertIsNone(error)
        endpoint = next(w for w in self.locator.metadata[ref] if w['i'] == position['layoutWord'])
        self.assertEqual(position['page'], endpoint['page'])

    def test_upstream_adjacent_page_does_not_move_marker(self):
        anchor = self.reference.anchor('5:77', 9, 9, [121])
        position, error = self.locator.locate(anchor)
        self.assertIsNone(error)
        self.assertEqual(position['page'], 121)
        self.assertEqual(position['wordMetadataPage'], 120)
        self.assertTrue(position['wordMetadataPageMismatch'])
        self.assertEqual(position['line'], 1)
        self.assertEqual(normalize(position['layoutText']), normalize('الحق'))

    def test_corpus_coverage_provenance_and_locations(self):
        report = read_json(ROOT/'data/waqf/report.json')
        self.assertEqual(report['source']['sha256'], sha256(ROOT/'data/Woukoufet-Al-Koran-V2.pdf'))
        self.assertEqual([p['pdfPage'] for p in report['pages']], list(range(5, 559)))
        self.assertEqual(sum(p['status'] == 'tables' for p in report['pages']), 551)
        self.assertEqual(sum(len(p['rows']) for p in report['pages']), 6904)
        self.assertEqual(next(p for p in report['pages'] if p['pdfPage'] == 557)['status'], 'prose_image')
        rows = {r['id']: r for p in report['pages'] for r in p['rows']}
        markers, stop_ids = [], set()
        for number in range(1, 605):
            data = read_js(ROOT/f'data/waqf/pages/{number}.js')
            self.assertEqual(data['page'], number)
            self.assertEqual(len({m['id'] for m in data['markers']}), len(data['markers']))
            stops = {s['id']: s for s in data['stops']}
            for stop in data['stops']:
                self.assertNotIn(stop['id'], stop_ids)
                stop_ids.add(stop['id'])
                row = rows[stop['sourceRowId']]
                original = row.get('transcription', {}).get('transcribedPhrase', row['phrase'])
                self.assertEqual(normalize(original), normalize(stop['matchedText']))
                self.assertEqual(stop['stopAfter'], self.reference.words[stop['ref']][stop['endWord']-1]['text'])
                metadata = next(w for w in self.locator.metadata[stop['ref']] if w['i'] == stop['layoutWord'])
                self.assertEqual(stop['wordMetadataPageMismatch'], metadata['page'] != number)
                boxes = self.locator.layout[number]['ayat'][stop['ref']]
                self.assertEqual(sum(w['i'] == stop['layoutWord'] for b in boxes for w in b.get('words', [])), 1)
                self.assertEqual(stop['pageHintMismatch'], number not in row['heading']['mushafPages'])
                self.assertEqual(metadata['line'], stop['line'])
                self.assertEqual(self.locator.maps[stop['ref']][stop['endWord']], stop['layoutWord'])
                if stop['classification'] == 'existing_mark' and not stop['ambiguous']:
                    self.assertFalse(stop['display'])
            for marker in data['markers']:
                self.assertTrue(all(stops[i]['display'] for i in marker['sourceIds']))
                self.assertEqual(set(marker['stopTypes']), {stops[i]['stopType'] for i in marker['sourceIds']})
                self.assertIn(marker['stopType'], marker['stopTypes'])
                g = marker['geometry']
                self.assertGreater(g['x'], 0)
                self.assertLess(g['x'], 1)
                self.assertGreaterEqual(g['top'], 0)
                self.assertGreater(g['lineTop'], g['top'])
                self.assertGreaterEqual(g['lineBottom'], g['lineTop'])
                self.assertLessEqual(g['lineBottom'], 1)
            markers.extend(data['markers'])
        self.assertEqual(len(markers), report['summary']['displayedMarkers'])

    def test_both_krha_locations_remain_flagged_and_printed_sign_kept(self):
        data = read_js(ROOT/'data/waqf/pages/504.js')
        stops = [s for s in data['stops'] if s['sourceRowId'] == 'pdf-500-row-2']
        self.assertEqual({s['endWord'] for s in stops}, {7, 9})
        self.assertTrue(all(s['ambiguous'] and s['display'] for s in stops))
        self.assertEqual(len({s['ambiguity']['groupId'] for s in stops}), 1)
        self.assertEqual(next(s for s in stops if s['endWord'] == 9)['existingMarks'], ['ۖ'])


if __name__ == '__main__':
    unittest.main()
