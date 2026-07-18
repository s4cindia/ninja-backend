import sys, os, unittest
sys.path.insert(0, os.path.dirname(__file__))
from export import (
    bbox_to_yolo, stratified_split, pinned_page_split,
    resolve_label, resolve_class_index,
    merge_table_cells_into_tables,
    CLASS_MAP, ARTIFACT_TYPES, ARTIFACT_CLASS_INDICES,
)


class TestMergeTableCells(unittest.TestCase):
    """'table' is annotated as whole-table+cells, or as cells only. Merge must
    produce ONE whole-table box per table (the union of the spatial cluster) —
    fixing both cases without any manual drawing."""

    def _z(self, x, y, w, h):
        return {'bounds': {'x': x, 'y': y, 'w': w, 'h': h}}

    def test_whole_plus_cells_merge_to_whole_box(self):
        whole = self._z(70, 98, 470, 338)                              # Kim p191 style
        cells = [self._z(250 + i * 8, 120, 6, 8) for i in range(20)]   # cells inside
        merged = merge_table_cells_into_tables([whole] + cells)
        self.assertEqual(len(merged), 1)
        b = merged[0]['bounds']
        # Union equals the whole-table box (the cells sit inside it).
        self.assertAlmostEqual(b['x'], 70);  self.assertAlmostEqual(b['y'], 98)
        self.assertAlmostEqual(b['w'], 470); self.assertAlmostEqual(b['h'], 338)

    def test_cells_only_synthesise_one_table(self):
        # Nikitopoulos / Patton style: a grid of adjacent cells, NO enclosing box.
        cells = [self._z(100 + c * 40, 200 + r * 12, 38, 10)
                 for r in range(4) for c in range(3)]
        merged = merge_table_cells_into_tables(cells)
        self.assertEqual(len(merged), 1, 'adjacent cells form one whole-table box')
        b = merged[0]['bounds']
        self.assertAlmostEqual(b['x'], 100); self.assertAlmostEqual(b['y'], 200)
        self.assertAlmostEqual(b['w'], 118); self.assertAlmostEqual(b['h'], 46)

    def test_two_separate_tables_stay_separate(self):
        t1 = self._z(50, 50, 150, 120)
        t2 = self._z(400, 50, 150, 120)            # far apart → distinct clusters
        merged = merge_table_cells_into_tables([t1, t2])
        self.assertEqual(len(merged), 2)

    def test_supports_width_height_keys(self):
        a = {'bounds': {'x': 0, 'y': 0, 'width': 100, 'height': 50}}
        b = {'bounds': {'x': 10, 'y': 10, 'width': 20, 'height': 10}}
        merged = merge_table_cells_into_tables([a, b])
        self.assertEqual(len(merged), 1)
        self.assertAlmostEqual(merged[0]['bounds']['w'], 100)

    def test_single_box(self):
        merged = merge_table_cells_into_tables([self._z(10, 10, 100, 100)])
        self.assertEqual(len(merged), 1)
        self.assertAlmostEqual(merged[0]['bounds']['w'], 100)


class TestBboxToYolo(unittest.TestCase):

    def test_centred_box(self):
        # Full-page box -> cx=0.5, cy=0.5, w=1.0, h=1.0
        cx, cy, w, h = bbox_to_yolo(
            {'x': 0, 'y': 0, 'w': 595, 'h': 842},
            595.0, 842.0
        )
        self.assertAlmostEqual(cx, 0.5, places=4)
        self.assertAlmostEqual(cy, 0.5, places=4)
        self.assertAlmostEqual(w, 1.0, places=4)
        self.assertAlmostEqual(h, 1.0, places=4)

    def test_top_left_small_box(self):
        # Box at top-left, 10% of page width, 5% height
        cx, cy, w, h = bbox_to_yolo(
            {'x': 0, 'y': 0, 'w': 59.5, 'h': 42.1},
            595.0, 842.0
        )
        self.assertAlmostEqual(cx, 0.05, places=3)
        self.assertAlmostEqual(cy, 0.025, places=3)
        self.assertAlmostEqual(w, 0.1, places=3)
        self.assertAlmostEqual(h, 0.05, places=3)

    def test_all_values_in_range(self):
        cx, cy, w, h = bbox_to_yolo(
            {'x': 100, 'y': 200, 'w': 300, 'h': 400},
            595.0, 842.0
        )
        for v in (cx, cy, w, h):
            self.assertGreaterEqual(v, 0.0)
            self.assertLessEqual(v, 1.0)

    def test_overflow_clamped(self):
        # Box larger than page — should clamp to [0,1]
        cx, cy, w, h = bbox_to_yolo(
            {'x': -100, 'y': -100, 'w': 900, 'h': 1200},
            595.0, 842.0
        )
        for v in (cx, cy, w, h):
            self.assertGreaterEqual(v, 0.0)
            self.assertLessEqual(v, 1.0)

    def test_zero_size_clamped_to_min(self):
        cx, cy, w, h = bbox_to_yolo(
            {'x': 100, 'y': 100, 'w': 0, 'h': 0},
            595.0, 842.0
        )
        self.assertGreaterEqual(w, 0.001)
        self.assertGreaterEqual(h, 0.001)


class TestStratifiedSplit(unittest.TestCase):

    def test_each_publisher_in_all_splits(self):
        docs = [
            {'documentId': f'p1-{i}', 'publisher': 'Pearson'}
            for i in range(10)
        ] + [
            {'documentId': f'p2-{i}', 'publisher': 'Wiley'}
            for i in range(10)
        ]
        splits = stratified_split(docs)
        for pub_prefix in ('p1-', 'p2-'):
            pub_splits = {
                v for k, v in splits.items()
                if k.startswith(pub_prefix)
            }
            self.assertEqual(
                pub_splits, {'train', 'val', 'test'},
                f"{pub_prefix} missing some splits"
            )

    def test_all_docs_assigned(self):
        docs = [
            {'documentId': f'd{i}', 'publisher': 'OUP'}
            for i in range(5)
        ]
        splits = stratified_split(docs)
        self.assertEqual(len(splits), 5)
        for v in splits.values():
            self.assertIn(v, ('train', 'val', 'test'))

    def test_single_doc_goes_to_train(self):
        docs = [{'documentId': 'solo', 'publisher': 'Solo'}]
        splits = stratified_split(docs)
        self.assertEqual(splits['solo'], 'train')

    def test_no_publisher_handled(self):
        docs = [
            {'documentId': f'd{i}'}  # no publisher key
            for i in range(6)
        ]
        # Should not raise — falls back to 'unknown'
        splits = stratified_split(docs)
        self.assertEqual(len(splits), 6)


class TestRareClassCoverage(unittest.TestCase):
    """The split must guarantee formula/table reach val AND test even when they
    are concentrated in small (1-2-doc) publishers that the per-publisher split
    would otherwise send entirely to train."""

    def _formula_zones(self, n):
        return [
            {'pageNumber': 1, 'bounds': {'x': 0, 'y': 0, 'w': 10, 'h': 10},
             'operatorLabel': 'formula'}
            for _ in range(n)
        ]

    def test_formula_reaches_val_and_test_despite_small_publishers(self):
        docs = [
            # large publisher with no formula
            *[{'documentId': f'big-{i}', 'publisher': 'BigPub', 'zones': []}
              for i in range(8)],
            # three single-doc publishers, each carrying formula -> per-publisher
            # split would dump all three into train
            *[{'documentId': f'solo-{j}', 'publisher': pub,
               'zones': self._formula_zones(50)}
              for j, pub in enumerate(['SoloA', 'SoloB', 'SoloC'])],
        ]
        splits = stratified_split(docs)
        carrier_splits = {splits[f'solo-{j}'] for j in range(3)}
        self.assertIn('train', carrier_splits, 'formula must stay in train')
        self.assertIn('val', carrier_splits, 'formula must reach val')
        self.assertIn('test', carrier_splits, 'formula must reach test')

    def test_largest_carrier_kept_in_train(self):
        docs = [
            {'documentId': 'big', 'publisher': 'A', 'zones': self._formula_zones(500)},
            {'documentId': 'mid', 'publisher': 'B', 'zones': self._formula_zones(200)},
            {'documentId': 'small', 'publisher': 'C', 'zones': self._formula_zones(50)},
        ]
        splits = stratified_split(docs)
        self.assertEqual(splits['big'], 'train', 'largest carrier should train')
        self.assertEqual({splits['mid'], splits['small']}, {'val', 'test'})

    def test_no_op_without_rare_carriers(self):
        docs = [{'documentId': f'd{i}', 'publisher': 'P', 'zones': []}
                for i in range(6)]
        splits = stratified_split(docs)
        self.assertEqual(len(splits), 6)
        for v in splits.values():
            self.assertIn(v, ('train', 'val', 'test'))

    def test_too_few_carriers_left_untouched(self):
        # Only 2 formula carriers — not enough for train+val+test; leave as-is.
        docs = [
            {'documentId': 'big', 'publisher': 'BigPub', 'zones': []}
            for _ in range(1)
        ] + [
            {'documentId': 'f1', 'publisher': 'BigPub', 'zones': self._formula_zones(40)},
            {'documentId': 'f2', 'publisher': 'BigPub', 'zones': self._formula_zones(40)},
        ]
        splits = stratified_split(docs)
        # No crash; all assigned
        self.assertEqual(len(splits), 3)


class TestResolveLabel(unittest.TestCase):

    def test_returns_operator_label(self):
        """Human-verified operatorLabel is returned."""
        self.assertEqual(resolve_label({'operatorLabel': 'table'}), 'table')

    def test_returns_none_without_operator_label(self):
        """Zones without operatorLabel return None (excluded from export)."""
        self.assertIsNone(resolve_label({'type': 'paragraph', 'aiLabel': 'figure', 'aiConfidence': 0.99}))

    def test_returns_none_for_empty_zone(self):
        """Empty zone dict returns None."""
        self.assertIsNone(resolve_label({}))

    def test_ai_only_zone_excluded(self):
        """AI label with high confidence but no human review returns None."""
        zone = {'aiLabel': 'table', 'aiConfidence': 0.98, 'aiDecision': 'ACCEPTED'}
        self.assertIsNone(resolve_label(zone))


class TestResolveClassIndex(unittest.TestCase):
    """resolve_class_index must be case-insensitive and whitespace-tolerant.
    Returns None for unknown labels so the caller can skip the zone instead
    of silently misclassifying it as class 0 (paragraph)."""

    def test_canonical_lowercase_labels_resolve(self):
        for label, expected in CLASS_MAP.items():
            self.assertEqual(resolve_class_index(label), expected)

    def test_uppercase_pdf_tag_convention_resolves(self):
        """PDF-tag-style uppercase labels used by Boyd-Hamill / Flanagan."""
        self.assertEqual(resolve_class_index('LI'),   CLASS_MAP['li'])
        self.assertEqual(resolve_class_index('HDR'),  CLASS_MAP['header'])
        self.assertEqual(resolve_class_index('FTR'),  CLASS_MAP['footer'])
        self.assertEqual(resolve_class_index('TOCI'), CLASS_MAP['toci'])
        self.assertEqual(resolve_class_index('FN'),   CLASS_MAP['footnote'])

    def test_mixed_case_resolves(self):
        self.assertEqual(resolve_class_index('Paragraph'), CLASS_MAP['paragraph'])
        self.assertEqual(resolve_class_index('Section-Header'), CLASS_MAP['section-header'])
        self.assertEqual(resolve_class_index('TaBlE'), CLASS_MAP['table'])

    def test_heading_levels_resolve_to_section_header_any_case(self):
        for h in ('h1', 'H2', 'h3', 'H4', 'h5', 'H6'):
            self.assertEqual(resolve_class_index(h), CLASS_MAP['section-header'])

    def test_surrounding_whitespace_tolerated(self):
        self.assertEqual(resolve_class_index('  table  '), CLASS_MAP['table'])
        self.assertEqual(resolve_class_index('\tLI\n'), CLASS_MAP['li'])

    def test_unknown_label_returns_none(self):
        self.assertIsNone(resolve_class_index('wat-is-this'))
        self.assertIsNone(resolve_class_index('blockquote'))  # not in CLASS_MAP yet
        self.assertIsNone(resolve_class_index('xyz123'))

    def test_none_and_empty_return_none(self):
        self.assertIsNone(resolve_class_index(None))
        self.assertIsNone(resolve_class_index(''))
        self.assertIsNone(resolve_class_index('   '))


class TestArtifactClassIndices(unittest.TestCase):
    """ARTIFACT_CLASS_INDICES must match the class indices for ARTIFACT_TYPES,
    so post-normalization filtering doesn't drift from the canonical-name set."""

    def test_indices_match_artifact_type_lookups(self):
        expected = {CLASS_MAP[t] for t in ARTIFACT_TYPES}
        self.assertEqual(ARTIFACT_CLASS_INDICES, expected)

    def test_uppercase_artifact_labels_filtered_after_resolve(self):
        # HDR/FTR resolve to header/footer indices, which the export loop
        # treats as artefacts. This is the bug-fix path for Boyd-Hamill etc.
        self.assertIn(resolve_class_index('HDR'), ARTIFACT_CLASS_INDICES)
        self.assertIn(resolve_class_index('FTR'), ARTIFACT_CLASS_INDICES)


class TestConstants(unittest.TestCase):

    def test_class_map_covers_all_11_classes(self):
        """All 11 YOLO classes (0-10) must be represented in CLASS_MAP values."""
        self.assertEqual(sorted(set(CLASS_MAP.values())), list(range(11)))

    def test_ui_abbreviations_map_correctly(self):
        """UI dropdown labels must map to the same class as their canonical form."""
        self.assertEqual(CLASS_MAP['hdr'], CLASS_MAP['header'])      # 6
        self.assertEqual(CLASS_MAP['ftr'], CLASS_MAP['footer'])      # 7
        self.assertEqual(CLASS_MAP['li'], CLASS_MAP['list-item'])    # 8
        self.assertEqual(CLASS_MAP['fn'], CLASS_MAP['footnote'])     # 5
        self.assertEqual(CLASS_MAP['fig'], CLASS_MAP['figure'])      # 3
        self.assertEqual(CLASS_MAP['tbl'], CLASS_MAP['table'])       # 2
        self.assertEqual(CLASS_MAP['cap'], CLASS_MAP['caption'])     # 4
        self.assertEqual(CLASS_MAP['p'], CLASS_MAP['paragraph'])     # 0

    def test_heading_levels_map_to_section_header(self):
        for h in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.assertEqual(CLASS_MAP[h], CLASS_MAP['section-header'])

    def test_artifact_types_in_class_map(self):
        for t in ARTIFACT_TYPES:
            self.assertIn(t, CLASS_MAP)


class TestPinnedPageSplit(unittest.TestCase):
    """The production split (export_corpus) is per-PAGE and PINNED. It must:
    (1) be deterministic — a (doc, page) always maps to the same split, so
        re-annotation never reshuffles pages and successive model runs stay
        directly comparable; and
    (2) spread every document's pages across train/val/test, so a formula style
        concentrated in a single document (e.g. Nikitopoulos) is seen in training
        AND evaluated — the failure the doc-level split caused (v6 test formula
        ~0.004 → v7 0.737 once styles reached both train and test)."""

    def test_returns_valid_split(self):
        for p in range(1, 50):
            self.assertIn(pinned_page_split('doc', p), ('train', 'val', 'test'))

    def test_deterministic_and_pinned(self):
        # Same (doc, page) -> same split on every call (no per-process salt).
        for p in (1, 7, 42, 999):
            self.assertEqual(
                pinned_page_split('math-olszewski', p),
                pinned_page_split('math-olszewski', p),
            )

    def test_document_pages_reach_all_splits(self):
        # A single document with enough pages contributes to train AND val AND
        # test — the core guarantee the doc-level split could not make.
        seen = {pinned_page_split('nikitopoulos', p) for p in range(1, 200)}
        self.assertEqual(seen, {'train', 'val', 'test'})

    def test_ratios_approximately_80_10_10(self):
        from collections import Counter
        c = Counter(pinned_page_split('d', p) for p in range(1, 5001))
        n = sum(c.values())
        self.assertAlmostEqual(c['train'] / n, 0.80, delta=0.03)
        self.assertAlmostEqual(c['val'] / n, 0.10, delta=0.02)
        self.assertAlmostEqual(c['test'] / n, 0.10, delta=0.02)

    def test_distinct_docs_are_independent(self):
        # The same page number across different docs must not collapse to one
        # split (otherwise the hash isn't mixing the doc id in).
        buckets = {pinned_page_split(f'doc-{i}', 1) for i in range(50)}
        self.assertGreater(len(buckets), 1)


if __name__ == '__main__':
    unittest.main()
