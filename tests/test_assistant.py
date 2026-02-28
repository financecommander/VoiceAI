"""Tests for voice_ai.assistant (VoiceAssistant)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from voice_ai.assistant import VoiceAssistant
from voice_ai.voice_model import STTEngine, TTSEngine


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    """Minimal fake repository."""
    (tmp_path / "app.py").write_text("print('app')\n")
    (tmp_path / "lib.py").write_text("def helper(): pass\n")
    (tmp_path / "README.md").write_text("# Docs\n")
    return tmp_path


def _make_assistant(repo: Path) -> tuple[VoiceAssistant, MagicMock, MagicMock]:
    """Return (assistant, mock_tts, mock_stt)."""
    tts = MagicMock(spec=TTSEngine)
    stt = MagicMock(spec=STTEngine)
    assistant = VoiceAssistant(repo_path=str(repo), tts=tts, stt=stt)
    return assistant, tts, stt


# ---------------------------------------------------------------------------
# load_repo / announce_repo
# ---------------------------------------------------------------------------


def test_load_repo_returns_summary(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    summary = assistant.load_repo()
    assert repo.name in summary
    assert "Files loaded:" in summary


def test_announce_repo_speaks_summary(repo: Path) -> None:
    assistant, tts, _ = _make_assistant(repo)
    assistant.announce_repo()
    tts.speak.assert_called_once()
    spoken = tts.speak.call_args[0][0]
    assert repo.name in spoken


def test_load_repo_sets_loaded_flag(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    assert not assistant._loaded
    assistant.load_repo()
    assert assistant._loaded


# ---------------------------------------------------------------------------
# text_query
# ---------------------------------------------------------------------------


def test_text_query_triggers_load(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    assistant.text_query("how many files")
    assert assistant._loaded


def test_text_query_file_count(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    answer = assistant.text_query("how many files are there?")
    assert "3" in answer  # app.py, lib.py, README.md


def test_text_query_list_files(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    answer = assistant.text_query("list files")
    assert "app.py" in answer or "lib.py" in answer


def test_text_query_search(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    answer = assistant.text_query("search helper")
    assert "1" in answer  # one match in lib.py


def test_text_query_search_no_results(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    answer = assistant.text_query("search xyzzy_not_found")
    assert "No matches" in answer


def test_text_query_summary(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    answer = assistant.text_query("give me a summary")
    assert repo.name in answer


def test_text_query_unknown(repo: Path) -> None:
    assistant, _, _ = _make_assistant(repo)
    answer = assistant.text_query("what is the weather?")
    assert "Try:" in answer


# ---------------------------------------------------------------------------
# handle_voice_query
# ---------------------------------------------------------------------------


def test_handle_voice_query_speaks_answer(repo: Path) -> None:
    assistant, tts, stt = _make_assistant(repo)
    stt.listen.return_value = "how many files"
    answer = assistant.handle_voice_query()
    assert answer is not None
    # TTS must have been called for at least the answer
    assert tts.speak.called


def test_handle_voice_query_returns_none_when_no_transcript(repo: Path) -> None:
    assistant, tts, stt = _make_assistant(repo)
    stt.listen.return_value = None
    answer = assistant.handle_voice_query()
    assert answer is None
    # Should still speak a "didn't catch that" message
    assert tts.speak.called
