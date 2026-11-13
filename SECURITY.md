# Security policy

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/jacobcorbett/myaberdeen-cli/security/advisories/new). If the form is unavailable, email **dev@jacobcorbett.com** with the subject “MyAberdeen CLI security report”. Do not open a public issue with a vulnerability, exposed credential or working exploit.

Include the CLI version, operating system, affected command, expected behaviour, impact and a minimal reproduction using synthetic data. Redact usernames, home paths, course information, authentication URLs, cookies and tokens. Do not attach browser profiles, database archives, real course files or raw network captures. If additional sensitive evidence is needed, agree a safe transfer method first.

If a university session or credential is exposed, revoke it through the relevant provider and contact university IT; deleting a local profile alone does not revoke a copied session.

## Supported versions and expectations

Security fixes target the latest release and the current `main` branch. Update older versions before reproducing a problem where possible. This is a volunteer-maintained, unofficial tool; no response-time guarantee is offered.

The current source requires Node 26.13.1 or newer within Node 26. Portable builds pin exactly Node 26.13.1; Node 22 and 24 are no longer supported. Run `npm run audit:security` to check production dependency advisories and official Node security/support data. Keep Google Chrome updated separately. These checks cover known published issues, not undisclosed vulnerabilities.

The published 0.3.2 macOS bundles contain older Node runtimes (arm64: 24.20.0; x64: 24.19.0), below the October 2026 security fixes. Upgrade to 0.3.3 or use the updated source with Node 26.13.1. Existing release assets are not replaced in place.

The CLI accesses Blackboard and Panopto read-only but stores sensitive course data and login sessions locally. The dedicated Chrome profile uses reduced OS keychain integration, and login makes session-only cookies persistent for up to seven days on disk, subject to provider expiry and revocation. Use a private local account, protect backups and never share the profile. See the README's authentication and local-data guidance.
