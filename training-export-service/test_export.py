import sys, os, unittest
sys.path.insert(0, os.path.dirname(__file__))
from export import (
    bbox_to_yolo, stratified_split, CLASS_MAP, ARTIFACT_TYPES
)


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


class TestConstants(unittest.TestCase):

    def test_class_map_has_8_types(self):
        self.assertEqual(len(CLASS_MAP), 8)

    def test_class_indices_are_0_to_7(self):
        self.assertEqual(
            sorted(CLASS_MAP.values()), list(range(8))
        )

    def test_artifact_types_excluded_from_tags(self):
        # header and footer are artifacts
        for t in ARTIFACT_TYPES:
            self.assertIn(t, CLASS_MAP)


if __name__ == '__main__':
    unittest.main()
