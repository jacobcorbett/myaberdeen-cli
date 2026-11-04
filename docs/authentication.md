# Authentication and local data

[← Back to the README](../README.md)

Login intentionally saves your session in a dedicated Chrome profile. After successful sign-in, the CLI changes session-only cookies for all sites in that profile, including the sign-in provider, into persistent cookies with an expiry seven days later. Existing expiry dates are preserved. Provider-side expiry, revocation and MFA requirements still apply; this does not guarantee seven days of access.

Chrome runs with `--password-store=basic` and `--use-mock-keychain` to support headless reuse. Do not assume the profile's cookies have normal OS keychain protection. POSIX permissions are restricted, while Windows uses your account's inherited ACLs. Anyone who obtains a usable copy of the profile may be able to reuse your session. Use this only on a trusted personal account; never share or sync the profile, and exclude it from shared backups.

To stop local session reuse, finish all CLI operations, close the dedicated CLI Chrome window, run `myab paths` to identify `profileDir`, and delete **that dedicated profile directory only**. A fresh `myab login` is then required. This does not delete your course archive or revoke already-copied sessions; use the provider's sign-out/revocation controls for those.

Downloaded files and exports can include grades, messages and other people's information. The default `~/Documents/MyAberdeen` may be covered by iCloud, OneDrive or another backup service. Choose a suitable private location with `MYAB_DOWNLOAD_DIR` and protect your archives and backups. Review all diagnostics before sharing them.

Interactive login launches the configured Chrome executable. Defaults cover macOS, standard Google Chrome installations on Linux, and Windows; override `MYAB_CHROME` for another installation. Live SSO has been verified on macOS. CI checks deterministic code on macOS, Linux and Windows; other live platform/login combinations still need local verification.
