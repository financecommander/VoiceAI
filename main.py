#!/usr/bin/env python3
"""main.py – CLI entry point for VoiceAI."""

from __future__ import annotations

import argparse
import logging
import sys

from voice_ai import VoiceAssistant


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="voiceai",
        description="AI voice model that loads and queries local repositories.",
    )
    parser.add_argument(
        "repo",
        metavar="REPO_PATH",
        help="Path to the local repository to load.",
    )
    parser.add_argument(
        "--text",
        metavar="QUERY",
        help="Run a single text query and exit (no microphone required).",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    assistant = VoiceAssistant(repo_path=args.repo)

    # ------------------------------------------------------------------
    # Text-only mode (no audio hardware required)
    # ------------------------------------------------------------------
    if args.text:
        answer = assistant.text_query(args.text)
        print(answer)
        return 0

    # ------------------------------------------------------------------
    # Interactive voice loop
    # ------------------------------------------------------------------
    print(assistant.load_repo())
    print("VoiceAI is ready. Press Ctrl-C to quit.")
    try:
        while True:
            answer = assistant.handle_voice_query()
            if answer:
                print(f"Answer: {answer}")
    except KeyboardInterrupt:
        print("\nGoodbye.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
