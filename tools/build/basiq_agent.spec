# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Basiq agent — Windows, onedir build.

    ..\.venv\Scripts\python.exe -m PyInstaller --noconfirm build\basiq_agent.spec

Onedir, not onefile: the agent's dependency chain (torch, ctranslate2, spaCy,
sentence-transformers, transformers) is 2-3GB installed. A onefile build would
re-extract that whole payload to a temp directory on every single launch —
several gigabytes copied before the agent could even bind its port. Onedir
unpacks once, at install time, and every later launch just runs the exe.

Most of that same dependency chain is also why this can't rely on
PyInstaller's default import scan. torch, spaCy and the transformers/
huggingface_hub stack each do their own registry- or metadata-driven dynamic
loading instead of plain `import` statements the static analyzer can follow.
pyinstaller-hooks-contrib ships vetted hooks for torch/spacy/thinc/
transformers/av/onnxruntime that run automatically once those packages are
discovered — which they are, since basiq_agent.py's lazy `import torch` /
`import spacy` etc. are still literal import statements PyInstaller's
bytecode scanner finds even though they execute inside functions, not at
module load. The packages below have no such hook (or, for en_core_web_sm,
are never imported by name at all — spaCy resolves the model string
dynamically) so they're collected explicitly.
"""
import os

from PyInstaller.utils.hooks import collect_all

TOOLS_DIR = os.path.join(SPECPATH, "..")

datas = []
binaries = []
hiddenimports = []

# Packages with no pyinstaller-hooks-contrib coverage, or (en_core_web_sm)
# never imported by a literal name a static scanner could see.
NEEDS_EXPLICIT_COLLECTION = [
    "en_core_web_sm",   # spacy.load("en_core_web_sm") resolves this by string
    "yt_dlp",
    "faster_whisper",   # ships its VAD model (silero_vad.onnx) as package data
    "ctranslate2",      # compiled extension with its own bundled math-kernel DLLs
    "sentence_transformers",
    "huggingface_hub",  # self-lazy-importing __init__, easy to under-collect
    "keybert",
]

for pkg in NEEDS_EXPLICIT_COLLECTION:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(TOOLS_DIR, "basiq_agent.py")],
    pathex=[TOOLS_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=[
        # Optional/dev extras pulled in transitively by the HF stack that
        # this agent never touches — trimmed to keep the install smaller.
        "matplotlib", "IPython", "notebook", "jupyter", "pytest",
        "tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6",
        "tensorboard", "torch.utils.tensorboard",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="basiq-agent",
    console=True,   # visible window by design for now — see Next Tasks (#3, tray icon)
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,   # UPX on multi-GB ML binaries (libtorch, ctranslate2) is slow and risky for little gain
    name="basiq-agent",
)
