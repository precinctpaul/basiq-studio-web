# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Basiq WORKER role -- Windows, onedir build.

Produces three executables sharing one onedir install (uses MERGE(), the
documented PyInstaller pattern for several entry points that share
dependencies landing in one directory, instead of three separate builds
that would triplicate yt-dlp/basiq_agent.py on disk):

    basiq-worker.exe          the poll/claim/download engine (headless,
                               console=True -- nobody looks at this window
                               directly, it's what the tray app supervises)
    basiq-worker-tray.exe     the tray-icon supervisor a teammate actually
                               runs (console=False -- no window at all)
    basiq-youtube-login.exe   the one interactive first-run/re-login step
                               (console=True -- the visible browser IS the
                               UI, but keeping a console around is harmless
                               and simplest)

Build from THIS role's own venv, not tools/.venv -- see
requirements-worker.txt's header for why (the point is that torch/spaCy/
faster-whisper are never even installed here, not just excluded below):

    ..\.venv-worker\Scripts\python.exe -m pip install --upgrade pyinstaller pyinstaller-hooks-contrib
    ..\.venv-worker\Scripts\python.exe -m PyInstaller --noconfirm build\basiq_worker.spec

basiq_worker.py imports basiq_agent.py in-process (for run_grab/
run_live_capture), and basiq_agent.py's own lazy `import torch` / `import
spacy` etc. (inside summarization/tagging functions this role never calls)
are still literal import statements PyInstaller's static scanner can find
even though they never execute here. Excluding them below is belt-and-
suspenders on top of them not being installed in this venv at all.

pystray is the one dependency here with no track record in this codebase
(basiq_agent.spec, the only prior PyInstaller build here, has never frozen
it) -- its Windows backend is selected via its own internal try/except
import cascade, a pattern that commonly needs an explicit hidden-import
nudge for PyInstaller's static scanner to follow correctly. collect_all()
below is a defensive measure for exactly that; if pystray's tray icon
doesn't render in a frozen build, this is the first place to look.
"""
import os

from PyInstaller.utils.hooks import collect_all

TOOLS_DIR = os.path.join(SPECPATH, "..")

datas = []
binaries = []
hiddenimports = []

NEEDS_EXPLICIT_COLLECTION = [
    "yt_dlp",     # same reason as basiq_agent.spec: dynamic extractor loading
    "pystray",    # see module docstring above -- unproven in this codebase
]
for pkg in NEEDS_EXPLICIT_COLLECTION:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# None of these are installed in this role's own venv (requirements-worker.txt
# deliberately omits them) -- excluded explicitly anyway so a static-scan hit
# on basiq_agent.py's lazy imports can never accidentally pull one in.
COMMON_EXCLUDES = [
    "torch", "torch.utils.tensorboard", "transformers", "spacy",
    "en_core_web_sm", "sentence_transformers", "keybert", "faster_whisper",
    "ctranslate2", "huggingface_hub",
    "matplotlib", "IPython", "notebook", "jupyter", "pytest",
    "tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6",
]

worker_a = Analysis(
    [os.path.join(TOOLS_DIR, "basiq_worker.py")],
    pathex=[TOOLS_DIR],
    binaries=list(binaries),
    datas=list(datas),
    hiddenimports=list(hiddenimports),
    excludes=COMMON_EXCLUDES,
    noarchive=False,
)
tray_a = Analysis(
    [os.path.join(TOOLS_DIR, "basiq_worker_tray.py")],
    pathex=[TOOLS_DIR],
    binaries=list(binaries),
    datas=list(datas),
    hiddenimports=list(hiddenimports),
    excludes=COMMON_EXCLUDES,
    noarchive=False,
)
login_a = Analysis(
    [os.path.join(TOOLS_DIR, "youtube_session.py")],
    pathex=[TOOLS_DIR],
    binaries=list(binaries),
    datas=list(datas),
    hiddenimports=list(hiddenimports),
    excludes=COMMON_EXCLUDES,
    noarchive=False,
)

MERGE(
    (worker_a, "basiq-worker", "basiq-worker"),
    (tray_a, "basiq-worker-tray", "basiq-worker-tray"),
    (login_a, "basiq-youtube-login", "basiq-youtube-login"),
)

worker_pyz = PYZ(worker_a.pure)
tray_pyz = PYZ(tray_a.pure)
login_pyz = PYZ(login_a.pure)

worker_exe = EXE(
    worker_pyz, worker_a.scripts, [],
    exclude_binaries=True, name="basiq-worker", console=True, icon=None,
)
tray_exe = EXE(
    tray_pyz, tray_a.scripts, [],
    exclude_binaries=True, name="basiq-worker-tray", console=False, icon=None,
)
login_exe = EXE(
    login_pyz, login_a.scripts, [],
    exclude_binaries=True, name="basiq-youtube-login", console=True, icon=None,
)

coll = COLLECT(
    worker_exe, worker_a.binaries, worker_a.zipfiles, worker_a.datas,
    tray_exe, tray_a.binaries, tray_a.zipfiles, tray_a.datas,
    login_exe, login_a.binaries, login_a.zipfiles, login_a.datas,
    strip=False,
    upx=False,
    name="basiq-worker",
)
