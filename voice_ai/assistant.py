"""assistant.py – orchestrates repo loading and voice interaction."""

from __future__ import annotations

import logging
from typing import Optional

from .repo_loader import RepoLoader
from .voice_model import STTEngine, TTSEngine

logger = logging.getLogger(__name__)


class VoiceAssistant:
    """High-level assistant that answers voice queries about a local repository.

    Parameters
    ----------
    repo_path:
        Path to the local repository to load.
    tts:
        Optional pre-configured :class:`TTSEngine`.  A default engine is
        created when *None*.
    stt:
        Optional pre-configured :class:`STTEngine`.  A default engine is
        created when *None*.
    """

    def __init__(
        self,
        repo_path: str,
        tts: Optional[TTSEngine] = None,
        stt: Optional[STTEngine] = None,
    ) -> None:
        self.loader = RepoLoader(repo_path)
        self.tts = tts or TTSEngine()
        self.stt = stt or STTEngine()
        self._loaded = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def load_repo(self) -> str:
        """Load the repository and return a spoken summary string."""
        logger.info("Loading repository: %s", self.loader.repo_path)
        self.loader.load()
        self._loaded = True
        summary = self.loader.summary()
        logger.info(summary)
        return summary

    def announce_repo(self) -> None:
        """Speak the repository summary aloud."""
        summary = self.load_repo()
        self.tts.speak(summary)

    def handle_voice_query(self) -> Optional[str]:
        """Listen for a voice query, process it, speak the answer, and return it.

        Returns the answer text, or *None* if nothing was understood.
        """
        if not self._loaded:
            self.load_repo()

        self.tts.speak("Ready. Please ask your question.")
        transcript = self.stt.listen()
        if not transcript:
            self.tts.speak("I did not catch that. Please try again.")
            return None

        logger.info("Query: %s", transcript)
        answer = self._process_query(transcript)
        self.tts.speak(answer)
        return answer

    def text_query(self, query: str) -> str:
        """Process a text *query* without using the microphone or speaker.

        Useful for testing and headless usage.
        """
        if not self._loaded:
            self.load_repo()
        return self._process_query(query)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _process_query(self, query: str) -> str:
        """Turn a free-text *query* into an answer about the loaded repository."""
        q = query.lower().strip()

        if any(kw in q for kw in ("how many files", "number of files", "file count")):
            files = self.loader.list_files()
            return f"The repository contains {len(files)} loaded file{'s' if len(files) != 1 else ''}."

        if any(kw in q for kw in ("list files", "what files", "show files", "files in")):
            files = self.loader.list_files()
            if not files:
                return "No files were loaded from the repository."
            preview = files[:10]
            suffix = f" … and {len(files) - 10} more." if len(files) > 10 else "."
            return "Loaded files: " + ", ".join(preview) + suffix

        if q.startswith("search ") or q.startswith("find "):
            term = q.split(" ", 1)[1].strip()
            if term:
                results = self.loader.search(term)
                if not results:
                    return f"No matches found for '{term}'."
                count = sum(len(v) for v in results.values())
                files_hit = len(results)
                return (
                    f"Found {count} occurrence{'s' if count != 1 else ''} of '{term}' "
                    f"across {files_hit} file{'s' if files_hit != 1 else ''}."
                )

        if any(kw in q for kw in ("summary", "overview", "describe")):
            return self.loader.summary()

        return (
            "I can answer questions about the loaded repository. "
            "Try: 'how many files', 'list files', 'search <term>', or 'summary'."
        )
