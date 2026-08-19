# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Basiq agent — macOS, onedir .app bundle.

    cd tools/build
    ../.venv/bin/python -m PyInstaller --noconfirm --distpath dist --workpath work basiq_agent_macos.spec

UNTESTED. This was written and reasoned through on a Windows machine with no
Mac available to actually run it on. PyInstaller cannot cross-compile — a
.app has to be built by running PyInstaller ON macOS, with a venv that has
pip-installed the macOS wheels of every dependency (torch, ctranslate2,
spaCy, etc. all ship separate mac wheels; none of what built the Windows
.exe can be reused here). Treat this as a documented starting point, not a
verified artifact — see tools/build/README.md for what specifically wasn't
checkable from Windows.

Same collection strategy as the Windows spec (see basiq_agent.spec for why):
pyinstaller-hooks-contrib covers torch/spaCy/thinc/transformers automatically
once they're discovered via basiq_agent.py's own (deferred but literal)
import statements; the packages below either have no such hook or, for
en_core_web_sm, are never imported by a literal name a static scanner could
see, so they're collected explicitly.
"""
import os

from PyInstaller.utils.hooks import collect_all

TOOLS_DIR = os.path.join(SPECPATH, "..")

datas = []
binaries = []
hiddenimports = []

NEEDS_EXPLICIT_COLLECTION = [
    "en_core_web_sm",
    "yt_dlp",
    "faster_whisper",
    "ctranslate2",
    "sentence_transformers",
    "huggingface_hub",
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
    console=True,  # see Next Tasks (#3, tray icon) — a visible terminal is current behaviour on both OSes
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,  # same reasoning as Windows: UPX on multi-GB ML binaries is slow and risky for little gain
    name="basiq-agent",
)

# A bare COLLECT is a folder, not something Finder treats as an app. BUNDLE
# wraps it into Basiq Agent.app — PyInstaller special-cases console=True apps
# built this way to open Terminal.app and run inside it when double-clicked,
# which is the closest mac equivalent of the Windows build's visible console
# window. UNVERIFIED: this BUNDLE + console-in-Terminal interaction is
# documented PyInstaller behaviour but was never actually clicked on a Mac.
app = BUNDLE(
    coll,
    name="Basiq Agent.app",
    icon=None,
    bundle_identifier="com.basiqstudiohub.agent",
    info_plist={
        "NSHighResolutionCapable": True,
        "LSBackgroundOnly": False,
    },
)
