# Security Policy

ForgeOS Browser is a laboratory prototype. It has not been audited by
independent security engineers; see [SECURITY_MODEL.md](SECURITY_MODEL.md) and
[THREAT_MODEL.md](THREAT_MODEL.md) for what it does and does not protect.

## Supported versions

Only the latest release receives security fixes. There are no backports.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.

This uses GitHub's private vulnerability reporting, so the report is visible
only to the maintainer until a fix is published.

Include, where you can:

- the version (toolbar or Settings) and operating system;
- what an attacker can do, and from which position: a web page, an agent, a
  local process, or a network position;
- steps or a proof of concept.

## What to expect

This is a single-maintainer project, so these are intentions rather than
guarantees:

- acknowledgement within 7 days;
- an assessment, and a fix plan for confirmed issues, within 30 days;
- credit in the changelog unless you prefer otherwise.

## In scope

- A web page reaching Node, Electron, the `window.forge` bridge, the
  filesystem, or another tab.
- An agent acting without the human approval the model requires, or reading
  redacted credentials or another tab's content.
- A page or agent reaching loopback, private, or link-local addresses through
  the agent session.
- Bypass of the permission, download, or credential policies.
- Leaks of the Agent API token or the inference key.
- Tampering with a published release archive.

## Out of scope

- Vulnerabilities in Chromium or Electron themselves; report those upstream.
  Reports that ForgeOS ships an outdated Electron are welcome.
- Fingerprinting through engine-exposed entropy, which is documented as
  unmitigated.
- Evasion of the prompt-injection scanner, which is advisory by design.
- Attacks that require malware already running as the same user.

## How the project stays current

- Dependabot checks Electron and the build dependencies every day.
- A nightly workflow fails when Electron is behind its release line, when the
  pinned major is unsupported, or when a high-severity advisory is published.
- Every GitHub Action is pinned to a full commit SHA.
