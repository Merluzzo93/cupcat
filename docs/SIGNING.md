# Getting CupCat signed

Windows users meet CupCat through a SmartScreen warning. Signing is what fixes that, and for a solo
developer the only free route is **SignPath Foundation**, which gives open-source projects a
certificate and signs through SignPath.io at no cost.

Everything that can be done in code is done. What remains needs an account and an identity, which is
yours, not the repository's. This file is the handover.

## Why the build moved to GitHub Actions

SignPath will not sign a file you built on your laptop. Its trusted-build-system integration reads the
workflow run that produced the artifact, and a locally built installer cannot be submitted at all.
That is the whole reason `.github/workflows/release.yml` exists, and the reason
`tools/sidecars/fetch.ts` exists behind it — 1.3 GB of bundled engines that only one machine knew how
to assemble could not be assembled by a runner.

Proven, not assumed: a run on `windows-latest` reproduces all 403 provisioned files byte for byte
against `tools/sidecars/sidecars.lock.json`, in about 45 seconds.

## What you need to do

### 1. Apply to SignPath Foundation

<https://signpath.org/apply> — the conditions are at <https://signpath.org/terms.html>.

CupCat already satisfies the technical ones: OSI-approved licence with no dual licensing (GPL-3.0),
public repository, active, released, functionality documented on the site, an uninstaller registered
with Windows, no telemetry, no hacking tools.

Three things you must supply or check:

- **Your legal name**, as the Author / Reviewer / Approver. `cupcat-site/signing.html` has
  `[full name]` / `[nome e cognome]` placeholders — search for `data-fill="maintainer"`.
- **Multi-factor authentication** on both your GitHub account and your SignPath account. This is a
  stated condition, not a suggestion.
- **The bundled Higgsfield CLI.** Read the next section before applying.

### 2. The one thing that might not pass

SignPath Foundation requires that the project contain **no proprietary, non-open-source component**,
with system libraries as the only exception. Every bundled engine is fine — ffmpeg (GPL), whisper.cpp
and its models (MIT), Piper (MIT), sherpa-onnx (Apache-2.0), YuNet (MIT), the models (MIT/Apache-2.0),
yt-dlp (Unlicense) — except one.

`higgsfield.exe` comes from `github.com/higgsfield-ai/cli`, which carries an MIT LICENSE file but
publishes **no source code**: the repository holds a README, a licence, notices, and release binaries.
So it is a closed-source binary with an open licence attached, and it cannot be shown to be built from
source in a verifiable way.

Declare it in the application rather than hoping nobody looks. Two honest positions to offer:

1. It is redistributed unmodified, upstream and unsigned, which their conditions do explicitly allow
   for third-party binaries inside a signed package ("upstream unsigned binaries may be included").
2. If they say no, CupCat can fetch it on first run instead of bundling it — media generation is
   already optional and already needs a Higgsfield login. That is a small change to the first-run
   setup, and it would make the signed installer contain nothing but open source.

Do not decide this silently in either direction; it is the difference between a signed installer and a
rejected application.

### 3. Configure the SignPath project

In SignPath, once accepted:

- Create a project, note its **slug**.
- Create a signing policy named **`release-signing`** — the workflow refers to it by that slug.
- Create an artifact configuration for an NSIS installer. **Sign the executables inside it as well as
  the installer itself**, otherwise the installed `cupcat.exe` and `cupcat-bridge.exe` stay unsigned
  and Smart App Control still objects to them.
- Set the file metadata restrictions their conditions require: product name `CupCat`, product version
  matching the build.
- Add the GitHub Actions trusted build system for `Merluzzo93/cupcat`.

### 4. Put the four values in GitHub

Repository → Settings → Secrets and variables → Actions.

| Where | Name | Value |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | The SignPath API token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | Your SignPath organization ID |
| Variable | `SIGNPATH_PROJECT_SLUG` | The project slug |
| Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | The artifact configuration slug |

The signing step is gated on `SIGNPATH_ORGANIZATION_ID` being set, so until then the workflow keeps
producing a usable unsigned installer and logs a warning saying so. Nothing breaks while you wait.

### 5. Turn the claim on

Only after the first signed installer exists:

- `cupcat-site/signing.html` — delete the "not signed yet" paragraphs and uncomment the attribution
  block below them. SignPath's conditions require that exact wording.
- `cupcat-site/index.html` — add the same attribution line near the download button.
- Then deploy the site.

Claiming a signature before there is one would be worse than the warning it is meant to remove.

## What the workflow does, in order

The order is not cosmetic. Signing rewrites `cupcat.exe`, `cupcat-bridge.exe` and the installer, and
the delta updater's manifest is a list of SHA-256s of exactly those bytes. A manifest generated before
signing describes files that no signed installation contains — the failure mode that has already cost
this project five bad releases.

```
provision engines → verify against the lock
build web, engine, face detector → typecheck → 761 tests
tauri build → installer
upload as a workflow artifact
SignPath: submit → WAIT FOR YOUR MANUAL APPROVAL → signed installer comes back
manifest, from the SIGNED installer
check the manifest against that same installer, file by file
upload installer + manifest + delta files
```

Nothing is published to a release. `gh release create` stays a human act, which is also what SignPath
requires: every release is approved by hand, one signing request at a time.

## What signing does and does not buy

Worth knowing before you measure it against expectations, because the answer changed recently.

- SmartScreen reputation attaches to a file hash **and** to the signing certificate. A new certificate
  starts with no reputation, so the first releases can still warn. It accumulates with downloads.
- EV certificates no longer bypass SmartScreen. Paying more would not skip the wait.
- Smart App Control on Windows 11 blocks unsigned executables outright. This is the part signing fixes
  immediately and completely.
- The warning users see today — "Windows protected your PC", unknown publisher — becomes a normal
  install prompt naming CupCat.
