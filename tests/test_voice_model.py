"""Tests for voice_ai.voice_model (TTSEngine and STTEngine).

Audio hardware is not required – both engines are tested via mocking.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from voice_ai.voice_model import STTEngine, TTSEngine


# ===========================================================================
# TTSEngine
# ===========================================================================


class TestTTSEngine:
    """Unit tests for TTSEngine."""

    def _make_mock_pyttsx3(self) -> MagicMock:
        """Return a mock pyttsx3 module."""
        mock_engine = MagicMock()
        mock_pyttsx3 = MagicMock()
        mock_pyttsx3.init.return_value = mock_engine
        return mock_pyttsx3

    def test_speak_calls_say_and_runandwait(self) -> None:
        mock_pyttsx3 = self._make_mock_pyttsx3()
        with patch.dict("sys.modules", {"pyttsx3": mock_pyttsx3}):
            engine = TTSEngine()
            engine.speak("hello world")
        mock_engine = mock_pyttsx3.init.return_value
        mock_engine.say.assert_called_once_with("hello world")
        mock_engine.runAndWait.assert_called_once()

    def test_speak_empty_string_does_nothing(self) -> None:
        mock_pyttsx3 = self._make_mock_pyttsx3()
        with patch.dict("sys.modules", {"pyttsx3": mock_pyttsx3}):
            engine = TTSEngine()
            engine.speak("")
        mock_pyttsx3.init.assert_not_called()

    def test_speak_sets_rate_and_volume(self) -> None:
        mock_pyttsx3 = self._make_mock_pyttsx3()
        with patch.dict("sys.modules", {"pyttsx3": mock_pyttsx3}):
            engine = TTSEngine(rate=200, volume=0.5)
            engine.speak("test")
        mock_engine = mock_pyttsx3.init.return_value
        mock_engine.setProperty.assert_any_call("rate", 200)
        mock_engine.setProperty.assert_any_call("volume", 0.5)

    def test_engine_initialised_lazily(self) -> None:
        """pyttsx3.init() must not be called before the first speak()."""
        mock_pyttsx3 = self._make_mock_pyttsx3()
        with patch.dict("sys.modules", {"pyttsx3": mock_pyttsx3}):
            TTSEngine()  # construct without speaking
        mock_pyttsx3.init.assert_not_called()

    def test_engine_reused_across_calls(self) -> None:
        mock_pyttsx3 = self._make_mock_pyttsx3()
        with patch.dict("sys.modules", {"pyttsx3": mock_pyttsx3}):
            engine = TTSEngine()
            engine.speak("first")
            engine.speak("second")
        assert mock_pyttsx3.init.call_count == 1

    def test_speak_async_calls_on_done(self) -> None:
        mock_pyttsx3 = self._make_mock_pyttsx3()
        done_event = threading.Event()
        with patch.dict("sys.modules", {"pyttsx3": mock_pyttsx3}):
            engine = TTSEngine()
            engine.speak_async("async text", on_done=done_event.set)
        done_event.wait(timeout=2)
        assert done_event.is_set()

    def test_tts_raises_on_import_failure(self) -> None:
        with patch.dict("sys.modules", {"pyttsx3": None}):
            engine = TTSEngine()
            with pytest.raises(RuntimeError, match="TTS engine"):
                engine.speak("fail")


# ===========================================================================
# STTEngine
# ===========================================================================


class _FakeAudioData:
    pass


class TestSTTEngine:
    """Unit tests for STTEngine."""

    def _make_sr_mock(
        self,
        transcript: str | None = "hello",
        side_effect: Exception | None = None,
    ) -> MagicMock:
        """Build a minimal mock of the speech_recognition module."""
        import importlib
        import sys

        mock_sr = MagicMock()

        # Recognizer
        mock_recognizer = MagicMock()
        mock_sr.Recognizer.return_value = mock_recognizer

        # Microphone context manager
        mock_mic = MagicMock()
        mock_mic.__enter__ = MagicMock(return_value=MagicMock())
        mock_mic.__exit__ = MagicMock(return_value=False)
        mock_sr.Microphone.return_value = mock_mic

        # listen() returns fake audio
        mock_recognizer.listen.return_value = _FakeAudioData()

        # recognize_google
        if side_effect is not None:
            mock_recognizer.recognize_google.side_effect = side_effect
        else:
            mock_recognizer.recognize_google.return_value = transcript

        # Exception classes
        mock_sr.WaitTimeoutError = type("WaitTimeoutError", (Exception,), {})
        mock_sr.UnknownValueError = type("UnknownValueError", (Exception,), {})
        mock_sr.RequestError = type("RequestError", (Exception,), {})

        return mock_sr

    def test_listen_returns_transcript(self) -> None:
        mock_sr = self._make_sr_mock(transcript="how many files")
        with patch.dict("sys.modules", {"speech_recognition": mock_sr}):
            engine = STTEngine()
            result = engine.listen()
        assert result == "how many files"

    def test_listen_returns_none_on_unknown_value(self) -> None:
        mock_sr = self._make_sr_mock()
        mock_sr.Recognizer.return_value.recognize_google.side_effect = (
            mock_sr.UnknownValueError()
        )
        with patch.dict("sys.modules", {"speech_recognition": mock_sr}):
            engine = STTEngine()
            result = engine.listen()
        assert result is None

    def test_listen_returns_none_on_request_error(self) -> None:
        mock_sr = self._make_sr_mock()
        mock_sr.Recognizer.return_value.recognize_google.side_effect = (
            mock_sr.RequestError("network error")
        )
        with patch.dict("sys.modules", {"speech_recognition": mock_sr}):
            engine = STTEngine()
            result = engine.listen()
        assert result is None

    def test_listen_returns_none_on_timeout(self) -> None:
        mock_sr = self._make_sr_mock()
        mock_sr.Recognizer.return_value.listen.side_effect = (
            mock_sr.WaitTimeoutError()
        )
        with patch.dict("sys.modules", {"speech_recognition": mock_sr}):
            engine = STTEngine()
            result = engine.listen()
        assert result is None

    def test_stt_raises_without_speech_recognition(self) -> None:
        with patch.dict("sys.modules", {"speech_recognition": None}):
            engine = STTEngine()
            with pytest.raises(RuntimeError, match="SpeechRecognition"):
                engine.listen()

    def test_sphinx_recognizer_called_when_requested(self) -> None:
        mock_sr = self._make_sr_mock()
        mock_sr.Recognizer.return_value.recognize_sphinx.return_value = "test"
        with patch.dict("sys.modules", {"speech_recognition": mock_sr}):
            engine = STTEngine(recognizer="sphinx")
            engine.listen()
        mock_sr.Recognizer.return_value.recognize_sphinx.assert_called_once()
