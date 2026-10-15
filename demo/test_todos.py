"""
Regression tests for the demo's to-do list (no server or model needed):

    npm run test:demo        # or: python -m unittest discover -s demo -v

The page used to crash with KeyError: 'due' when a handwritten note produced an action item without a
due date: the server left the key out, and the page indexed it directly.
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

from todos import action_item, friendly, todo_table

COMPLETE = {"id": "a", "label": "Book the venue", "description": "Seats 30", "owners": ["Ben"],
            "due": "2026-10-12", "status": "OPEN", "overdue": False}
NO_DUE = {"id": "b", "label": "Order the catering", "owners": ["Chloe"], "status": "OPEN", "overdue": False}
NO_STATUS = {"id": "c", "label": "Send the invitations", "owners": ["Maya"], "due": "2026-10-15", "overdue": False}
NO_OWNER = {"id": "d", "label": "Print the badges", "due": "2026-10-11", "status": "OPEN", "overdue": False}
BARE = {"label": "Call the hotel"}
DONE_ITEM = {**COMPLETE, "id": "e", "label": "Write the agenda", "due": "2026-10-01", "status": "DONE"}


def rows(table: str) -> list[str]:
    return table.splitlines()[2:]


class ActionItemShape(unittest.TestCase):
    def test_complete_item_is_unchanged(self):
        self.assertEqual(action_item(COMPLETE), COMPLETE)

    def test_missing_optional_fields_are_empty_not_invented(self):
        a = action_item(BARE)
        self.assertEqual(a["label"], "Call the hotel")
        self.assertIsNone(a["due"])
        self.assertIsNone(a["description"])
        self.assertEqual(a["owners"], [])
        self.assertEqual(a["status"], "OPEN")
        self.assertFalse(a["overdue"])

    def test_null_values_from_the_server(self):
        a = action_item({**COMPLETE, "due": None, "description": None, "owners": None, "status": None})
        self.assertIsNone(a["due"])
        self.assertEqual(a["owners"], [])
        self.assertEqual(a["status"], "OPEN")

    def test_item_without_label_is_not_a_todo(self):
        for raw in ({"due": "2026-10-12"}, {"label": "  "}, {"label": None}, None, "Book the venue"):
            self.assertIsNone(action_item(raw), raw)


class TodoTable(unittest.TestCase):
    def test_original_keyerror_is_fixed(self):
        # The exact sort the page used to do, on an item without "due".
        with self.assertRaises(KeyError):
            sorted([COMPLETE, NO_DUE], key=lambda a: (a["status"] == "DONE", a["due"] or "9999"))
        table, unreadable = todo_table([COMPLETE, NO_DUE])
        self.assertEqual(unreadable, 0)
        self.assertIn("| **Order the catering** | Chloe | no date |", table)

    def test_complete_item(self):
        table, _ = todo_table([COMPLETE])
        self.assertEqual(rows(table), ["| **Book the venue** | Ben | Mon, Oct 12 |"])

    def test_no_due(self):
        self.assertEqual(rows(todo_table([NO_DUE])[0]), ["| **Order the catering** | Chloe | no date |"])

    def test_no_status_is_shown_as_open(self):
        self.assertEqual(rows(todo_table([NO_STATUS])[0]), ["| **Send the invitations** | Maya | Thu, Oct 15 |"])

    def test_no_owner(self):
        self.assertEqual(rows(todo_table([NO_OWNER])[0]), ["| **Print the badges** | nobody yet | Sun, Oct 11 |"])

    def test_mixed_items_sort_dated_first_undated_then_done(self):
        table, unreadable = todo_table([NO_DUE, DONE_ITEM, BARE, COMPLETE, {"due": "2026-10-10"}, NO_STATUS, NO_OWNER])
        self.assertEqual(unreadable, 1, "only the item with no label is left out")
        self.assertEqual([r.split(" | ")[0] for r in rows(table)], [
            "| **Print the badges**",       # Oct 11
            "| **Book the venue**",         # Oct 12
            "| **Send the invitations**",   # Oct 15
            "| **Order the catering**",     # no date, kept in input order
            "| **Call the hotel**",         # no date
            "| ~~Write the agenda~~",       # done
        ])

    def test_overdue_and_done(self):
        table, _ = todo_table([{**COMPLETE, "overdue": True}, DONE_ITEM])
        self.assertEqual(rows(table), ["| **Book the venue** | Ben | Mon, Oct 12 (overdue) |",
                                       "| ~~Write the agenda~~ | Ben | Done |"])

    def test_messy_model_text_does_not_break_the_table(self):
        table, _ = todo_table([{**NO_OWNER, "label": "Fix the A|B test\nby hand", "owners": "Sam"}])
        self.assertEqual(rows(table), ["| **Fix the A\\|B test by hand** | Sam | Sun, Oct 11 |"])

    def test_latest_update_marks_new_and_changed_items(self):
        change = {"created": [{"id": "b", "label": "Order the catering", "type": "TASK"}],
                  "statusChanges": [{"id": "e", "label": "Write the agenda", "from": "OPEN", "to": "DONE"}],
                  "dateChanges": [{"id": "a", "label": "Book the venue", "from": "2026-10-10", "to": "2026-10-12"}]}
        table, _ = todo_table([COMPLETE, NO_DUE, NO_OWNER, DONE_ITEM], change)
        self.assertEqual(rows(table), [
            "| **Print the badges** | nobody yet | Sun, Oct 11 |",
            "| :orange[**Book the venue**] :orange-badge[Date moved] | Ben | :orange[Mon, Oct 12] (was Sat, Oct 10) |",
            "| :green[**Order the catering**] :green-badge[New] | Chloe | no date |",
            "| :orange[~~Write the agenda~~] :orange-badge[Just done] | Ben | Done |",
        ])

    def test_changes_match_by_label_when_the_server_sends_no_ids(self):
        table, _ = todo_table([NO_DUE], {"created": [{"label": "order the catering", "type": "TASK"}]})
        self.assertEqual(rows(table), ["| :green[**Order the catering**] :green-badge[New] | Chloe | no date |"])

    def test_brackets_in_labels_do_not_break_the_color_markup(self):
        item = {**NO_DUE, "label": "Fix [urgent] login"}
        table, _ = todo_table([item], {"created": [{"id": "b", "label": "Fix [urgent] login"}]})
        self.assertEqual(rows(table), ["| :green[**Fix \\[urgent\\] login**] :green-badge[New] | Chloe | no date |"])

    def test_empty(self):
        self.assertEqual(todo_table([]), ("", 0))
        self.assertEqual(todo_table(None), ("", 0))
        self.assertEqual(todo_table([{"due": "2026-10-10"}]), ("", 1))


class Dates(unittest.TestCase):
    def test_friendly(self):
        self.assertEqual(friendly("2026-10-10"), "Sat, Oct 10")
        self.assertEqual(friendly(None), "")
        self.assertEqual(friendly("2026-13-40"), "2026-13-40", "an impossible date is shown as written")


@unittest.skipUnless(importlib.util.find_spec("streamlit"), "streamlit not installed")
class DemoPage(unittest.TestCase):
    """Runs demo/app.py against a fake server whose to-dos are missing optional fields."""

    def test_page_renders_incomplete_todos(self):
        from streamlit.testing.v1 import AppTest

        views = {
            "actionItems": [COMPLETE, NO_DUE, NO_STATUS, NO_OWNER, BARE, DONE_ITEM],
            "changes": [{"status": "DONE", "type": "TEXT", "created": [], "statusChanges": [], "dateChanges": []}],
            "decisions": [], "blockers": [], "orgChart": {"nodes": [], "edges": []},
        }
        responses = {
            "/api/status": {"reachable": True, "cloudinary": False, "visionModel": "test"},
            "/api/workspaces": [{"id": "w1", "name": "Demo"}],
            "/api/workspaces/w1/views": views,
            "/api/workspaces/w1": {"sources": []},
        }

        def fake_request(method, url, **_):
            r = mock.Mock(ok=True)
            r.json.return_value = responses[url.split("8787", 1)[1]]
            return r

        with mock.patch("requests.request", side_effect=fake_request):
            at = AppTest.from_file(str(Path(__file__).with_name("app.py")), default_timeout=30).run()
        self.assertFalse(at.exception, at.exception)
        page = "\n".join(m.value for m in at.markdown)
        for label in ("Book the venue", "Order the catering", "Send the invitations", "Print the badges", "Call the hotel", "Write the agenda"):
            self.assertIn(label, page)
        self.assertIn("| **Call the hotel** | nobody yet | no date |", page)


if __name__ == "__main__":
    unittest.main()
