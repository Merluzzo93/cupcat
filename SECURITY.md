# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's **Report a vulnerability** button under the repository's
**Security** tab (Security advisories), or contact the maintainer directly. Include:

- what the issue is and where it lives (component + file/line if you have it),
- steps to reproduce or a proof of concept,
- the impact you think it has.

You'll get an acknowledgement, and we'll work with you on a fix and coordinated disclosure.

## Scope & good to know

CupCat is **local-first**: the editor, the bridge, and the AI toolbox run on your own machine, and
your media never leaves it.

- The bridge listens on **`127.0.0.1:19789`** (loopback only). Reports about its MCP/WebSocket
  surface, path handling, or command execution are in scope.
- **Generative AI** runs through your own Higgsfield account via its CLI; account/credential
  handling is delegated to that tool.
- The desktop app bundles third-party engines (ffmpeg, Whisper, Piper, sherpa-onnx). Vulnerabilities
  in those belong upstream, but tell us if CupCat uses one unsafely.

## Supported versions

Fixes land on the latest release line. Please test against the newest
[release](../../releases/latest) before reporting.
