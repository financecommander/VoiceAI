# VoiceAI

An AI voice assistant that loads local code repositories and lets you query
them using natural language — either by voice (microphone + speakers) or in
plain-text mode (great for headless/CI environments).

---

## Features

- **Local repository loading** – recursively scans a directory and indexes all
  source / text files (`.py`, `.js`, `.md`, `.yaml`, etc.).  Skips binary
  files, large files, and common noise directories (`node_modules`,
  `__pycache__`, `.git`, …).
- **Voice interaction** – text-to-speech via [pyttsx3](https://pypi.org/project/pyttsx3/)
  (offline) and speech-to-text via
  [SpeechRecognition](https://pypi.org/project/SpeechRecognition/) (Google
  Web Speech API by default, or offline via pocketsphinx).
- **Text-only mode** – `--text` flag lets you query the repo without a
  microphone, ideal for scripting and testing.

---

## Quick Start

### 1. Install dependencies

```bash
# On Ubuntu/Debian you need portaudio for microphone support:
sudo apt-get install portaudio19-dev python3-espeak

pip install -r requirements.txt
```

### 2. Run

```bash
# Voice mode (requires microphone + speakers)
python main.py /path/to/your/repo

# Text-only mode (no audio hardware needed)
python main.py /path/to/your/repo --text "how many files"
python main.py /path/to/your/repo --text "list files"
python main.py /path/to/your/repo --text "search def"
python main.py /path/to/your/repo --text "summary"
```

### 3. Run tests

```bash
python -m pytest tests/ -v
```

---

## Project Structure

```
VoiceAI/
├── main.py                  # CLI entry point
├── requirements.txt
├── voice_ai/
│   ├── __init__.py
│   ├── repo_loader.py       # Scans & indexes a local repository
│   ├── voice_model.py       # TTS (pyttsx3) + STT (SpeechRecognition)
│   └── assistant.py         # Orchestrates repo + voice interaction
└── tests/
    ├── test_repo_loader.py
    ├── test_voice_model.py
    └── test_assistant.py
```

---

## Supported voice queries

| Query example | What it does |
|---|---|
| `how many files` | Counts loaded files |
| `list files` | Lists file paths (first 10) |
| `search <term>` | Full-text search across all files |
| `summary` / `overview` | One-line repository summary |
