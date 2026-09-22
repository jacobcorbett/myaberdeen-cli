# MyAberdeen CLI agent guidance

## Purpose

This is Jacob's local, terminal-native MyAberdeen archive client. It uses a dedicated persistent Chrome profile so normal operations can run headlessly after an interactive university login.

## Safety and scope

- Treat Blackboard as read-only. Do not add write, submit, delete, enrolment, messaging, or assessment-attempt operations.
- Never print, log, commit, or persist cookies, SSO credentials, XSRF tokens, or request headers containing secrets.
- Keep the browser profile and database outside the repository, in the user's local application-data directory with private permissions.
- Be conservative with request concurrency and retries. This is a personal archive utility, not a crawler.
- External LTI services such as Panopto and Turnitin are separate systems. Record their links; do not attempt to bypass their authentication or protections.

## Workflow

- Keep the CLI usable without a visible browser except for initial or expired login.
- Use the installed Google Chrome through `playwright-core`; do not download a second browser unless explicitly requested.
- Use Node's built-in SQLite support for the durable archive.
- Add tests for parsing, path safety, pagination, and database changes.
- Use UK spelling in user-facing text and documentation.
- Do not commit or push unless Jacob explicitly asks.


## Git conventions

- Keep commits focused and reversible, using concise conventional commit subjects.
- Run `npm run check` before publishing. Keep the GitHub repository private.
- Inspect staged files for runtime data and secrets before each commit.

## Archive-first workflow

- Start ordinary course questions with `myab brief --active --json`, then `show` or the returned local sources. Check section freshness before presenting cached facts as current.
- Use `myab check --active` for metadata, or `myab refresh --active` for metadata and conditional file checks. An explicit live request takes priority over the cache.
- Configure `profiles.current` locally. Do not select every membership for a routine refresh; broad archive operations require explicit `--all`.
- Preserve full archived details on incomplete refresh. Mark absence only after a successful complete section traversal.
- Keep caller-specific change cursors. Text caches are keyed by file SHA-256 and extractor version.
- Preview vault merge and relocation changes. Relocation must verify destination hashes and must never delete source files.
- Test schema migration/backup, scope isolation, partial failures, conditional requests, and unchanged repeat runs. No university credentials or real course datasets belong in tests or CI.
