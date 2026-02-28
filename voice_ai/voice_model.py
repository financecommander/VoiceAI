"""voice_model.py – thin wrappers around TTS and STT backends.

The module deliberately keeps the backend calls behind simple interfaces so
they can be swapped or mocked in tests without requiring audio hardware.

Backends used (install via requirements.txt):
  - pyttsx3  (offline TTS – works on Linux, macOS, Windows)
  - SpeechRecognition + PyAudio  (microphone STT via Google Web Speech API)
"""

from __future__ import annotations

import logging
import queue
import threading
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


class TTSEngine:
    """Text-to-speech engine backed by *pyttsx3*.

    The engine is initialised lazily on the first call to :meth:`speak` so
    that importing the module never raises even when audio drivers are absent
    (useful in CI / headless environments).
    """

    def __init__(self, rate: int = 175, volume: float = 1.0) -> None:
        self.rate = rate
        self.volume = volume
        self._engine = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def speak(self, text: str) -> None:
        """Convert *text* to speech and block until playback finishes."""
        if not text:
            return
        engine = self._get_engine()
        engine.say(text)
        engine.runAndWait()

    def speak_async(self, text: str, on_done: Optional[Callable[[], None]] = None) -> None:
        """Speak *text* in a background thread, then call *on_done* if given."""

        def _worker() -> None:
            self.speak(text)
            if on_done:
                on_done()

        t = threading.Thread(target=_worker, daemon=True)
        t.start()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_engine(self) -> "Any":
        """Lazily initialise and return the pyttsx3 engine."""
        if self._engine is None:
            try:
                import pyttsx3  # type: ignore[import]

                engine = pyttsx3.init()
                engine.setProperty("rate", self.rate)
                engine.setProperty("volume", self.volume)
                self._engine = engine
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(
                    "Failed to initialise TTS engine. "
                    "Install pyttsx3 and the required system speech library.\n"
                    f"Original error: {exc}"
                ) from exc
        return self._engine


class STTEngine:
    """Speech-to-text engine backed by the *SpeechRecognition* library.

    Uses the Google Web Speech API by default (requires internet access).
    For fully offline recognition pass ``recognizer="sphinx"`` (requires
    the optional ``pocketsphinx`` package).
    """

    def __init__(self, recognizer: str = "google", language: str = "en-US") -> None:
        self.recognizer = recognizer
        self.language = language

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def listen(self, timeout: Optional[float] = 5.0) -> Optional[str]:
        """Record audio from the default microphone and return the transcript.

        Returns *None* if nothing was understood or an error occurred.

        Parameters
        ----------
        timeout:
            Seconds to wait for speech to start before giving up.
        """
        try:
            import speech_recognition as sr  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError(
                "SpeechRecognition is not installed. "
                "Run: pip install SpeechRecognition pyaudio"
            ) from exc

        recognizer = sr.Recognizer()
        try:
            with sr.Microphone() as source:
                logger.debug("Adjusting for ambient noise…")
                recognizer.adjust_for_ambient_noise(source, duration=0.5)
                logger.debug("Listening…")
                audio = recognizer.listen(source, timeout=timeout)
        except sr.WaitTimeoutError:
            logger.debug("No speech detected within timeout.")
            return None
        except OSError as exc:
            logger.warning("Microphone error: %s", exc)
            return None

        return self._recognise(recognizer, audio)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _recognise(self, recognizer: "Any", audio: "Any") -> Optional[str]:
        import speech_recognition as sr  # type: ignore[import]

        try:
            if self.recognizer == "sphinx":
                return recognizer.recognize_sphinx(audio, language=self.language)
            return recognizer.recognize_google(audio, language=self.language)
        except sr.UnknownValueError:
            logger.debug("Could not understand audio.")
        except sr.RequestError as exc:
            logger.warning("Recognition service error: %s", exc)
        return None
