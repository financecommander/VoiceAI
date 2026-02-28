"""repo_loader.py – scan and index files from a local repository."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Iterator, List, Optional

# File extensions considered as source/text content worth indexing.
_DEFAULT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py", ".js", ".ts", ".jsx", ".tsx",
        ".java", ".c", ".cpp", ".h", ".hpp",
        ".cs", ".go", ".rs", ".rb", ".php",
        ".html", ".css", ".scss",
        ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
        ".md", ".txt", ".rst",
        ".sh", ".bash", ".zsh",
        ".sql",
    }
)

# Directories that should never be traversed.
_SKIP_DIRS: frozenset[str] = frozenset(
    {
        ".git", ".hg", ".svn",
        "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache",
        "venv", ".venv", "env", ".env",
        "dist", "build", "target",
        ".idea", ".vscode",
    }
)


class RepoLoader:
    """Load the text files of a local repository into memory.

    Parameters
    ----------
    repo_path:
        Absolute or relative path to the root of the repository.
    extensions:
        Optional set of file extensions (with leading dot) to include.
        When *None* the built-in :data:`_DEFAULT_EXTENSIONS` set is used.
    max_file_bytes:
        Files larger than this threshold are skipped (default 1 MiB).
    """

    def __init__(
        self,
        repo_path: str | os.PathLike,
        extensions: Optional[frozenset[str]] = None,
        max_file_bytes: int = 1_048_576,
    ) -> None:
        self.repo_path = Path(repo_path).resolve()
        if not self.repo_path.is_dir():
            raise NotADirectoryError(
                f"Repository path does not exist or is not a directory: {self.repo_path}"
            )
        self.extensions: frozenset[str] = (
            extensions if extensions is not None else _DEFAULT_EXTENSIONS
        )
        self.max_file_bytes = max_file_bytes
        self._files: Dict[str, str] = {}  # relative path → content

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def load(self) -> "RepoLoader":
        """Walk the repository and read all matching files.

        Returns *self* so calls can be chained::

            loader = RepoLoader("/path/to/repo").load()
        """
        self._files = {}
        for path in self._iter_files():
            rel = str(path.relative_to(self.repo_path))
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
                self._files[rel] = content
            except OSError:
                pass  # skip unreadable files
        return self

    def get_file(self, relative_path: str) -> Optional[str]:
        """Return the content of a single file, or *None* if not loaded."""
        return self._files.get(relative_path)

    def list_files(self) -> List[str]:
        """Return the sorted list of loaded relative file paths."""
        return sorted(self._files.keys())

    def search(self, query: str, case_sensitive: bool = False) -> Dict[str, List[int]]:
        """Search all loaded files for *query* and return matching line numbers.

        Returns a mapping of ``{relative_path: [line_numbers]}`` for every
        file that contains at least one match.  Line numbers are 1-based.
        """
        results: Dict[str, List[int]] = {}
        needle = query if case_sensitive else query.lower()
        for rel, content in self._files.items():
            matches: List[int] = []
            for lineno, line in enumerate(content.splitlines(), start=1):
                haystack = line if case_sensitive else line.lower()
                if needle in haystack:
                    matches.append(lineno)
            if matches:
                results[rel] = matches
        return results

    def summary(self) -> str:
        """Return a human-readable one-line summary of the loaded repository."""
        total_lines = sum(
            len(c.splitlines()) for c in self._files.values()
        )
        return (
            f"Repository: {self.repo_path.name} | "
            f"Files loaded: {len(self._files)} | "
            f"Total lines: {total_lines}"
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _iter_files(self) -> Iterator[Path]:
        """Yield all file paths under *repo_path* that match our criteria."""
        for dirpath, dirnames, filenames in os.walk(self.repo_path):
            # Prune skip directories in-place so os.walk won't recurse into them.
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            for fname in filenames:
                fpath = Path(dirpath) / fname
                if fpath.suffix.lower() not in self.extensions:
                    continue
                try:
                    if fpath.stat().st_size > self.max_file_bytes:
                        continue
                except OSError:
                    continue
                yield fpath
