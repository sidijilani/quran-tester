"""Regression checks for extraction and the dangerous matching edge cases.

Run with the same pdfplumber environment as build_waqf_pilot.py:
    python -m unittest discover -s tools -p 'test_waqf_pilot.py' -v
"""
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

import pdfplumber

from build_waqf_pilot import DEFAULT_PAGES, ROOT, Reference, extract_page, match_page, normalize, resolve_order, stop_proposals, write_outputs


class WaqfPilotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference = Reference(ROOT)
        source = json.loads((ROOT / 'data/sources/waqf-pilot-transcriptions.json').read_text())
        transcriptions = {r['id']: r for r in source['corrections']}
        cls.pages = {}
        with pdfplumber.open(ROOT / 'data/Woukoufet-Al-Koran-V2.pdf') as pdf:
            for n in DEFAULT_PAGES:
                p = extract_page(pdf, n, cls.reference.names)
                match_page(p, cls.reference, transcriptions)
                cls.pages[n] = p
        cls.rows = {r['id']: r for p in cls.pages.values() for r in p['rows']}

    def row(self, page, number):
        return self.rows[f'pdf-{page}-row-{number}']

    def test_table_accounting(self):
        self.assertEqual([len(p['rows']) for p in self.pages.values()], [16, 16, 17, 14, 15, 17, 8])
        self.assertEqual(len(self.rows), 103)
        self.assertEqual(sum(r['stopSymbol'] == 'ف' for r in self.rows.values()), 12)
        self.assertTrue(all(r['reviewStatus'] == 'pending' for r in self.rows.values()))

    def test_titles_preserve_numbers_and_combined_pages(self):
        self.assertEqual(self.pages[5]['headings'][0]['mushafPages'], [2, 3])
        self.assertEqual(self.pages[6]['headings'][0]['mushafPages'], [4])
        self.assertEqual(self.pages[278]['headings'][0]['mushafPages'], [275])
        self.assertEqual(self.pages[500]['headings'][0]['mushafPages'], [504])
        self.assertEqual([h['mushafPages'] for h in self.pages[554]['headings']], [[583], [584], [587]])

    def test_lam_alif_ligature_is_not_reversed(self):
        self.assertEqual(self.row(5, 1)['phrase'], 'لا ريب فيه')
        self.assertEqual(self.row(5, 3)['phrase'], 'الصلاة')
        self.assertEqual(self.row(500, 10)['phrase'], 'يستغيثان الله')

    def test_hamza_alif_after_diacritic_removal(self):
        self.assertEqual(normalize('ءَامَنُواْ'), normalize('آمنوا'))
        self.assertNotEqual(normalize('حسنا'), normalize('إحسانا'))
        self.assertNotEqual(normalize('شيء'), normalize('شي'))
        self.assertNotEqual(normalize('الحجارة'), normalize('والحجارة'))

    def test_known_location_matches(self):
        expected = [
            (5, 1, '2:2', 5), (5, 6, '2:7', 6),
            (6, 7, '2:20', 9), (7, 9, '2:26', 31), (7, 10, '2:26', 34),
            (100, 9, '4:127', 3), (100, 11, '4:127', 15),
            (278, 3, '16:75', 9), (278, 6, '16:75', 23),
            (500, 3, '46:15', 13), (500, 12, '46:17', 22),
            (554, 8, '82:19', 6),
        ]
        for page, row, ref, end in expected:
            with self.subTest(page=page, row=row):
                match = self.row(page, row)['match']
                self.assertEqual((match['ref'], match['endWord']), (ref, end))

    def test_repeated_word_is_not_guessed(self):
        row = self.row(500, 2)
        self.assertEqual(row['phrase'], 'كرها')
        self.assertEqual(row['matchStatus'], 'ambiguous')
        self.assertNotIn('match', row)
        self.assertEqual({c['endWord'] for c in row['feasibleCandidates']}, {7, 9})
        self.assertEqual(row['ambiguity']['groupId'], row['id'])
        self.assertEqual(row['ambiguity']['candidateCount'], 2)
        self.assertEqual({c['endWord'] for c in row['potentialMatches']}, {7, 9})

    def test_ambiguous_occurrences_export_with_shared_group_and_distinct_ids(self):
        row = self.row(500, 2)
        stops = stop_proposals(row)
        self.assertEqual(len(stops), 2)
        self.assertEqual(len({stop['id'] for stop in stops}), 2)
        self.assertTrue(all(stop['potentialWaqf'] and stop['ambiguous'] for stop in stops))
        self.assertTrue(all(stop['reviewStatus'] == 'pending' for stop in stops))
        self.assertEqual({stop['sourceRowId'] for stop in stops}, {row['id']})
        self.assertEqual({stop['ambiguity']['groupId'] for stop in stops}, {row['id']})
        by_word = {stop['match']['endWord']: stop for stop in stops}
        self.assertEqual(by_word[7]['classification'], 'additional_candidate')
        self.assertEqual(by_word[7]['match']['existingMarks'], [])
        self.assertEqual(by_word[9]['classification'], 'existing_mark')
        self.assertEqual(by_word[9]['match']['existingMarks'], ['ۖ'])
        self.assertTrue(all(stop['matchStatus'] == 'ambiguous' for stop in stops))
        self.assertNotIn('match', row)

    def test_per_page_output_contains_all_ambiguous_alternatives(self):
        report = {
            'source': {'sha256': 'test'}, 'samplePdfPages': [500, 554],
            'pages': [{'rows': [self.row(500, 2), self.row(500, 3), self.row(554, 7)]}],
        }
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with patch('build_waqf_pilot.write_review'):
                write_outputs(report, out, ROOT / 'data/Woukoufet-Al-Koran-V2.pdf', ROOT, False)
            manifest = json.loads((out / 'manifest.js').read_text().split('=', 1)[1].rstrip(';\n'))
            self.assertEqual(manifest['version'], 3)
            self.assertEqual(manifest['pages']['504']['stopCount'], 3)
            self.assertEqual(manifest['pages']['504']['sourceRowCount'], 2)
            self.assertEqual(manifest['pages']['504']['ambiguousStopCount'], 2)
            self.assertEqual(manifest['pages']['504']['ambiguityGroupCount'], 1)
            payload = json.loads((out / 'pages/504.js').read_text().rsplit('=', 1)[1].rstrip(';\n'))
            ambiguous = [stop for stop in payload['stops'] if stop['ambiguous']]
            self.assertEqual({stop['match']['endWord'] for stop in ambiguous}, {7, 9})
            self.assertFalse((out / 'pages/584.js').exists())
            self.assertTrue(payload['pilot'])
            self.assertFalse(payload['approved'])

    def test_conflicts_do_not_become_ambiguous_stops(self):
        for page, number in [(5, 9), (7, 12), (554, 7), (500, 1)]:
            self.assertEqual(stop_proposals(self.row(page, number)), [])

    def test_all_feasible_alternatives_supported_without_guessing_page(self):
        original = self.row(500, 2)
        third = {**original['potentialMatches'][0], 'endWord': 99}
        row = {**original, 'potentialMatches': original['potentialMatches'] + [third],
               'ambiguity': {**original['ambiguity'], 'candidateCount': 3}}
        self.assertEqual(len(stop_proposals(row)), 3)
        unknown_page = {**third, 'page': None, 'anchorIssues': ['word_page_unknown_within_spanning_ayah']}
        row['potentialMatches'][-1] = unknown_page
        self.assertEqual(len(stop_proposals(row)), 2)
        self.assertEqual(len(row['potentialMatches']), 3)

    def test_header_conflict_is_not_promoted(self):
        row = self.row(554, 7)
        self.assertEqual(row['heading']['surah'], 73)
        self.assertEqual(row['matchStatus'], 'heading_conflict')
        self.assertNotIn('match', row)
        self.assertEqual(row['samePageSuggestions'][0]['ref'], '79:27')

    def test_source_typos_and_reading_difference_remain_unmatched(self):
        self.assertEqual(self.row(6, 12)['phrase'], 'زرقا لكم')
        self.assertEqual(self.row(6, 12)['matchStatus'], 'unmatched')
        self.assertEqual(self.row(500, 1)['phrase'], 'حسنا')
        self.assertEqual(self.row(500, 1)['matchStatus'], 'unmatched')

    def test_out_of_order_rows_do_not_silently_move(self):
        for page, row in [(5, 9), (5, 10), (7, 12)]:
            self.assertEqual(self.row(page, row)['matchStatus'], 'order_conflict')
            self.assertNotIn('match', self.row(page, row))
        self.assertEqual(self.row(7, 13)['match']['ref'], '2:27')

    def test_locations_use_local_text_tokenization(self):
        for page, row, ref, index in [(6, 10, '2:21', 5), (554, 5, '78:40', 4), (554, 6, '78:40', 10)]:
            result = self.row(page, row)
            match = result['match']
            self.assertEqual((match['ref'], match['endWord']), (ref, index))
            self.assertEqual(match['anchorIssues'], [])
            self.assertEqual(result['matchStatus'], 'exact_unique')
            self.assertNotIn('wordBox', match)
            self.assertNotIn('line', match)

    def test_every_text_range_matches_original_verse(self):
        for row in self.rows.values():
            for candidate in row['candidates']:
                text = self.reference.by_ref[candidate['ref']]['ar']
                start, end = candidate['textRange']
                self.assertEqual(normalize(text[start:end]), normalize(candidate['matchedText']))
                display_tokens = text.split()
                self.assertEqual(display_tokens[candidate['endDisplayIndex']-1], candidate['stopAfter'])

    def test_no_images_or_layout_required_and_spanning_ayah_is_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            ayat = [{'s': 2, 'a': 1, 's_ar': 'البقرة', 'ar': 'كَلِمَةٌ ثَانِيَةٌ ۚ', 'page': 2}]
            (root / 'data/quran-data.js').write_text('window.QURAN_AYAT=' + json.dumps(ayat) + ';')
            (root / 'data/line-bands.js').write_text('window.QURAN_LINE_BANDS={"2:1":{"2":[15,15],"3":[1,1]}};')
            reference = Reference(root)
            candidates = reference.candidates('ثانية', [2, 3], 2)
            self.assertEqual(len(candidates), 1)
            candidate = candidates[0]
            self.assertEqual(candidate['endWord'], 2)
            self.assertEqual(candidate['existingMarks'], ['ۚ'])
            self.assertIsNone(candidate['page'])
            self.assertEqual(candidate['anchorIssues'], ['word_page_unknown_within_spanning_ayah'])

    def test_transcription_does_not_replace_source_evidence(self):
        row = self.row(278, 6)
        self.assertEqual(row['phrase'], 'لل')
        self.assertEqual(row['transcription']['transcribedPhrase'], 'لله')
        self.assertEqual(row['match']['ref'], '16:75')
        self.assertTrue(row['rawCellsLtr'])

    def test_existing_marks_attach_to_preceding_real_word(self):
        self.assertEqual(self.row(5, 1)['match']['existingMarks'], ['ۛ'])
        self.assertEqual(self.row(5, 6)['classification'], 'existing_mark')
        self.assertEqual(self.row(500, 4)['classification'], 'additional_candidate')

    def test_no_first_candidate_fallback(self):
        rows = [{'candidates': [{'ref': '2:2', 'endWord': 4}, {'ref': '2:2', 'endWord': 8}], 'headingIssues': []}]
        resolve_order(rows)
        self.assertEqual(rows[0]['matchStatus'], 'ambiguous')
        self.assertNotIn('match', rows[0])


if __name__ == '__main__':
    unittest.main()
