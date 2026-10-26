"""
Tests for the demo's Cloudinary explanations and the whiteboard-photo tour (no server, model or network).

    python -m unittest discover -s demo -v
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

from cloudinary_info import explain, size_text, transformation

ANALYSIS = "https://res.cloudinary.com/demo/image/upload/c_limit,h_1600,w_1600/e_improve/e_sharpen:60/f_jpg,q_90/v1/orgmap/b/abc?_a=X"
THUMB = "https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,h_120,w_160/f_auto,q_auto/v1/orgmap/b/abc"
ORIGINAL = "https://res.cloudinary.com/demo/image/upload/v1791329963/orgmap/b/abc.png"
BOARD = "5a1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c"


class Explanations(unittest.TestCase):
    def test_reads_the_steps_out_of_the_url(self):
        self.assertEqual(transformation(ANALYSIS), ["c_limit,h_1600,w_1600", "e_improve", "e_sharpen:60", "f_jpg,q_90"])
        self.assertEqual(transformation(THUMB), ["c_fill,g_auto,h_120,w_160", "f_auto,q_auto"])
        self.assertEqual(transformation(ORIGINAL), [], "the original has no transformation")

    def test_plain_words(self):
        self.assertIn("fit within 1600 × 1600 px", explain("c_limit,h_1600,w_1600"))
        self.assertIn("contrast", explain("e_improve"))
        self.assertIn("strength 60", explain("e_sharpen:60"))
        self.assertEqual(explain("f_jpg,q_90"), "Delivered as JPG at quality 90")
        self.assertIn("160 × 120 px around the most important part", explain("c_fill,g_auto,h_120,w_160"))
        self.assertIn("best format for each browser", explain("f_auto,q_auto"))
        self.assertIn("e_pixelate", explain("e_pixelate") + " e_pixelate")  # unknown effects still described

    def test_sizes(self):
        self.assertEqual([size_text(n) for n in (347_000, 171_000, 3_000, None)], ["339 KB", "167 KB", "3 KB", ""])


@unittest.skipUnless(importlib.util.find_spec("streamlit"), "streamlit not installed")
class PhotoTour(unittest.TestCase):
    def run_page(self, with_photo: bool):
        from streamlit.testing.v1 import AppTest

        photo = {"id": "s1", "type": "IMAGE", "createdAt": "2026-10-26T10:00:00Z", "analyzedWith": "qwen2.5vl:7b + notes parser",
                 "ocrText": "TODO: Ben: book the bus by Friday",
                 "cloudinary": {"secureUrl": ORIGINAL, "publicId": "orgmap/b/abc", "width": 1600, "height": 1000,
                                "format": "png", "createdAt": "2026-10-26T10:00:00Z"},
                 "analysisUrl": ANALYSIS, "previewUrl": ANALYSIS, "thumbUrl": THUMB}
        change = {"status": "DONE", "type": "IMAGE", "created": [], "statusChanges": [], "dateChanges": []}
        responses = {
            "/api/status": {"reachable": True, "cloudinary": True, "cloudName": "demo", "visionModel": "test"},
            f"/api/workspaces/{BOARD}/views": {
                "actionItems": [{"id": "t1", "label": "Book the bus", "owners": ["Ben"], "due": "2026-10-30", "status": "OPEN", "overdue": False}] if with_photo else [],
                "changes": [change] if with_photo else [], "decisions": [], "blockers": [], "orgChart": {"nodes": [], "edges": []}},
            f"/api/workspaces/{BOARD}": {"workspace": {"id": BOARD, "name": "Whiteboard · 0000"},
                                        "sources": [photo] if with_photo else [], "nodes": [], "edges": []},
        }

        def fake_request(method, url, **_):
            r = mock.Mock(ok=True)
            r.json.return_value = responses[url.split("8787", 1)[1]]
            return r

        at = AppTest.from_file(str(Path(__file__).with_name("app.py")), default_timeout=30)
        at.query_params["board"] = BOARD
        at.query_params["photo"] = "1"
        with mock.patch("requests.request", side_effect=fake_request), \
             mock.patch("requests.get", return_value=mock.Mock(ok=True, content=b"x" * 171_000)):
            at.run()
        return at

    def test_the_tour_starts_with_the_photo(self):
        at = self.run_page(with_photo=False)
        self.assertFalse(at.exception, at.exception)
        self.assertIn("1. After a meeting, someone photographs the whiteboard", [s.value for s in at.subheader])
        self.assertIn("Read the photo", [b.label for b in at.button])

    def test_after_the_photo_the_results_come_first_and_the_details_wait_to_be_asked_for(self):
        at = self.run_page(with_photo=True)
        self.assertFalse(at.exception, at.exception)
        headings = [s.value for s in at.subheader]
        self.assertEqual(headings[:2], ["To-do list", "Cloudinary cleaned up the photo for the AI"], "results, then the photo")
        self.assertNotIn("Decisions", headings, "no empty sections")
        self.assertNotIn("Who's who", headings, "no reporting lines, no chart")
        # The details are behind expanders, collapsed.
        how = next(e for e in at.expander if e.label == "How Cloudinary did it")
        table = "\n".join(m.value for m in how.markdown)
        for words in ("`e_improve`", "`e_sharpen:60`", "contrast"):
            self.assertIn(words, table)
        self.assertIn(ANALYSIS.split("?")[0], [c.value for c in how.code])
        read = next(e for e in at.expander if e.label == "What the AI read from the photo")
        self.assertIn("book the bus", "\n".join(t.value for t in read.text))
        self.assertEqual(at.subheader[-1].value, "2. Now add notes, or another photo")
        share = next(e for e in at.expander if e.label.startswith("Your board:"))
        self.assertIn("&photo=1", "\n".join(c.value for c in share.code), "the tour is kept in the board's link")


if __name__ == "__main__":
    unittest.main()
