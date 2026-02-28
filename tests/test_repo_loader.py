"""Tests for voice_ai.repo_loader."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from voice_ai.repo_loader import RepoLoader, _DEFAULT_EXTENSIONS, _SKIP_DIRS


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    """Create a minimal fake repository tree."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\n")
    (tmp_path / "src" / "utils.py").write_text(
        textwrap.dedent("""\
            def add(a, b):
                return a + b

            def subtract(a, b):
                return a - b
        """)
    )
    (tmp_path / "README.md").write_text("# My Repo\nThis is the readme.\n")
    (tmp_path / "data.bin").write_bytes(b"\x00\x01\x02")  # should be skipped
    # A directory that should be skipped
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "lib.js").write_text("// should not be loaded\n")
    return tmp_path


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_raises_for_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(NotADirectoryError):
        RepoLoader(tmp_path / "does_not_exist")


def test_raises_for_file_path(tmp_path: Path) -> None:
    f = tmp_path / "file.txt"
    f.write_text("hi")
    with pytest.raises(NotADirectoryError):
        RepoLoader(f)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def test_load_returns_self(repo: Path) -> None:
    loader = RepoLoader(repo)
    result = loader.load()
    assert result is loader


def test_list_files_after_load(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    files = loader.list_files()
    # data.bin and node_modules/lib.js must not be present
    assert all(not f.endswith(".bin") for f in files)
    assert not any("node_modules" in f for f in files)
    # Python and Markdown files must be present
    assert "README.md" in files
    assert "src/main.py" in files
    assert "src/utils.py" in files


def test_files_empty_before_load(repo: Path) -> None:
    loader = RepoLoader(repo)
    assert loader.list_files() == []


def test_get_file_returns_content(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    content = loader.get_file("src/main.py")
    assert content is not None
    assert "print" in content


def test_get_file_returns_none_for_unknown(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    assert loader.get_file("nonexistent.py") is None


def test_skip_dirs_respected(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    for f in loader.list_files():
        parts = Path(f).parts
        assert not any(p in _SKIP_DIRS for p in parts)


def test_max_file_bytes_respected(repo: Path) -> None:
    # Write a large file
    big = repo / "big.py"
    big.write_text("x = 1\n" * 300_000)  # ~1.8 MB
    loader = RepoLoader(repo, max_file_bytes=1_048_576).load()
    assert "big.py" not in loader.list_files()


def test_custom_extensions(repo: Path) -> None:
    loader = RepoLoader(repo, extensions=frozenset({".md"})).load()
    files = loader.list_files()
    assert all(f.endswith(".md") for f in files)
    assert "README.md" in files


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def test_search_finds_matches(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    results = loader.search("def")
    assert "src/utils.py" in results
    assert len(results["src/utils.py"]) == 2  # def add and def subtract


def test_search_case_insensitive_by_default(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    results_lower = loader.search("print")
    results_upper = loader.search("PRINT")
    assert results_lower == results_upper


def test_search_case_sensitive(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    results_lower = loader.search("print", case_sensitive=True)
    results_upper = loader.search("PRINT", case_sensitive=True)
    assert results_lower  # 'print' exists
    assert not results_upper  # 'PRINT' does not


def test_search_no_match_returns_empty(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    results = loader.search("xyzzy_not_found_anywhere")
    assert results == {}


def test_search_line_numbers_are_one_based(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    results = loader.search("add")
    assert "src/utils.py" in results
    assert all(ln >= 1 for ln in results["src/utils.py"])


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def test_summary_contains_repo_name(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    summary = loader.summary()
    assert repo.name in summary


def test_summary_contains_file_count(repo: Path) -> None:
    loader = RepoLoader(repo).load()
    summary = loader.summary()
    files = loader.list_files()
    assert str(len(files)) in summary
