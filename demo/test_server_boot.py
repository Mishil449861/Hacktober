"""
Tests for server_boot (no Node or server needed): replacing a server left running from before an update.

    python -m unittest discover -s demo -v
"""
from __future__ import annotations

import unittest
from unittest import mock

import server_boot


class ReplaceIfOutdated(unittest.TestCase):
    def setUp(self):
        server_boot._replaced.clear()

    def run_it(self, status):
        with mock.patch.object(server_boot, "code_version", return_value="new"), \
             mock.patch.object(server_boot.os, "kill") as kill, \
             mock.patch.object(server_boot, "healthy", return_value=False), \
             mock.patch.object(server_boot, "ensure_server") as ensure:
            replaced = server_boot.replace_if_outdated("http://127.0.0.1:8787", status)
        return replaced, kill, ensure

    def test_an_outdated_server_is_stopped_and_started_again(self):
        replaced, kill, ensure = self.run_it({"codeVersion": "old", "pid": 4242})
        self.assertTrue(replaced)
        kill.assert_called_once()
        self.assertEqual(kill.call_args[0][0], 4242)
        ensure.assert_called_once()

    def test_the_current_server_is_left_alone(self):
        replaced, kill, _ = self.run_it({"codeVersion": "new", "pid": 4242})
        self.assertFalse(replaced)
        kill.assert_not_called()

    def test_a_server_that_does_not_report_its_pid_is_left_alone(self):
        # The laptop server listens on the network and never reports a pid: it is never killed from the page.
        replaced, kill, _ = self.run_it({"codeVersion": "old"})
        self.assertFalse(replaced)
        kill.assert_not_called()

    def test_only_once_per_old_version_so_a_mismatch_cannot_loop(self):
        self.run_it({"codeVersion": "old", "pid": 1})
        replaced, kill, _ = self.run_it({"codeVersion": "old", "pid": 2})
        self.assertFalse(replaced)
        kill.assert_not_called()


class CodeVersion(unittest.TestCase):
    def test_stable_and_short(self):
        self.assertEqual(server_boot.code_version(), server_boot.code_version())
        self.assertRegex(server_boot.code_version(), r"^[0-9a-f]{12}$")


if __name__ == "__main__":
    unittest.main()
