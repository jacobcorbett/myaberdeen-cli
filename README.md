# MyAberdeen CLI

A private, read-only terminal client for the University of Aberdeen's Blackboard Learn site. It keeps a dedicated Chrome profile for the authenticated session, uses Blackboard's own logged-in web endpoints, and stores course metadata in SQLite. Day-to-day commands run headlessly.

## First login

```sh
myab login
```

Chrome opens using a dedicated profile. Complete the normal Aberdeen sign-in and multi-factor authentication. Once the Courses page loads, the command verifies the session, closes Chrome, and retains the session locally.

If Microsoft offers **Stay signed in?**, choose **Yes**. Normal commands first check the Blackboard session; if it has expired, they follow Blackboard's **Sign In** entry once to reuse the remembered university login. This happens headlessly and can restore access without another password or MFA prompt. If Microsoft requires interaction, run `myab login`.

The profile is not your everyday Chrome profile. No passwords, cookies, or security tokens are copied into this repository or into the archive database.

## Commands

```sh
myab status
myab courses
myab sync
myab sync --course CS3524
myab sync --download-files
myab download --course CS3524
myab download --course CS3524 --limit-files 1
myab export
myab merge-vault
myab paths
```

- `courses` lists courses from the live account.
- `sync` archives courses, nested content, announcements, grades, and schedules in SQLite.
- `download` performs a sync and downloads Blackboard-hosted course files and attachments embedded in Ultra documents.
- `export` writes private, per-course JSON for content, announcements, grades, schedules, messages, discussions, and files.
- `merge-vault` indexes the existing Obsidian university files, links exact duplicates to their curated copy, removes only hash-identical raw duplicates, and generates per-course MyAberdeen notes.
- `--course` accepts a Blackboard course ID, course code, or a case-insensitive fragment.
- `--limit-courses N` is useful for a small verification run.
- `--limit-files N` caps attempted file downloads (including failures) while still archiving all selected course metadata.
- `--headed` shows the browser for diagnosing a session problem.

Panopto, Turnitin, and other external-tool links are recorded in the content archive but are not bulk-downloaded. Videos are not downloaded by default.

## Local paths

Defaults:

- State: `~/.local/share/myaberdeen-cli`
- Browser profile: `~/.local/share/myaberdeen-cli/chrome-profile`
- Database: `~/.local/share/myaberdeen-cli/myaberdeen.sqlite`
- Downloads: `~/Documents/MyAberdeen`

Override them with `MYAB_STATE_DIR`, `MYAB_PROFILE_DIR`, `MYAB_DATABASE`, `MYAB_DOWNLOAD_DIR`, or `MYAB_CHROME`.
Override the Obsidian vault used by `merge-vault` with `MYAB_VAULT`.

All course-data operations are GET requests. Authentication uses the site's normal browser sign-in flow. If automatic sign-in cannot restore access, run `myab login` again.

## Installation and development

Requires Node.js 22.5 or newer and an installed Google Chrome. Interactive login uses macOS's `open` command.

```sh
npm ci
npm link
npm run check
```

Source code belongs in the private GitHub repository; course exports, the SQLite archive,
and the authenticated Chrome profile stay on this computer. Do not upload runtime data.

## Reliability and limits

- Embedded attachments use stable IDs and share the ordinary file archive and export pipeline.
- Existing files are checked by SHA-256. Changed versions get a hash suffix; earlier versions are preserved.
- Failed downloads preserve previous valid database records.
- API requests stay on the Blackboard origin. File downloads may follow HTTPS redirects to Blackboard subdomains using a separate HTTP client without Blackboard session cookies or security headers. Other destinations are rejected.
- Exit codes: `0` success, `1` command/fatal error, `2` initial authentication required, `3` partial sync. Partial results are still exported; inspect `myab status` and the sync log.
- Only one command may use the dedicated Chrome profile at a time. Close that profile's window before running a headless command. The CLI never deletes profile locks.
- Login waits for Chrome to release the profile before checking the retained session. Expired Blackboard sessions can recover through remembered university SSO. Password, MFA, account-choice and consent prompts require `myab login`; local cookie retention does not extend server access. The CLI does not keep a background session alive or change university expiry policies.
- Blackboard's internal web endpoints can change. Grades and schedule APIs do not guarantee every ungraded assessment or personal timetable entry is present.
