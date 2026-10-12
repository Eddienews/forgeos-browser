# Handoff: verify, sign and notarize ForgeOS Browser on macOS

Written on 2026-10-12 by a Claude Code session on the maintainer's Linux
machine, for a Claude Code session on the maintainer's Mac. That session had no
Mac, so everything macOS-specific below is unverified until you run it.

Delete this file in the pull request that completes the work.

## Working with the maintainer

- Eddie writes in Portuguese (often with stray characters from a US keyboard
  layout). Reply in Portuguese.
- He wants the work done rather than described, and says "continue" a lot.
  Proceed on anything that is safe; stop for anything that publishes, costs
  money, or bypasses a guardrail.
- `main` requires one approving review and he is the only maintainer. He merges
  with the admin override. A Claude session is blocked from doing that, so ask
  him to type it himself: `! gh pr merge <N> --merge --admin --delete-branch`.
  Draft pull requests need `! gh pr ready <N>` first.
- Never ask him to paste a certificate, password or API key into the chat.
  Credentials go into the macOS keychain or GitHub secrets, entered by him.

## State of the repository

- `main` is 0.16.0, not yet tagged. A `v*` tag triggers the Build workflow,
  which publishes portable ZIPs for five targets as a GitHub Release.
- Two pull requests may still be open; check with `gh pr list`:
  - #21 per-site permission controls (`feat/site-permissions`)
  - #22 Dependabot, nightly check, `SECURITY.md` (`chore/maintenance-automation`)

  Both touch `CHANGELOG.md` under `[Unreleased]` and the test count in
  `README.md`, so the second to merge conflicts there. Resolve by keeping both
  changelog entries and setting the README count to what `npm test` prints.
- Electron is pinned to 43.7.9. `npm test` runs the unit suite; `npm run
  test:e2e` runs three Electron suites, one of which needs the Python `aioquic`
  module and is only expected to pass on the Windows CI job.

## What is already known

- **Linux x64 is verified by execution**: packaged build, packaged `--smoke`
  run, UI and permission E2E suites.
- **macOS has never been launched.** CI packages both macOS targets and
  verifies the archive inventory, but runs no macOS app. `macos-latest` runners
  are Apple Silicon, so the x64 bundle is cross-packaged.
- `scripts/package.js` flips Electron fuses after packaging (`RunAsNode`,
  `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off;
  `OnlyLoadAppFromAsar` on). On arm64 it then re-signs ad hoc
  (`resetAdHocDarwinSignature`), which adds `_CodeSignature/CodeResources` to
  the app and each helper. `scripts/package-policy.js` admits those members for
  arm64 only.
- Electron's official darwin-x64 binaries carry no code signature at all
  (checked: no `LC_CODE_SIGNATURE` in the app, framework or helper binaries), so
  flipping fuses breaks nothing on Intel today.
- `scripts/package-policy.js` is a deliberate release guardrail: every member
  of a portable archive must be individually approved. Widen it only as far as
  a real signed bundle requires, and say so in the pull request.

## Part A — verify the unsigned build on this Mac

Do this first; it needs no certificate.

```bash
npm ci
npm test
npm run package
open dist/ForgeBrowserLab-darwin-*/ForgeBrowserLab.app
```

Confirm, and report each result to Eddie:

1. The app opens. The toolbar shows `v0.16.0`.
2. `https://example.com` loads and the security badge reads `HTTPS`.
3. Clicking the badge opens the site panel fully inside the window. If #21 is
   merged or checked out, it has a "Permissions for this site" section.
4. `npx electron-fuses read --app <path to .app>` shows the four fuses as
   described above.
5. User data is in `~/Library/Application Support/<name>/` with mode `0600`,
   and nothing named `forge-*.json` remains in `<app>/Contents/MacOS/`. The
   directory name was not confirmed; find it with
   `ls ~/Library/Application\ Support | grep -i forge`.
6. `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/ForgeBrowserLab -e "console.log(1)"`
   starts the browser instead of printing `1`.

Eddie has an older version installed on this Mac. Older builds stored
`forge-settings.json`, `forge-history.json`, `forge-bookmarks.json` and
`forge-allowlist.json` next to the executable. Copying those into the new
app's `Contents/MacOS/` before first launch should move them once into the
user-data directory. That migration has only ever passed a unit test, so
checking it here is valuable. Back the files up first.

If #21 is in the build, also run
`npx electron tests/e2e/site-permissions.js` and
`npx electron tests/e2e/find-in-page.js`. The second one creates its scratch
directory from `BH_AGENT_WORKSPACE`; set that to a temporary directory.

## Part B — sign and notarize locally

Goal: `npm run package` on this Mac can produce a Developer ID signed,
notarized and stapled `.app` when asked to, and behaves exactly as today when
not asked.

Credentials, set up by Eddie:

- A **Developer ID Application** certificate. Xcode → Settings → Accounts →
  Manage Certificates → `+`. Only the Account Holder can create one. Confirm
  with `security find-identity -v -p codesigning`.
- A notary profile in the keychain:
  `xcrun notarytool store-credentials forgeos-notary` (he supplies an App Store
  Connect API key, or his Apple ID with an app-specific password, plus the
  Team ID).

Constraints the implementation must respect:

- **Fuses before signing.** Flipping a fuse modifies the Electron Framework
  binary and invalidates any signature made earlier. Today the flip happens
  after `@electron/packager` returns, so signing through the packager's
  `osxSign` option would be undone. Either flip fuses in a packager hook that
  runs before signing, or sign as a separate step after the flip.
- When signing with Developer ID, do not also apply
  `resetAdHocDarwinSignature`.
- Hardened runtime is required for notarization. Electron needs at least
  `com.apple.security.cs.allow-jit`; add further entitlements only when a
  concrete failure shows they are needed, and record why. The app is not
  sandboxed and must not request sandbox entitlements.
- Sign every nested binary: the framework, its libraries, the crashpad
  handler, and each helper app.
- The plugins start `yt-dlp`, `ffmpeg` and a JavaScript runtime as external
  processes. Check that a video or transcript job still starts under the
  hardened runtime, or state plainly that it was not tested.
- A signed bundle has `_CodeSignature/CodeResources` in the app and helpers on
  **both** architectures, and stapling adds a ticket file. Update
  `scripts/package-policy.js` and its tests to admit exactly what appears.
- Opt in through the environment, for example a signing identity and a notary
  profile name. With those unset, output must be unchanged so Linux and Windows
  packaging and the pull-request CI keep working.
- macOS archives are made with `ditto` in `scripts/make-portable.js`; keep it,
  it preserves the symlinks a signed bundle depends on.

Done when all of these pass on the produced app, and you have shown Eddie the
output:

```bash
codesign --verify --deep --strict --verbose=2 <app>
spctl --assess --type execute --verbose=2 <app>     # "accepted", source "Notarized Developer ID"
xcrun stapler validate <app>
```

and the Part A checklist passes again on the signed app, and `npm test` is
green. Add unit tests for whatever decides the signing configuration.

## Part C — signing in CI (after Part B works)

- The release must be signed by the workflow, not by hand, so the published
  archive is the one CI verified.
- Eddie exports the certificate as `.p12` and adds repository secrets himself.
  Agree the names with him; a reasonable set is `MACOS_CERTIFICATE_P12`,
  `MACOS_CERTIFICATE_PASSWORD`, and App Store Connect key id, issuer id and
  key.
- Import into a temporary keychain in the job and delete it afterwards. Sign
  only on tag builds: pull requests from forks must never see the secrets.
- Every action in `.github/workflows/` is pinned to a full commit SHA and a
  unit test enforces it. Pushing workflow changes needs a token with the
  `workflow` scope.
- Once macOS builds are signed, `EnableEmbeddedAsarIntegrityValidation` becomes
  meaningful and is the next fuse to enable.

## Not in scope here

- Mac App Store distribution: the sandbox and the media-download plugin make it
  a different, reduced product.
- iOS: it would be a separate WebKit-based app.
- Windows signing and in-app automatic updates: later, and updates depend on
  signed builds.
- Tagging `v0.16.0`: Eddie decides when, after Part A passes.
