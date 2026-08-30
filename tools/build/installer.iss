; Basiq Agent — Windows installer.
;
; Wraps the PyInstaller onedir build (build\dist\basiq-agent\) so a teammate's
; whole install is "download one .exe, double-click it, done" — no zip to
; extract, no venv to build, no PATH checkbox to remember. Everything Python
; used to need at install time is already inside basiq-agent.exe.
;
; Build order: PyInstaller must have already produced build\dist\basiq-agent\
; (run build_windows.ps1, or the two steps it wraps, first). Then:
;   "C:\Users\<you>\AppData\Local\Programs\Inno Setup 6\ISCC.exe" installer.iss
;
; Installs per-user, no admin required — this machine may not have an admin
; account handy, and nothing here needs one.

#define MyAppName "Basiq Agent"
#define MyAppVersion "1.0.0"
#define MyAppExeName "basiq-agent.exe"
#define MyAppPublisher "Basiq Studio Hub"

[Setup]
AppId={{6E9F0D6A-6F2C-4B9A-9E6B-7F6C8C0B5A3D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\BasiqAgent
DefaultGroupName=Basiq Agent
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=installer_output
OutputBaseFilename=Basiq-Agent-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The agent's own dependency chain is 2-3GB uncompressed; LZMA2 buys back a
; meaningful chunk of that for the one-time download without slowing the
; already-fast local extract enough to notice.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Files]
Source: "dist\basiq-agent\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Start Basiq Agent"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall Basiq Agent"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Start Basiq Agent"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Start Basiq Agent now"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
var
  MediaRootPage: TInputQueryWizardPage;

const
  SuggestedMediaRoot = 'C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub';

function GetExistingMediaRoot(): String;
var
  Contents: AnsiString;
  MarkerPath: String;
begin
  Result := '';
  MarkerPath := ExpandConstant('{app}\media_root.txt');
  if FileExists(MarkerPath) and LoadStringFromFile(MarkerPath, Contents) then
    Result := Trim(String(Contents));
end;

procedure InitializeWizard;
begin
  MediaRootPage := CreateInputQueryPage(wpSelectDir,
    'Shared Media Drive',
    'Where does your team keep shared footage?',
    'This is the LucidLink (or other shared/mounted) folder your team uses — ' +
    'ask your team lead if you''re not sure, everyone must point at the exact ' +
    'same folder for the shared library to work. Leave the suggested value if ' +
    'you don''t have one yet; media then stays local to this PC until you ' +
    'rerun this installer to change it.');
  MediaRootPage.Add('Folder path:', False);
  // {app} isn't expandable yet at this point in the wizard (the directory
  // page that sets it hasn't run) — the real default. Any existing
  // media_root.txt from a prior install is picked up in CurPageChanged
  // below, once {app} is valid, and overwrites this before the page shows.
  MediaRootPage.Values[0] := SuggestedMediaRoot;
end;

// Re-running the installer to point at a different folder is the whole
// reason this reads (and re-saves) media_root.txt instead of only writing
// it once — same "safe to rerun" contract Basiq-Setup.bat used to offer.
procedure CurStepChanged(CurStep: TSetupStep);
var
  MediaRoot: String;
begin
  if CurStep = ssPostInstall then
  begin
    MediaRoot := Trim(MediaRootPage.Values[0]);
    if MediaRoot = '' then
      MediaRoot := SuggestedMediaRoot;
    SaveStringToFile(ExpandConstant('{app}\media_root.txt'), MediaRoot, False);
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
end;

// FFmpeg still has to come from winget/brew for this release (bundling it is
// tracked separately — see Next Tasks). Flagging its absence here at least
// keeps parity with what Basiq-Setup.bat used to tell people.
procedure CurPageChanged(CurPageID: Integer);
var
  ResultCode: Integer;
  Existing: String;
begin
  // {app} only becomes valid once the directory page (just before this one)
  // has run, so this is the first safe place to look for a prior install's
  // media_root.txt and use it to override the hardcoded suggested default.
  if (MediaRootPage <> nil) and (CurPageID = MediaRootPage.ID) then
  begin
    Existing := GetExistingMediaRoot();
    if Existing <> '' then
      MediaRootPage.Values[0] := Existing;
  end;

  if CurPageID = wpFinished then
  begin
    if not Exec(ExpandConstant('{cmd}'), '/C where ffmpeg >nul 2>nul', '',
      SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    begin
      MsgBox('FFmpeg was not found on this PC.' + #13#10 + #13#10 +
        'Live capture and clip export won''t work until it''s installed — ' +
        'everything else will. Get it with:' + #13#10 + #13#10 +
        '    winget install --id Gyan.FFmpeg -e' + #13#10 + #13#10 +
        'or from https://www.gyan.dev/ffmpeg/builds/', mbInformation, MB_OK);
    end;
  end;
end;
