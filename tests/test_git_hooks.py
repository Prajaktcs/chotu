"""Check hook selection for changes that affect compiled Rust behavior."""

from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GitHookChangesTests(unittest.TestCase):
    def groups(self, *paths):
        result = subprocess.run(
            ["bash", "-c", ". .githooks/changes.sh; change_groups"],
            cwd=ROOT,
            input="\n".join(paths) + "\n",
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.splitlines()

    def test_prompt_only_changes_select_rust(self):
        for path in (
            "prompts/email_classifier_system_prompt.txt",
            "prompts/nested/new_prompt.txt",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.groups(path), ["rust"])

    def test_compiled_sql_inputs_still_select_rust(self):
        self.assertEqual(
            self.groups("chotu-common/migrations/20260824000003_condition_tracking.sql"),
            ["rust"],
        )

    def test_prompt_documentation_selects_both_checks_once(self):
        self.assertEqual(
            self.groups("prompts/README.md", "prompts/email_classifier_system_prompt.txt"),
            ["markdown", "rust"],
        )

    def test_api_fixture_changes_select_both_contract_suites(self):
        self.assertEqual(
            self.groups("app/src/api/fixtures/health.json"),
            ["rust", "app"],
        )

    def test_unrelated_text_does_not_select_rust(self):
        self.assertEqual(self.groups("notes/example.txt"), [])
