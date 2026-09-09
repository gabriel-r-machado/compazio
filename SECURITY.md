# Security Policy

Security issues are treated separately from ordinary bugs because Compazio executes local processes, manages project files, exposes typed IPC between Electron processes and can grant scoped capabilities to local agent sessions.

## Supported versions

Security fixes are prioritized for the latest published beta/release line. Older betas may receive a fix only when the same issue materially affects current users.

| Version | Supported |
| --- | --- |
| Latest beta/release | Yes |
| Older beta/release lines | Best effort |
| Unreleased historical branches | No |

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a suspected vulnerability.

Preferred reporting path once the repository is public:

1. Open the repository's **Security** tab.
2. Use **Report a vulnerability** / private vulnerability reporting when available.

If private vulnerability reporting is unavailable, contact `support@compazio.dev` with `[SECURITY]` in the subject. Include only the minimum information needed to reproduce the issue. Do not send real user secrets or unrelated private data.

Helpful reports include:

- affected version/commit;
- operating system;
- impact and attack preconditions;
- minimal reproduction steps;
- relevant logs with credentials, tokens, personal paths and workspace data redacted;
- a proposed fix, if you already have one.

## Security-sensitive areas

Changes in these areas deserve extra review:

- Electron `main`, preload and IPC boundaries;
- process spawning, PTY lifecycle and command argument handling;
- filesystem/path validation and workspace isolation;
- Portal/WebContents isolation and navigation controls;
- MCP/local gateway authentication and capabilities;
- entitlement/signature verification;
- update/release verification;
- credential, token, diagnostics and log redaction;
- Supabase RLS and server-side billing/licensing code.

## Disclosure

Please give maintainers a reasonable opportunity to investigate and ship a fix before public disclosure. After a fix is available, the project may publish a GitHub Security Advisory with affected versions, impact and remediation guidance.

## Secrets

Never commit production credentials, private signing keys, service-role keys, release tokens, user workspaces, exported diagnostics containing private data or certificate private material. Examples and fixtures must use unmistakably synthetic values.