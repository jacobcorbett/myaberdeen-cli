# Security policy

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/jacobcorbett/myaberdeen-cli/security/advisories/new). If the form is unavailable, email **dev@jacobcorbett.com** with the subject “MyAberdeen CLI security report”. Do not open a public issue with a vulnerability, exposed credential or working exploit.

Include the CLI version, operating system, affected command, expected behaviour, impact and a minimal reproduction using synthetic data. Redact usernames, home paths, course information, authentication URLs, cookies and tokens. Do not attach browser profiles, database archives, real course files or raw network captures. If additional sensitive evidence is needed, agree a safe transfer method first.

If a university session or credential is exposed, revoke it through the relevant provider and contact university IT; deleting a local profile alone does not revoke a copied session.

## Supported versions and expectations

Security fixes target the latest release and the current `main` branch. Update older versions before reproducing a problem where possible. This is a volunteer-maintained, unofficial tool; no response-time guarantee is offered.

The CLI accesses Blackboard and Panopto read-only but stores sensitive course data and login sessions locally. The dedicated Chrome profile uses reduced OS keychain integration, and login makes session-only cookies persistent for up to seven days on disk, subject to provider expiry and revocation. Use a private local account, protect backups and never share the profile. See the README's authentication and local-data guidance.
