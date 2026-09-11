; Basiq Worker -- Windows installer.
;
; Wraps the PyInstaller onedir build (build\dist\basiq-worker\) into a single
; "download one .exe, double-click it, done" install -- same philosophy as
; installer.iss (the per-person agent), but for the GRAB-executing worker
; role. Replaces the old "double-click start-worker.bat, leave a console
; window open forever, no auto-restart" pattern entirely: this installer's
; whole point is that basiq-worker-tray.exe auto-launches at every login
; (Startup-folder shortcut below) and supervises the actual worker process
; with its own crash-restart watchdog -- see basiq_worker_tray.py.
;
; Build order: PyInstaller must have already produced build\dist\basiq-worker\
; (run build_worker_windows.bat, or the steps it wraps, first). Then:
;   "C:\Users\<you>\AppData\Local\Programs\Inno Setup 6\ISCC.exe" installer_worker.iss
;
; Installs per-user, no admin required -- same constraint installer.iss
; already honors, and the reason the auto-launch mechanism below is a
; per-user Startup-folder shortcut rather than a Windows Service (a service
; needs admin to install).
;
; Secrets handling: AGENT_URL/AUTH_TOKEN/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
; are the SAME shared values across every identity (see
; tools\worker_config.txt.example) -- NOT baked into this compiled installer.
; Whoever builds and distributes this (the team lead) prepares a
; worker_config.seed.txt file with those four values once and places it next
; to Basiq-Worker-Setup.exe on the shared drive; this script merges it with
; the two per-machine answers below (Media Root, Identity) into the real
; worker_config.txt at install time. Missing the seed file degrades
; gracefully (a clear on-screen message, same install completes) rather than
; silently producing a config that can't authenticate.

#define MyAppName "Basiq Worker"
#define MyAppVersion "1.0.0"
#define MyTrayExeName "basiq-worker-tray.exe"
#define MyAppPublisher "Basiq Studio Hub"

[Setup]
AppId={{9C1E7B3D-4A2F-4E6C-8B1A-2D5F7E9C3A61}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\BasiqWorker
DefaultGroupName=Basiq Worker
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=installer_output
OutputBaseFilename=Basiq-Worker-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "dist\basiq-worker\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Basiq Worker"; Filename: "{app}\{#MyTrayExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall Basiq Worker"; Filename: "{uninstallexe}"
; The actual "always on, comes back after a reboot" behavior -- no Desktop
; icon by design, since there's nothing to double-click day to day.
Name: "{userstartup}\Basiq Worker"; Filename: "{app}\{#MyTrayExeName}"; WorkingDir: "{app}"

[Run]
; skipifsilent on all three: a scripted/silent verification install (see
; tools/build/README.md's install-uninstall test recipe) must never trigger
; a real browser download, a real login prompt, or a real running worker --
; those three are exactly the side effects this flag exists to suppress.
Filename: "{app}\basiq-youtube-login.exe"; Parameters: "--install-browser"; Flags: postinstall skipifsilent runasoriginaluser; Description: "Download the real Chrome browser Playwright needs (one-time, needs internet)"
Filename: "{app}\basiq-youtube-login.exe"; Parameters: "--login ""{app}\cookies.txt"""; Flags: postinstall skipifsilent runasoriginaluser; Description: "Log into the YouTube account for this identity now"
Filename: "{app}\{#MyTrayExeName}"; Flags: nowait postinstall skipifsilent runasoriginaluser; Description: "Start Basiq Worker now"

[Code]
var
  MediaRootPage: TInputQueryWizardPage;
  IdentityPage: TInputQueryWizardPage;

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
    'This is the LucidLink (or other shared/mounted) folder your team uses -- ' +
    'ask your team lead if you''re not sure, everyone must point at the exact ' +
    'same folder for the shared library to work.');
  MediaRootPage.Add('Folder path:', False);
  MediaRootPage.Values[0] := SuggestedMediaRoot;

  IdentityPage := CreateInputQueryPage(MediaRootPage.ID,
    'Identity Label',
    'What should this worker be called?',
    'Shows up in logs and job claims so your team lead can tell identities ' +
    'apart once there''s more than one. The suggested value (this computer''s ' +
    'name) is fine to keep.');
  IdentityPage.Add('Identity label:', False);
  IdentityPage.Values[0] := ExpandConstant('{computername}');
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Existing: String;
begin
  if (MediaRootPage <> nil) and (CurPageID = MediaRootPage.ID) then
  begin
    Existing := GetExistingMediaRoot();
    if Existing <> '' then
      MediaRootPage.Values[0] := Existing;
  end;
end;

// worker_config.seed.txt carries the four values shared by every identity
// (AGENT_URL/AUTH_TOKEN/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) -- prepared
// once by whoever distributes this installer, placed next to the .exe on
// the shared drive, never baked into the compiled installer itself.
function SeedConfigPath(): String;
begin
  Result := ExtractFileDir(ExpandConstant('{srcexe}')) + '\worker_config.seed.txt';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  MediaRoot, Identity, SeedPath, Config: String;
  SeedLines: TArrayOfString;
  I: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;

  MediaRoot := Trim(MediaRootPage.Values[0]);
  if MediaRoot = '' then
    MediaRoot := SuggestedMediaRoot;
  SaveStringToFile(ExpandConstant('{app}\media_root.txt'), MediaRoot, False);

  Identity := Trim(IdentityPage.Values[0]);
  if Identity = '' then
    Identity := ExpandConstant('{computername}');

  Config := '';
  SeedPath := SeedConfigPath();
  if FileExists(SeedPath) and LoadStringsFromFile(SeedPath, SeedLines) then
  begin
    for I := 0 to GetArrayLength(SeedLines) - 1 do
      Config := Config + SeedLines[I] + #13#10;
  end
  else if not WizardSilent() then
  begin
    // A silent/scripted install (see tools/build/README.md's verification
    // recipe) must never block on a MsgBox waiting for a click that will
    // never come -- WizardSilent() is Inno Setup's own documented way to
    // detect that case.
    MsgBox(
      'worker_config.seed.txt wasn''t found next to this installer.' + #13#10 + #13#10 +
      'AGENT_URL / AUTH_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY still ' +
      'need to be added to:' + #13#10 + ExpandConstant('{app}\worker_config.txt') + #13#10#13#10 +
      'The install finishes either way -- this worker just won''t ' +
      'be able to claim real jobs until those are filled in.',
      mbInformation, MB_OK
    );
  end;

  Config := Config +
    'MEDIA_ROOT=' + MediaRoot + #13#10 +
    'WORKER_ID=' + Identity + #13#10 +
    'COOKIES_FILE=' + ExpandConstant('{app}\cookies.txt') + #13#10;

  SaveStringToFile(ExpandConstant('{app}\worker_config.txt'), Config, False);
end;
