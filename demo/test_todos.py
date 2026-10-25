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

import datetime as dt
import math

from todos import action_item, editor_rows, friendly, plan_edits, split_owners, todo_table

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


class Editing(unittest.TestCase):
    """The editable table: what typing into it turns into (plan_edits), without a server."""

    ITEMS = [COMPLETE, NO_DUE, {**DONE_ITEM, "owners": []}]

    def rows(self):
        return [dict(r) for r in editor_rows(self.ITEMS)]

    def test_rows_show_the_list(self):
        self.assertEqual(editor_rows([COMPLETE, BARE, {"label": ""}]), [
            {"id": "a", "done": False, "todo": "Book the venue", "who": "Ben", "due": dt.date(2026, 10, 12)},
            {"id": None, "done": False, "todo": "Call the hotel", "who": "", "due": None},
        ])

    def test_unchanged_table_changes_nothing(self):
        self.assertEqual(plan_edits(self.ITEMS, self.rows()), [])

    def test_tick_rename_redate_reassign(self):
        rows = self.rows()
        rows[0].update(done=True, todo="Book the big venue", due=dt.date(2026, 10, 14))
        rows[1]["who"] = "Chloe and Sam"
        rows[2]["done"] = False
        self.assertEqual(plan_edits(self.ITEMS, rows), [
            ("update", "a", {"label": "Book the big venue", "status": "DONE", "date": "2026-10-14"}),
            ("owners", "b", ["Chloe", "Sam"]),
            ("update", "e", {"status": "OPEN"}),
        ])

    def test_add_and_delete(self):
        rows = self.rows()[1:]  # the first row was deleted
        rows.append({"id": None, "done": None, "todo": "  Call   the hotel ", "who": "Maya", "due": "2026-10-20"})
        rows.append({"id": None, "done": None, "todo": "", "who": "Ben", "due": None})  # an empty new row: ignored
        self.assertEqual(plan_edits(self.ITEMS, rows), [
            ("add", {"label": "Call the hotel", "done": False, "owners": ["Maya"], "due": "2026-10-20"}),
            ("delete", "a"),
        ])

    def test_pandas_empty_cells(self):
        # What st.data_editor hands back for a new row: NaN everywhere, and NaN is truthy.
        rows = self.rows() + [{"id": math.nan, "done": math.nan, "todo": "Buy snacks", "who": math.nan, "due": math.nan}]
        self.assertEqual(plan_edits(self.ITEMS, rows), [("add", {"label": "Buy snacks", "done": False, "owners": [], "due": None})])
        self.assertEqual(plan_edits(self.ITEMS, self.rows()[:2] + [{"id": math.nan, "todo": math.nan}] + self.rows()[2:]), [])

    def test_cleared_text_and_date_are_left_alone(self):
        rows = self.rows()
        rows[0].update(todo="  ", due=None)
        self.assertEqual(plan_edits(self.ITEMS, rows), [])

    def test_owner_order_and_case_do_not_count_as_a_change(self):
        items = [{**COMPLETE, "owners": ["Ben", "Maya"]}]
        rows = editor_rows(items)
        rows[0]["who"] = "maya, BEN"
        self.assertEqual(plan_edits(items, rows), [])

    def test_round_trip_through_a_dataframe(self):
        # The page puts the rows in a DataFrame for st.data_editor and reads them back with to_dict("records").
        import pandas as pd

        frame = pd.DataFrame(self.rows(), columns=["id", "done", "todo", "who", "due"])
        self.assertEqual(plan_edits(self.ITEMS, frame.to_dict("records")), [])
        grown = pd.concat([frame, pd.DataFrame([{"todo": "Buy snacks", "due": pd.Timestamp("2026-10-30")}])], ignore_index=True)
        self.assertEqual(plan_edits(self.ITEMS, grown.to_dict("records")),
                         [("add", {"label": "Buy snacks", "done": False, "owners": [], "due": "2026-10-30"})])

    def test_split_owners(self):
        self.assertEqual(split_owners("Ben, Maya and Chloe & Sam / Ben"), ["Ben", "Maya", "Chloe", "Sam"])
        self.assertEqual(split_owners(None), [])


@unittest.skipUnless(importlib.util.find_spec("streamlit"), "streamlit not installed")
class DemoPage(unittest.TestCase):
    """Runs demo/app.py against a fake server."""

    VIEWS = {
        "actionItems": [COMPLETE, NO_DUE, NO_STATUS, NO_OWNER, BARE, DONE_ITEM],
        "changes": [{"status": "DONE", "type": "TEXT", "created": [], "statusChanges": [], "dateChanges": []}],
        "decisions": [{"id": "d1", "label": "Use [brackets] safely"}], "blockers": [], "orgChart": {"nodes": [], "edges": []},
    }

    def run_page(self, board=None):
        from streamlit.testing.v1 import AppTest

        responses = {
            "/api/status": {"reachable": True, "cloudinary": False, "visionModel": "test"},
            "/api/workspaces/7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c/views": self.VIEWS,
            "/api/workspaces/7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c": {"workspace": {"id": "7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c", "name": "Team offsite · 3f2a"}, "sources": [], "nodes": [], "edges": []},
        }
        calls = []

        def fake_request(method, url, **_):
            path = url.split("8787", 1)[1]
            calls.append((method, path))
            if path not in responses:
                return mock.Mock(ok=False, status_code=404, text="not found")
            r = mock.Mock(ok=True)
            r.json.return_value = responses[path]
            return r

        at = AppTest.from_file(str(Path(__file__).with_name("app.py")), default_timeout=30)
        if board:
            at.query_params["board"] = board
        with mock.patch("requests.request", side_effect=fake_request):
            at.run()
        return at, calls

    def test_start_screen_offers_a_new_board_and_lists_no_one_elses(self):
        at, calls = self.run_page()
        self.assertFalse(at.exception, at.exception)
        self.assertEqual([b.label for b in at.button], ["Start with an example", "Start with a blank board"])
        self.assertNotIn(("GET", "/api/workspaces"), calls, "the page must never list other people's boards")

    def test_board_renders_incomplete_todos(self):
        at, _ = self.run_page("7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c")
        self.assertFalse(at.exception, at.exception)
        page = "\n".join(m.value for m in at.markdown)
        for label in ("Book the venue", "Order the catering", "Send the invitations", "Print the badges", "Call the hotel", "Write the agenda"):
            self.assertIn(label, page)
        self.assertIn("| **Call the hotel** | nobody yet | no date |", page)
        self.assertIn("Your board: Team offsite · 3f2a", page)
        self.assertIn("Use \\[brackets\\] safely", page, "decision labels are escaped")
        self.assertIn("?board=7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c", "\n".join(c.value for c in at.code), "the board's own link is shown")

    def test_missing_board(self):
        at, _ = self.run_page("0d8f2b9e-4c1a-4e7b-9a3f-1b2c3d4e5f60")
        self.assertFalse(at.exception, at.exception)
        self.assertIn("doesn't exist", "\n".join(w.value for w in at.warning))

    def test_a_crafted_board_link_never_reaches_the_server(self):
        for board in ("../workspaces", "7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c/../../workspaces", "x?y", "../sources/s1/trace"):
            at, calls = self.run_page(board)
            self.assertFalse(at.exception, at.exception)
            self.assertIn("doesn't exist", "\n".join(w.value for w in at.warning))
            self.assertEqual([p for _, p in calls if p != "/api/status"], [], f"{board!r} was sent to the server")


@unittest.skipUnless(importlib.util.find_spec("streamlit"), "streamlit not installed")
class HostedPage(unittest.TestCase):
    """The hosted copy: no AI of its own, so each visitor connects their own key."""

    PROVIDERS = [{"id": "gemini", "label": "Google Gemini", "defaultModel": "gemini-3.8-flash", "keyUrl": "https://aistudio.google.com/apikey"},
                 {"id": "openai", "label": "OpenAI", "keyUrl": "https://platform.openai.com/api-keys"}]

    def run_page(self, board=None, key=None, check_ok=True, click=None, text=None):
        from streamlit.testing.v1 import AppTest

        views = {"actionItems": [], "changes": [], "decisions": [], "blockers": [], "orgChart": {"nodes": [], "edges": []}}
        responses = {
            "/api/status": {"reachable": False, "cloudinary": False, "aiProviders": self.PROVIDERS},
            "/api/workspaces/7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c/views": views,
            "/api/workspaces/7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c": {"workspace": {"id": "7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c", "name": "Board · 0000"}, "sources": [], "nodes": [], "edges": []},
            "/api/workspaces/7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c/sources": [{"id": "s1"}],
            "/api/ai/check": {"ok": True} if check_ok else {"ok": False, "error": "401 API key not valid"},
        }
        calls = []

        def fake_request(method, url, **kw):
            path = url.split("8787", 1)[1]
            calls.append((method, path, kw.get("data") or {}))
            r = mock.Mock(ok=True)
            r.json.return_value = responses[path]
            return r

        at = AppTest.from_file(str(Path(__file__).with_name("app.py")), default_timeout=30)
        if board:
            at.query_params["board"] = board
        if key:
            at.session_state["ai"] = key
        with mock.patch("requests.request", side_effect=fake_request), mock.patch("time.sleep"):
            at.run()
            if text is not None:
                at.text_area[0].set_value(text).run()
            if click:
                for label, value in (click if isinstance(click, list) else [click]):
                    if value is not None:
                        next(t for t in at.text_input if t.label == label).set_value(value).run()
                    else:
                        next(b for b in at.button if b.label == label).click().run()
        return at, calls

    def test_start_screen_asks_for_a_key_first(self):
        at, _ = self.run_page()
        self.assertFalse(at.exception, at.exception)
        self.assertEqual([s.value for s in at.subheader][:2], ["1. Connect your AI", "2. Start your board"])
        self.assertIn("API key", [t.label for t in at.text_input])
        self.assertEqual(next(t for t in at.text_input if t.label == "Model").value, "gemini-3.8-flash")
        self.assertIn("aistudio.google.com/apikey", "\n".join(m.value for m in at.markdown))

    def test_a_working_key_is_kept_for_the_session_only(self):
        at, calls = self.run_page(click=[("API key", "AIza-test"), ("Use this key", None)])
        self.assertFalse(at.exception, at.exception)
        self.assertEqual(at.session_state["ai"]["key"], "AIza-test")
        self.assertIn(("POST", "/api/ai/check", {"ai_provider": "gemini", "ai_key": "AIza-test", "ai_model": "gemini-3.8-flash"}), calls)
        self.assertIn("Connected: Google Gemini", "\n".join(s.value for s in at.success))

    def test_a_bad_key_says_why(self):
        at, _ = self.run_page(check_ok=False, click=[("API key", "nope"), ("Use this key", None)])
        self.assertNotIn("ai", at.session_state)
        self.assertIn("API key not valid", "\n".join(e.value for e in at.error))

    def test_without_a_key_notes_are_blocked(self):
        at, _ = self.run_page(board="7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c")
        self.assertFalse(at.exception, at.exception)
        self.assertTrue(next(b for b in at.button if b.label == "Add").disabled)
        self.assertIn("Connect your AI", "\n".join(m.value for m in at.markdown))

    def test_notes_carry_the_visitors_key(self):
        key = {"provider": "gemini", "key": "AIza-test", "model": "gemini-3.8-flash", "label": "Google Gemini"}
        at, calls = self.run_page(board="7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c", key=key, text="- Sam: write the agenda by Friday", click=("Add", None))
        self.assertFalse(at.exception, at.exception)
        sent = [d for m, p, d in calls if m == "POST" and p == "/api/workspaces/7c1e4a2b-3d5f-4e6a-8b9c-0d1e2f3a4b5c/sources"]
        self.assertEqual(len(sent), 1)
        self.assertEqual({k: sent[0][k] for k in ("ai_provider", "ai_key", "ai_model")},
                         {"ai_provider": "gemini", "ai_key": "AIza-test", "ai_model": "gemini-3.8-flash"})


if __name__ == "__main__":
    unittest.main()
