# MyAberdeen CLI

An unofficial, read-only terminal client for the University of Aberdeen's Blackboard Learn site. It reuses a dedicated Chrome profile after interactive sign-in, archives course data in SQLite, and keeps ordinary Blackboard files locally. Normal lookups can use the archive without opening Chrome.

This project is not affiliated with or endorsed by the University of Aberdeen, Anthology/Blackboard or Panopto. Use only your own authorised access, follow your institution's IT rules, and respect course-content and recording permissions. The MIT licence covers this software, not university materials downloaded with it.

## Start here

Version **0.3.2** improves archive freshness, Panopto discovery, relocation and first-time setup.

1. Download and extract the package for your computer from [Releases](https://github.com/jacobcorbett/myaberdeen-cli/releases/latest), or install from source below. Google Chrome is required.
2. Run `myab login` and complete your own university sign-in/MFA.
3. Run `myab setup`, select your current courses by number, and leave the optional vault path blank if you do not use Obsidian.
4. Run `myab check --active` for your first metadata archive. Use `myab refresh --active` when you also want course files downloaded.
5. Run `myab brief --active` to read the archive, or `myab doctor` for setup checks and suggested fixes.

Here `myab` means your installed command. From a portable download folder, use `./myab` on macOS/Linux or `.\myab.cmd` on Windows instead. Setup saves only your course selection and settings locally; it does not download course content. Each user signs into their own account. Do not share browser profiles or private archives.

## Download a portable release

Download the archive for your computer from [GitHub Releases](https://github.com/jacobcorbett/myaberdeen-cli/releases/latest).

| Computer | Asset suffix | Command after extracting |
| --- | --- | --- |
| Mac with Apple Silicon | `macos-arm64.tar.gz` | `./myab help` |
| Intel Mac | `macos-x64.tar.gz` | `./myab help` |
| Linux x64 | `linux-x64.tar.gz` | `./myab help` |
| Windows x64 | `windows-x64.zip` | `.\myab.cmd help` |

These are portable folders containing a launcher, the official Node runtime, and locked production dependencies. **No separate Node or npm installation is needed.** Extract the whole archive and keep `lib/` beside the launcher. Run it from a terminal; this is a CLI, not a desktop app. Add the extracted folder to `PATH` to use `myab` elsewhere. Do not move or symlink just the launcher.

Google Chrome is still required. Start with `myab login`, complete sign-in/MFA yourself, then run `myab doctor --live`. Run `myab setup` to select your courses; the example configuration and AI skill are under `lib/app/`. Optional text extractors still need to be installed separately.

Each archive has a `.sha256` checksum. On macOS use `shasum -a 256 -c ARCHIVE.sha256`; on Linux use `sha256sum -c ARCHIVE.sha256`. On Windows compare `Get-FileHash ARCHIVE.zip -Algorithm SHA256` with the supplied checksum. `BUILD.json` records the version, source commit, runtime and architecture.

Bundles are currently unsigned and not notarised, so OS security prompts may appear. Native release checks cover the platforms above; they do not verify every OS version or university login. Windows uses inherited filesystem ACLs: keep private state in your own user directory.

To update a portable installation, download and verify the new matching archive, extract it into a new folder, run its `help` and `doctor`, then point `PATH` at that folder. Keep state/configuration outside the bundle; your existing archive and login profile are reused. Refresh any copied AI skill from the new `lib/app/skills/myaberdeen-cli/` directory. A link into an older bundle must also be repointed. Do not run Git/npm update commands inside a release bundle.

## Install from source and sign in

Use Node **22.13+ on the 22 branch, or Node 24+**, and an installed Google Chrome. Node 23 is not supported. Runtime code uses `node:sqlite`; no extra browser is downloaded.

```sh
git clone https://github.com/jacobcorbett/myaberdeen-cli.git
cd myaberdeen-cli
npm ci
npm link
myab login
myab doctor --live
myab setup
```

Complete Aberdeen's normal password/MFA flow yourself. If Microsoft offers **Stay signed in?**, choose **Yes**. The CLI can reuse remembered SSO when the Blackboard session expires; it cannot override university expiry or MFA requirements. Authentication state stays inside the private Chrome profile.

### Authentication and local data

Login intentionally saves your session in a dedicated Chrome profile. After successful sign-in, the CLI changes session-only cookies for all sites in that profile, including the sign-in provider, into persistent cookies with an expiry seven days later. Existing expiry dates are preserved. Provider-side expiry, revocation and MFA requirements still apply; this does not guarantee seven days of access.

Chrome runs with `--password-store=basic` and `--use-mock-keychain` to support headless reuse. Do not assume the profile's cookies have normal OS keychain protection. POSIX permissions are restricted, while Windows uses your account's inherited ACLs. Anyone who obtains a usable copy of the profile may be able to reuse your session. Use this only on a trusted personal account; never share or sync the profile, and exclude it from shared backups.

To stop local session reuse, finish all CLI operations, close the dedicated CLI Chrome window, run `myab paths` to identify `profileDir`, and delete **that dedicated profile directory only**. A fresh `myab login` is then required. This does not delete your course archive or revoke already-copied sessions; use the provider's sign-out/revocation controls for those.

Downloaded files and exports can include grades, messages and other people's information. The default `~/Documents/MyAberdeen` may be covered by iCloud, OneDrive or another backup service. Choose a suitable private location with `MYAB_DOWNLOAD_DIR` and protect your archives and backups. Review all diagnostics before sharing them.

Interactive login launches the configured Chrome executable. Defaults cover macOS, standard Google Chrome installations on Linux, and Windows; override `MYAB_CHROME` for another installation. Live SSO has been verified on macOS. CI checks deterministic code on macOS, Linux and Windows; other live platform/login combinations still need local verification.

## AI agent skill and updates

The portable [MyAberdeen CLI skill](skills/myaberdeen-cli/SKILL.md) covers installation, authentication, archive-first queries, scoped refreshes, troubleshooting and updates from GitHub. Give an AI assistant the repository URL and ask it to read that file. It contains no account data and works without this author's personal vault or agent setup.

For an agent that supports installed skills, copy or link the whole `skills/myaberdeen-cli` directory into its configured skills directory. A link follows checkout updates; a copied skill must be refreshed after updating. Agents working in this repository are routed to it by `AGENTS.md`.

Example request:

> Read `skills/myaberdeen-cli/SKILL.md`, install this CLI, help me sign in, and configure only the courses I select. When I ask for an update, check GitHub, preserve my local state and changes, update the CLI and skill, and verify the installed revision.

There is no published npm package or built-in self-updater. The following updates a **source checkout**; portable downloads use the replacement procedure above. For source updates, first inspect `git status`, verify `origin`, run `git fetch origin`, and review incoming changes. On a clean `main` checkout that can fast-forward, run these commands in order, stopping if any fails:

```sh
git merge --ff-only origin/main
npm ci
npm run check
npm link
myab help
myab doctor
git rev-parse HEAD
```

Preserve local edits and pinned/forked installations instead of resetting them. Re-read the updated README and skill for changed requirements. State, authentication and downloads remain outside the checkout. `myab doctor` checks local health; `myab doctor --live` separately checks authentication. Neither a software update nor skill installation automatically downloads courses or creates a schedule.

## Select current courses explicitly

Run `myab setup` after login. It lists your memberships with their terms, lets you select courses by number, and saves exact course IDs to the local `profiles.current` allowlist used by `--active`. Existing custom settings and other profiles are preserved; the current selection is replaced. Blank course input cancels without saving. Trailing commas in course-number input are accepted, typos are retried, and an invalid optional vault path can be corrected without repeating course selection. Quoted pasted paths and POSIX escaped spaces are accepted. No courses are selected automatically, including old memberships.

For an AI assistant or another non-interactive caller, first use `myab courses --json`, then pass exact IDs/codes explicitly:

```sh
myab setup --course YOUR_COURSE_ID --course ANOTHER_COURSE_ID
```

`myab paths` shows the local configuration file (normally `~/.local/share/myaberdeen-cli/config.json`). Manual configuration remains supported with `config.example.json`; replace its placeholder courses. Configuration is private and should not be committed. You can persist a download location with `"downloadDir": "~/Documents/MyAberdeen"` and a nonstandard Chrome executable with `"chromePath": "/path/to/chrome"` in that file. Relative JSON paths resolve beside the configuration file rather than the current shell directory. Environment overrides take precedence and retain normal shell-relative path behaviour. Chrome discovery also checks per-user macOS/Windows installations, Windows Program Files (x86), and `/opt/google/chrome/chrome`. Both `~/` and `~\` home prefixes are accepted. `doctor` and `paths` show resolved locations; malformed configuration reports its path, and `help`/`version` remain usable.

The example deliberately omits `academicStartYear`: vault folders default to academic years such as `2026-27`. If you want “Year 1”, “Year 2”, etc., set your own start year with `myab setup --course YOUR_COURSE_ID --academic-start-year YYYY`. Existing start-year settings are preserved unless explicitly changed. Existing generated course directories are reused by their Blackboard course ID, including older `Unsorted` or mislabelled year folders, so the parser correction does not create duplicate notes. If multiple generated directories declare the same course, pin the intended folder with `courseDirectories` before merging.

```sh
myab courses
myab check --course CS4028_27 --dry-run
myab check --active
myab refresh --active
myab brief --active --json
myab changes --active --since 0 --json
myab show --course CS4028_27 --id <content-id>
```

- `check` and plain `sync` refresh metadata without downloading lecture files.
- `refresh`, `download`, and `sync --download-files` also verify/download current file candidates.
- `brief` and `status` read the local archive, including section freshness, visibility, file paths, extraction paths and recent changes. They do not launch Chrome or fetch anything.
- `brief.stale` describes the six metadata sections (content, announcements, grades, schedule, messages and discussions). A recently checked but unavailable section is listed in `inaccessibleSections` rather than retried indefinitely. `staleSections` identifies old/missing/partial metadata; `sectionFreshness` separately reports optional file/Panopto checks. `recentChanges` contains the newest twenty changes for that course in chronological order.
- `changes --since` accepts an integer cursor or ISO timestamp. Each caller keeps its own cursor; reading does not consume changes for another caller.
- `show` reads one archived content body with provenance.
- `--course` is repeatable. Exact IDs/codes take precedence over fragments; a fragment may select multiple courses. `--term` selects by term label. `--all` is an explicit broad selection.
- Network refreshes, exports, merges, extraction and relocation require a selector. An omitted selector never silently starts a whole-account archive.

## Incremental behaviour and integrity

Each refresh enumerates folders, including empty ones; parent timestamps are not assumed to reflect descendant changes. It compares meaningful metadata and fetches individual details when changed, incomplete or due for a deeper check (24 hours by default, configurable with `deepCheckHours`). `--deep` forces detail reconciliation.

A failed detail request preserves the previous complete body. Recoverable folder failures do not prevent sibling traversal. Authentication expiry stops the run with exit 2; access denial remains distinct from an empty course. Rows absent from a **complete successful** section check become historical. Partial/unavailable checks never infer removal. Historical files and data are retained.

Downloads save opaque ETag/Last-Modified validators alongside a verified file. Subsequent conditional requests can return 304 without transferring a file body. Conditions survive approved Blackboard file redirects; authentication headers and browser cookies do not. Missing or changed local files trigger a full fetch. Legacy files have no trustworthy validator pair, so their first refresh may need one bounded baseline download. A current HEAD response alone does not prove that an older local file matches it.

SHA-256 remains the local integrity check. Changed versions get a hash suffix; earlier versions are kept and catalogued. Unchanged content is not rewritten. Files, JSON and generated Markdown are written atomically. API/file errors and browser navigation diagnostics redact authentication URLs and headers. Ordinary Blackboard video files are skipped. Panopto has a separate, opt-in read-only integration; other external LTI services remain links.

```sh
myab refresh --course CS4028_27 --limit-files 1
myab refresh --resume <run-id> --limit-files 5
myab verify-files --active
myab doctor
```

A file limit caps attempts, including failures. Repeated limited refreshes rotate courses by their last file-attempt run and check unattempted/oldest-attempted files first, so failed or unchanged files do not monopolise the budget. `--resume` still follows its original bounded selection. Deferred files make the run `limited`; resume advances past successful file checks and completed courses in that run. It retains the original file-attempt limit and deep-check setting unless overridden; a resume preview shows only the remaining selection. Normal cancellation records its status and releases Chrome and the archive lock. A later writer marks abandoned `running` entries interrupted. A process lock prevents simultaneous archive writers; Chrome's own profile locks are never deleted.

Transient network/429/5xx errors receive at most two retries, with bounded backoff/Retry-After. 401/403/404 are not retried. API shape changes, repeated pages and pagination caps become explicit failures instead of silent success.

## Panopto recordings (v0.3.0)

Panopto uses the same private Chrome profile and the normal MyAberdeen sign-in flow. No OAuth API client or university administrator access is needed. `panopto-login` opens the browser for user-owned sign-in/MFA; ordinary reads run headlessly. Authentication expiry exits with code 2, not an empty catalogue.

```sh
myab panopto-login
myab panopto-sync --active --dry-run
myab panopto-sync --course CS4028_27
myab check --active --panopto
myab recordings --course CS4028_27
myab recordings --course CS4028_27 --search "access control"
myab recording --course CS4028_27 --id <recording-uuid>
myab transcript --course CS4028_27 --id <recording-uuid> --format srt
myab panopto-download --course CS4028_27 --id <recording-uuid> --dry-run
myab panopto-download --course CS4028_27 --id <recording-uuid>
```

`panopto-sync` reads the selected courses from the local Blackboard archive. Run a scoped `check` first to discover newly posted links, or use `check --panopto` to do both. It handles ordinary viewer/embed links and Blackboard Panopto LTI deep links, following their normal launch to resolve the viewer ID. Search supplements those links and only accepts matching course codes **and academic years**. It never downloads recordings from unrelated search results.

Student access to an individual recording does not necessarily include access to its folder. Results report `discovery.coverage`: `course-links-and-search` means accessible linked/searchable recordings, **not a guaranteed complete folder inventory**. These runs retain previously archived recordings without marking unseen ones removed. A known folder can be selected with `--folder <uuid>` for one course, or mapped in local `config.json` under `panoptoFolders`, keyed by exact Blackboard course ID or course code, with an array of folder UUIDs. Folder reads paginate and traverse exposed subfolders. If no folder can be listed, or a folder read fails, course search supplements discovery while failures remain visible as partial results. Only a complete successful traversal of the known linked/configured folders can mark recordings historical. An explicit `--folder` scan retains other archived recordings as current and reports `folderInventoryComplete: false`. Access denial and partial traversal preserve the previous archive. No account-wide folder crawl is performed.

The archive includes recording title, description, date, duration, owner, folder information when exposed, viewing progress, all exposed caption languages and timed segments, AI-generated chapters/key points/summary, and contents timing. AI summaries and automatic captions are labelled as such and may contain errors. `recording` lists language IDs; select one with `transcript --language <id>`. Formats: `text` (default), `json`, `srt`, `vtt`. Search returns timestamped matches with playback links. Offline commands do not open Chrome.

Exports include `_course-data/recordings.json` and `recordings/<uuid>/` containing JSON, a linked Markdown transcript, and text/SRT/WebVTT files. `merge-vault` previews and generates a Recordings.md index linking to the offline transcripts. `brief` reports recording data and separate Panopto section freshness; `changes` includes recording changes. The schema upgrade makes a private SQLite backup first. Refresh failures retain old transcripts; earlier media versions are kept. Cookies, user-account identifiers from player responses, and expiring/signed media URLs are not saved in the recording archive.

Video downloads are explicit and use Panopto's permitted podcast-download endpoint. A link being exposed is not a guarantee the server will allow the download. Disabled/denied downloads fail without falling back to player streams. The default maximum is 2 GiB; override with `--max-bytes N`. Downloads stream to a temporary file, enforce the byte limit, reject login/error HTML, verify the transfer length when provided, compute SHA-256, and catalogue the completed MP4. Partial files are removed on failure. `verify-files` includes downloaded recordings. Audio-only downloads, uploading/editing, quizzes, discussion/notes writes and restoration of archived recordings are not supported.

Use `--limit-recordings N` for a bounded metadata/transcript check. It caps attempted recording reads across the selected courses, including failures; limited runs exit 3. Repeat `panopto-sync` to refresh, rather than using Blackboard's `--resume`. `--panopto` on check/sync/refresh does not enable media downloads. Ordinary Blackboard refreshes remain unchanged unless `--panopto` is supplied.

## Cached text

```sh
myab extract --active
myab refresh --active --extract
```

Text extraction is cached by file SHA-256 and extractor version. Supported inputs include PDF (requires Poppler's `pdftotext`), DOCX/PPTX (requires `unzip`), notebooks and common text formats. Cached text is reused without rerunning the extractor. Image-only/scanned files need separate inspection; extraction does not claim to preserve diagrams or full visual layout. `brief` distinguishes section checks, file checks and the last text extraction time.

Refreshes are on demand unless a background schedule is separately configured. The command is deterministic and can be called by a local scheduler; overlapping invocations stop at the process lock. The tool does not install a schedule or keep an SSO session alive automatically.

## Exports and Obsidian

Obsidian is optional. There is no default vault path, and ordinary archive, download and export commands do not require a vault. To enable integration, provide your own vault containing a `Uni` directory, either during guided `myab setup`, through `vaultRoot` in your local config, or through `MYAB_VAULT`. For example:

```sh
myab setup --course YOUR_COURSE_ID --vault "/path/to/your/vault"
```

The `--course` selection replaces your current profile; include every course you want in `--active`, or use guided setup. `merge-vault` refuses to run without an explicit, available vault. `repair` skips vault indexing when no vault is configured. Users upgrading from older versions who relied on the implicit vault path must configure it explicitly.

```sh
myab export --active
myab merge-vault --active --dry-run
myab merge-vault --active --keep-duplicates
myab merge-vault --active
```

Selections apply to generated notes, export datasets and duplicate removals. Merge previews list the intended course directories, generated files and hash-identical duplicate removals. Same-course curated copies are preferred. Course directories include academic-year identity; explicit mappings can be supplied using `courseDirectories`, keyed by Blackboard course ID and relative to the vault's `Uni` directory. Conflicting existing course ownership is rejected.

Generated files live in each course's `MyAberdeen` directory. Imported HTML is decoded once and emitted as escaped text, including Markdown image syntax, so message/announcement text cannot become active markup in vault section notes. Recording transcript exports retain their existing formatting. Keep personal notes in separate files; generated section files are owned by the exporter. Arbitrary personal Markdown elsewhere is preserved. Byte-identical raw duplicates may be removed during merge; `--keep-duplicates` retains them. An unselected course's raw files are not removed.

Exports keep ordinary dataset shapes and add `_archive` visibility/change metadata. `freshness.json` contains per-record observation dates and section outcomes separately, so polling timestamps do not rewrite unchanged content bodies. Scoped exports update only selected course directories and preserve other entries in the main index.

## Migration and moved archives

The first writable open of a legacy database makes a private SQLite backup before upgrading. `repair` upgrades, corrects availability from saved source payloads, and reindexes vault file hashes/course associations without generating notes or deleting duplicates.

```sh
myab repair
myab relocate-files --all --from /old/archive --to /mounted/archive
myab relocate-files --all --from /old/archive --to /mounted/archive --apply
```

Relocation covers Blackboard files, retained file versions and downloaded Panopto videos. Each plan item identifies its kind; all catalogue updates use one transaction and are rolled back if a destination or catalogue row changes. Relocation first produces a plan. `--apply` rechecks destination hashes and changes catalogue paths in a transaction. It never moves or deletes source files. Unavailable mounts and mismatched destinations are reported; a missing local path is not proof of data loss. Existing file versions retain their history.

## Paths and exits

Defaults: state `~/.local/share/myaberdeen-cli`, profile `chrome-profile` inside state, database `myaberdeen.sqlite` inside state, downloads `~/Documents/MyAberdeen`. Text caches also live under state. `myab paths` shows the resolved configuration.

Override using `MYAB_STATE_DIR`, `MYAB_PROFILE_DIR`, `MYAB_DATABASE`, `MYAB_DOWNLOAD_DIR`, `MYAB_CHROME`, `MYAB_VAULT`, or `MYAB_CONFIG`. Runtime profiles, databases, backups, downloaded materials and extracted text must stay out of source control.

Exit codes: `0` success; `1` fatal/usage error; `2` authentication required; `3` partial, deliberately limited, or missing/mismatched files; `130`/`143` cancelled by SIGINT/SIGTERM. Structured output uses stdout; progress and safe errors use stderr.

Development checks:

```sh
npm run check
```

Tests use synthetic data, temporary directories and mocked endpoints. CI needs no university credentials. Blackboard's internal endpoints can change; a successful local test suite does not replace a small live smoke check. Grades/schedules do not guarantee a complete assessment calendar.

## Build portable downloads yourself

From a source checkout with the supported Node version installed:

```sh
npm ci
npm run check
npm run build:release
npm run smoke:release
```

The build targets the current OS/CPU and downloads the matching official Node distribution for the running Node version, verifying its published SHA-256. Internet access, npm and `tar` (macOS/Linux) or PowerShell (Windows) are required. Outputs go to ignored `dist/`. An explicit source allowlist excludes local profiles, archives and configuration; the project MIT licence, security policy, contribution guide, and dependency/Node licence files are included. The smoke check extracts the archive into a temporary path containing spaces and exercises the actual launcher, bundled dependencies and SQLite with synthetic data, without university credentials.

## Making releases

1. Update `package.json` and `package-lock.json` to the same version and commit the changes.
2. Run the **Release** workflow manually against the branch with **publish disabled** to check every platform before tagging.
3. Push a matching stable tag, for example `git tag v0.2.0` then `git push origin v0.2.0`.

The Release workflow runs tests, builds and smoke-checks each archive on its native platform, and publishes the release with all downloads/checksums only when every build succeeds. Manual publishing requires an existing `vX.Y.Z` tag matching the package version. GitHub's source archives and the normal source-install route remain available.

Release jobs use Node 24. Platform checks run on macOS ARM64, macOS Intel, Linux x64 and Windows x64. Live authentication is deliberately excluded from CI. Only the repository owner can run the release jobs. Existing release assets are never overwritten by the workflow; `BUILD.json` records the exact runtime and commit used.

## Contributing

Open an issue first, then work in your own fork and submit a pull request for Jacob to review and merge. Upstream branches and tags are owner-only. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, local checks and privacy requirements.

## Licence and security

Copyright © 2026 Jacob Corbett. Released under the [MIT licence](LICENSE). Redistributed copies or substantial portions must retain the copyright and licence notices; separate academic citation is not a licence requirement. Contributions are accepted under the same licence.

Report security issues through the private routes in [SECURITY.md](SECURITY.md), not a public issue.
