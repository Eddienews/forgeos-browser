# Handoff: verify ForgeOS Browser v0.18.1 on macOS Intel and Windows

Written on 2026-10-12 and updated for v0.18.1 on 2026-10-13 by a Claude Code session on the maintainer's Linux
machine, for whoever sits at the Mac or the Windows machine next: Eddie, or a
Claude Code session there. That session had neither machine, so every macOS and
Windows command below is unverified until it is run.

Delete this file in the pull request that records the results.

## Scope

- **In scope now:** the Intel MacBook (`darwin-x64`) and Windows (`win32-x64`).
- **Later:** the Apple Silicon Mac (`darwin-arm64`), once it is set up. The
  same checklist applies with the arm64 archive.
- Linux x64 is already verified by execution on the maintainer's machine.

v0.18.1 is published. The thing under test is the **published archive**, because
that is what a user downloads. Building from source (last section) is a second,
smaller check.

What has never been done:

- No macOS build has ever been launched. CI packages and inventories both macOS
  archives but runs no macOS app, and the x64 bundle is cross-packaged on an
  Apple Silicon runner.
- The Windows CI job runs the unit and E2E suites, but nobody has opened the
  packaged Windows app by hand.

## Working with the maintainer

- Eddie writes in Portuguese. Reply in Portuguese.
- Proceed on anything safe; stop for anything that publishes, costs money, or
  bypasses a guardrail.
- Record every result, including "not tested". A skipped check is written down
  as skipped, not left blank.

## 1. Download and check the archive

macOS (Intel):

```bash
mkdir -p ~/forge-verify && cd ~/forge-verify
gh release download v0.18.1 -R Eddienews/forgeos-browser \
  -p 'ForgeBrowserLab-portable-darwin-x64.zip' -p SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing     # expect: ...darwin-x64.zip: OK
ditto -x -k ForgeBrowserLab-portable-darwin-x64.zip .
```

Windows (PowerShell):

```powershell
mkdir $HOME\forge-verify; cd $HOME\forge-verify
gh release download v0.18.1 -R Eddienews/forgeos-browser `
  -p 'ForgeBrowserLab-portable-win32-x64.zip' -p SHA256SUMS
(Get-FileHash ForgeBrowserLab-portable-win32-x64.zip -Algorithm SHA256).Hash.ToLower()
Select-String win32-x64 SHA256SUMS               # the two hashes must match
Expand-Archive ForgeBrowserLab-portable-win32-x64.zip -DestinationPath .
```

Expected hashes for v0.18.1:

| Archive | SHA-256 |
| --- | --- |
| `ForgeBrowserLab-portable-darwin-x64.zip` | `9735dcfe45613ab50242274eaf6575d4ca23fb70dcf8ba7ebae5921888ad37ad` |
| `ForgeBrowserLab-portable-win32-x64.zip` | `c4c7c60e62be7438f624459b26d569d8bf02dfe7c1514d07dae3db4996e38ba3` |

Note the exact path the archive unpacks to; the commands below call it `<app>`
(macOS, the `.app` bundle) or `<dir>` (Windows, the folder holding
`ForgeBrowserLab.exe`).

## 2. First launch as a user would see it

The builds are unsigned, so the operating system objects on first launch. A
file fetched with `gh` or `curl` is not marked as downloaded, so this step
needs a second copy **downloaded with a web browser** from the release page.

- **macOS:** double-click the app from the browser-downloaded copy and record
  the exact dialog. `README.md` says "right-click → Open → Open". On macOS 15
  and later that shortcut was removed and the path is System Settings → Privacy
  & Security → Open Anyway. Record the macOS version (`sw_vers`) and which path
  actually works, so the README can be corrected if needed.
- **Windows:** record whether SmartScreen shows "Windows protected your PC" and
  whether More info → Run anyway starts the app. Record whether Defender or any
  other antivirus flags the archive or the executable.

## 3. Automated smoke run

`--smoke` opens `https://example.com` in the real app, checks that it loaded
over HTTPS and that the page cannot reach Node, Electron or the chrome bridge,
then exits with code 0 on pass. It needs network access.

macOS:

```bash
export FORGE_SMOKE_RUNTIME_BASE="$(mktemp -d)"
"<app>/Contents/MacOS/ForgeBrowserLab" --smoke; echo "exit=$?"
cat "$FORGE_SMOKE_RUNTIME_BASE/results/smoke-report.json"
```

Windows (a GUI executable does not print to the console, so read the report
file and the exit code):

```powershell
$env:FORGE_SMOKE_RUNTIME_BASE = Join-Path $env:TEMP "forge-smoke"
$p = Start-Process "<dir>\ForgeBrowserLab.exe" -ArgumentList "--smoke" -Wait -PassThru
$p.ExitCode
Get-Content "$env:FORGE_SMOKE_RUNTIME_BASE\results\smoke-report.json"
```

Pass means: exit code `0`, `security.label` is `HTTPS`, `navigation` is `OK`,
`pageBoundary.safe` is `true`, and `code` is `0`.

## 4. Manual checklist

Run on each machine. On macOS, also note for each shortcut whether it responds
to Ctrl, to Cmd, or to both: the changelog documents them as Ctrl only.

| # | Check | Expected |
| --- | --- | --- |
| 1 | App opens; toolbar version | `v0.18.1` |
| 2 | Load `https://example.com` | Page renders; security badge reads `HTTPS` |
| 3 | Click the security badge | Site panel opens fully inside the window and has a "Permissions for this site" section |
| 4 | Open a site that asks for camera or location | A prompt appears; before allowing, the site sees `denied` |
| 5 | Load an `http://` address, e.g. `http://neverssl.com` | Retried over HTTPS, then asks once before continuing over HTTP |
| 6 | Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+R, Ctrl+Tab, Ctrl+1–9, Ctrl+=/−/0, F11, F12 | Each works from a page and from the toolbar |
| 7 | Close a tab, then Ctrl+Shift+T | The tab comes back |
| 8 | Click a `target="_blank"` link | Opens as a new ForgeOS tab |
| 9 | Ctrl+P, and Save page as PDF from the menu | Print dialog opens; the PDF is written and opens |
| 10 | Start the app a second time while it is running | No second window; the running browser gets focus (or a new tab if a URL was passed) |
| 11 | Find where settings and history were written | Per-user data directory, not the application folder (see below) |
| 12 | Create an empty `.portable` file next to the executable, restart | Data is now written next to the executable |
| 13 | `ELECTRON_RUN_AS_NODE=1` with `-e "console.log(1)"` | Starts the browser instead of printing `1` |
| 14 | `npx electron-fuses read --app <app or exe>` (from a checkout after `npm ci`) | `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off; `OnlyLoadAppFromAsar` on |
| 15 | Narrow the window as far as it goes | Tabs and address bar shrink; the buttons on the right stay inside the window |
| 16 | Open a new blank tab and click ✎ | The notice "Open a video page first." appears inside the toolbar, over the address bar |
| 17 | Click anywhere on the ⚙ button, including its centre | The settings menu opens |
| 18 | Window buttons | Native minimize, maximize and close work; the toolbar draws none of its own (those are Linux only) |

Notes on individual checks:

- **11.** Linux uses `~/.config/ForgeOS Browser`. The expected equivalents are
  `~/Library/Application Support/ForgeOS Browser` and
  `%APPDATA%\ForgeOS Browser`, but neither name has been confirmed; find it
  with `ls ~/Library/Application\ Support | grep -i forge` or
  `dir $env:APPDATA | findstr /i forge`. On macOS the files should have mode
  `0600`.
- **12.** On macOS "next to the executable" is inside the bundle
  (`<app>/Contents/MacOS/`). Record whether that works at all there; it may not
  be a sensible mode on macOS.
- **13.** macOS: `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/ForgeBrowserLab" -e "console.log(1)"`.
  Windows: `$env:ELECTRON_RUN_AS_NODE=1; & "<dir>\ForgeBrowserLab.exe" -e "console.log(1)"`,
  then `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- **Update notice.** v0.18.1 is the latest release, so no notice is expected.
  Only confirm that the Settings toggle exists.

### Upgrade from the older version on the Intel Mac

Eddie has an older version installed on this Mac. Older builds stored
`forge-settings.json`, `forge-history.json`, `forge-bookmarks.json` and
`forge-allowlist.json` next to the executable. Copying those into the new
app's `Contents/MacOS/` before its first launch should move them once into the
per-user data directory. That migration has only ever passed a unit test.

1. Back the four files up somewhere outside both apps.
2. Remove any existing per-user data directory from step 11, or the migration
   has nothing to do.
3. Copy the files into the new `<app>/Contents/MacOS/` and launch.
4. Confirm bookmarks and history appear, the files are now in the per-user
   directory, and nothing named `forge-*.json` remains in `Contents/MacOS/`.

## 5. YouTube plugin round-trip

`TODO.md` keeps the plugin item open until a packaged-app round-trip is
recorded on Windows. A macOS round-trip was recorded on 2026-09-01; repeat it
on the Intel Mac only if time allows, and say which Mac it ran on.

Install the tools first (the app detects them, it never installs them), then
restart the app:

```powershell
winget install yt-dlp.yt-dlp Gyan.FFmpeg     # plus Node 22+ or Deno 2.3+
```

```bash
brew install yt-dlp ffmpeg                   # macOS
```

Using a short public video that you are allowed to save:

While a job runs, a progress pill with a Cancel button must be visible in the
toolbar. Since 0.18.1 a caption language that YouTube refuses with "429 Too
Many Requests" is skipped and named in a note; the other languages are still
saved. Which languages are refused varies between attempts.

1. Video: the approval dialog appears **before** anything runs; progress is
   shown; the result is a playable H.264/AAC `.mp4` in the downloads directory.
2. Transcript: produces a readable `.txt` and a timestamped `.vtt`.
3. Cancel a running job: it stops and reports the cancellation.
4. Temporarily rename `yt-dlp` out of the way: the app reports the missing tool
   clearly instead of failing silently.

When all four pass on Windows, tick "Windows x64 packaged-app round-trip" in
`TODO.md` with the date.

## 6. From source (secondary)

```bash
git clone https://github.com/Eddienews/forgeos-browser && cd forgeos-browser
npm ci
npm test
npm run package
```

`npm run test:e2e` runs the Electron suites. One of them starts a loopback QUIC
server that needs the Python `aioquic` module, and has only been expected to
pass on the Windows CI job; report its result separately instead of treating
the whole run as failed.

## Reporting

Fill in one column per machine and hand the table back to Eddie.

| Step | macOS Intel | Windows x64 |
| --- | --- | --- |
| OS version | | |
| 1. Checksum matches | | |
| 2. First-launch dialog and the path that worked | | |
| 3. Smoke exit code | | |
| 4. Manual checklist 1–18 (list the numbers that failed) | | |
| 4. Upgrade migration | | n/a |
| 5. Video download | | |
| 5. Transcript | | |
| 6. `npm test` | | |

A failure that is a product defect goes into `TODO.md` with acceptance checks,
in the style already used there. A wrong instruction in `README.md` (for
example the first-launch path on macOS) is fixed in the same pull request that
records these results.

Signing and notarization are a separate piece of work, described in
`docs/handoff/macos-signing.md`. Do not start it until this checklist has
passed on the unsigned build.
