# Changelog

All notable changes to this project will be documented in this file.

Entries describe what changed for users, why it changed, and any limits or upgrade steps. Releases are listed newest first; work that has not shipped belongs under Unreleased.

## Unreleased

### Fixed

- Honour owner-enabled squash auto-merge requests after required CI and review gates pass, using the owner credential without weakening protected-ref rules.

- Raise the supported Node minimum and portable runtime pin to security patch 26.13.1; source installations on 26.13.0 must update Node.

### Added

- Optional per-course content history, disabled by default. Seed cached wording on enable, retain original JSON and provenance only on meaningful changes, read before/after text offline, inspect payload storage and preview explicit retention pruning. Disable without deleting history; past unrecorded edits cannot be recovered. Existing archives receive a private migration backup.

- Read cached announcements, grades, messages and discussions with dedicated scoped offline commands. JSON retains original payloads and archive provenance; text shows readable bodies, scores, conversation/thread context and freshness. Filter by ID or text and limit results per course. These commands do not open Chrome or refresh the archive.

- Opt-in Class Register archiving with `--roster` on scoped Blackboard refreshes and an offline `roster` command with JSON/text output. Retain names, course roles, pronouns and record IDs; omit contact details and unrelated profile metadata. Include private exports and optional vault notes, section status and historical membership tracking. Denied or incomplete reads preserve the previous snapshot. Existing databases receive a private backup before upgrading.

## [0.6.0](https://github.com/jacobcorbett/myaberdeen-cli/compare/v0.5.1...v0.6.0) (2026-11-13)


### Features

* preserve optional content history and fix checked auto-merge ([#8](https://github.com/jacobcorbett/myaberdeen-cli/issues/8)) ([4ac886a](https://github.com/jacobcorbett/myaberdeen-cli/commit/4ac886a3f695b7f43cfe09c06fc92d87af4b3d11))

## [0.5.1](https://github.com/jacobcorbett/myaberdeen-cli/compare/v0.5.0...v0.5.1) (2026-11-10)


### Bug Fixes

* use owner override for checked release merges ([882c085](https://github.com/jacobcorbett/myaberdeen-cli/commit/882c0854e6eb8758256e67baa567cdc172716a63))

## [0.5.0](https://github.com/jacobcorbett/myaberdeen-cli/compare/v0.4.0...v0.5.0) (2026-11-10)


### Features

* add offline course reading commands ([#6](https://github.com/jacobcorbett/myaberdeen-cli/issues/6)) ([aa268d4](https://github.com/jacobcorbett/myaberdeen-cli/commit/aa268d43928ed09b7a1a8e223d873a776f4c6439))
* archive Class Register memberships on request ([#4](https://github.com/jacobcorbett/myaberdeen-cli/issues/4)) ([d8c8e76](https://github.com/jacobcorbett/myaberdeen-cli/commit/d8c8e769bbdae09d03288bfdefcbb2433426cc42))

## [0.4.0](https://github.com/jacobcorbett/myaberdeen-cli/compare/v0.3.4...v0.4.0) (2026-11-04)


### Features

* archive completed Blackboard test reviews ([#1](https://github.com/jacobcorbett/myaberdeen-cli/issues/1)) ([1337d4d](https://github.com/jacobcorbett/myaberdeen-cli/commit/1337d4d9a0c2292d7ab2276030ef76d2bc20b5a0))

Archive completed test reviews during scoped Blackboard syncs, including question text, options, student responses and released feedback. Add offline `test-reviews` JSON/text output and private export/vault notes. Validate question pagination/counts and preserve previous snapshots on denied or incomplete reads; correct answers and per-question scores remain subject to Blackboard visibility. Coverage is limited to gradebook-referenced completed test attempts; embedded media remains linked.

### Release automation

- Prepare version and changelog pull requests with Release Please. Merging a release PR creates a tagged draft; verified portable downloads become public only after all platform builds, smoke tests and security checks pass. Owner-only repository rules remain in force.

## [0.3.4] - 2026-11-04

### Removed

- Intel Mac (`macos-x64`) portable downloads and release builds. Portable releases now cover Apple Silicon Macs, Linux x64 and Windows x64. Earlier Intel Mac downloads remain available on their original releases but receive no updates.

### Changed

- Refresh the README with original artwork, a synthetic-data terminal demo, an optional Obsidian export preview and a shorter quick start. Move detailed operational guidance into linked documentation, included in portable bundles.
- Word and PowerPoint text extraction no longer needs an external `unzip` program, so it now works on a standard Windows installation. A built-in reader handles ordinary stored and compressed documents and rejects encrypted, ZIP64, malformed or oversized archives with a clear message. `doctor` no longer suggests installing `unzip`.
- Generated vault indexes use correct singular and plural counts, such as “1 record” rather than “1 records”, and the announcement and gradebook counts are labelled. Recording durations display as `45:00` or `1:02:03` instead of a number of seconds.
- Portable bundles include the Markdown guides but no longer carry the README images and demo video (about 740 KB). View them on GitHub.
- Development checks now include ESLint, `npm run coverage` reports built-in Node test coverage, and Dependabot proposes weekly npm and GitHub Actions updates. `npm test` checks the Node version and installed packages first, so an unsupported runtime or a missing `npm ci` gives a clear message instead of a module-resolution error.

### Fixed

- PowerPoint text was cached in alphabetical slide order (1, 10, 11, 12, 2, …) for decks with ten or more slides. Slides are now read in numeric order. The text extractor version is now `text-v2`, so the next `myab extract` rebuilds older cached text automatically.
- Download deduplication now applies configured `courseAliases` when no canonical course code is supplied, matching the vault course code.
- A failure to remove a temporary file no longer hides the original write or download error.

## [0.3.3] - 2026-11-03

### Security

- Pin portable runtimes and CI to Node 26.13.0, with checksum verification of the downloaded runtime. The 0.3.2 macOS bundles contained older Node 24 patches; upgrade to 0.3.3 to receive the patched bundled runtime.
- Add a security check for production dependency advisories, official Node security releases and runtime end-of-life dates. Update locked parse5 and playwright-core dependencies and pin maintained GitHub Actions to reviewed commits.

### Changed

- Require Node 26.13.0 or newer within Node 26 for source installations. Drop Node 22 and 24 support; unsupported runtimes fail before CLI commands run. CI tests Node 26.13.0 on Linux, macOS and Windows.

### Added

- This changelog, covering the published releases from 0.2.0 onwards. The earlier source-only work is included in the first release it shipped with rather than assigned an invented release number or date.

## [0.3.2] - 2026-11-03

### Fixed

- Panopto discovery now supplements failed folder reads with course search. Previously, finding a folder link disabled search even when the student could not list that folder, so an inaccessible link could result in fewer recordings being found than no folder link at all. The accessible recordings are now archived while the folder failure remains visible as a partial result. Linked/search discovery still does not establish a complete recording inventory.

- An explicit `panopto-sync --folder` scan no longer marks recordings outside that scan historical. Previously, a successful subfolder listing could be treated as a complete course inventory, making earlier recordings appear unavailable and blocking their download. Missing recordings are reconciled only after a complete successful traversal of the known linked/configured folders, without an explicit folder override.

- `brief` separates metadata freshness from optional file and Panopto checks. A limited download or old recording check used to keep the whole course marked stale after a successful metadata refresh. The output now names stale metadata in `staleSections`, reports each section in `sectionFreshness`, and lists access restrictions in `inaccessibleSections`. Temporary course-fetch failures remain partial and stale; only actual access denials or an unavailable course are treated as checked but inaccessible.

- `brief.recentChanges` now contains the newest twenty changes for that course, in chronological order. It previously returned the oldest twenty entries within the last hundred global changes, which could hide recent activity or leave a course with no history simply because other courses had been busy.

- `relocate-files` now covers downloaded Panopto videos and retained Blackboard file versions as well as current files. Previously, moving the download root left recording assets pointing at their old paths, so verification reported them missing even when the moved files were present. Destination hashes are checked, all catalogue updates share a transaction, and a changed file or catalogue row rolls the operation back. Relocation still does not move or delete source files.

- Academic years such as `2026-2027`, `2026/2027` and `2026–27` now resolve correctly. The four-digit end year could previously become `2026-20`, while spaced or en-dash dates could fall into `Unsorted`. Existing generated course directories are reused by their recorded Blackboard course ID, so upgrading does not create duplicate notes under a corrected year label. Explicit `courseDirectories` mappings take precedence; ambiguous existing ownership requires a mapping rather than choosing a folder silently.

- Generated vault section notes parse imported HTML once and escape the resulting text, including Markdown image syntax. Encoded tags could previously become live markup after decoding. Headings and other displayed fields are escaped too. Some generated notes will receive a one-time formatting update on the next merge; curated notes remain separate, and recording transcript exports keep their existing formatting.

- Malformed configuration no longer prevents `help` or `version` from running. `doctor` and `paths` identify the configuration file and return structured repair guidance with exit code 1. Previously, those diagnostic commands failed with the same pathless error as the command the user was trying to repair.

### Changed

- Repeated refreshes with `--limit-files` rotate courses and prioritise unattempted or oldest-attempted files. Failed and unchanged downloads still count towards the limit, but no longer monopolise every run while later files wait indefinitely. `--resume` retains its original bounded selection, and course rotation stays inside any `--limit-courses` selection.

- Guided setup retries invalid course numbers and optional vault paths without discarding the user's choices. Trailing commas, matching quotes around pasted paths and common POSIX path escapes are accepted. Availability labels use Blackboard's effective availability, and non-interactive setup without explicit course choices fails before starting Chrome.

- `downloadDir` and `chromePath` can be saved in local configuration. Relative JSON paths resolve beside the configuration file, so a new shell or scheduled task does not select a different download root; environment overrides retain normal shell-relative behaviour. Both slash and backslash home prefixes are accepted. Chrome discovery also checks per-user macOS/Windows installations, Windows Program Files (x86), and `/opt/google/chrome/chrome`.

- Lock diagnostics now report the lock path, owner PID, whether that PID appears alive, and recovery state. Confirmed dead owners are left for the existing automatic recovery; unknown or active ownership is not removed automatically. The guidance distinguishes archive-operation locks from Chrome profile locks.

### Added

- Windows with Node 24 in the normal CI matrix, alongside the existing macOS and Linux checks. Portable packages continue to be built and smoke-tested on Apple Silicon Macs, Intel Macs, Linux x64 and Windows x64 before publication. These checks use synthetic data and do not establish live university authentication on every platform.

## [0.3.1] - 2026-11-03

### Added

- `myab setup` guides users through selecting their current courses and saves exact course IDs to the local `--active` profile. Explicit repeated `--course` options support non-interactive setup. Unrelated configuration and other profiles are preserved, and setup does not download course content.

- Setup diagnostics for configuration, current-course selection, vault availability and optional extraction tools, with suggested next steps. The README now starts with the path from installation and sign-in to the first scoped refresh.

- An MIT licence crediting Jacob Corbett, contribution guidance for the fork-and-PR workflow, and a security policy with private reporting routes. The licence, contribution guide and security policy are included in portable packages.

### Changed

- Obsidian integration is optional and requires an explicit vault path. The author's vault layout is no longer an implicit destination. Users upgrading from a version that relied on that default must set `vaultRoot` or `MYAB_VAULT` before using `merge-vault`; ordinary archive commands work without a vault.

- The example configuration no longer assumes the author's academic start year. Without a configured start year, vault folders use academic-year labels; users who want relative “Year N” labels can supply their own start year. Existing configured values are preserved.

- Session persistence is now described in the README, operator skill and login output. The existing behaviour makes session-only cookies persistent for up to seven days on disk and uses reduced OS keychain integration; provider expiry, revocation and MFA still apply. This release disclosed that behaviour rather than changing it. The dedicated profile must stay private and out of shared or synced backups.

- Release jobs require the repository owner as both the original and rerun actor. Publishing an existing release no longer triggers another build, and the workflow no longer overwrites existing release assets.

## [0.3.0] - 2026-09-24

### Added

- Browser-based Panopto archives through the normal university sign-in flow, without an OAuth API client. Discovery is course-scoped and reads accessible links, embedded LTI launches, search results and explicitly selected folders. Access to an individual recording does not imply permission to list its folder.

- Timestamped transcripts in exposed caption languages, recording metadata, contents markers, AI chapters, key points and summaries. Recordings can be listed and searched offline, and transcripts exported as text, JSON, SRT or WebVTT with links to matching playback times. Captions and AI-generated material remain fallible source data.

- Explicit, permission-respecting video downloads through exposed podcast-download URLs. Downloads stream to a temporary file, enforce a byte limit, check the transfer length where available, compute SHA-256 and catalogue the completed asset. Denied downloads do not fall back to player-stream extraction. Audio-only downloads and remote editing are not supported.

- Panopto-aware SQLite migration backups, change tracking, private exports and a recordings index for vault merges. Failed or incomplete refreshes retain earlier transcripts; cookies, player-account identifiers and expiring media URLs are excluded from recording exports.

### Fixed

- The migration test closes its database before fixture cleanup, allowing the Windows check to complete without an open-file error.

## [0.2.0] - 2026-09-22

### Added

- Portable downloads for Apple Silicon Macs, Intel Macs, Linux x64 and Windows x64. Each package includes the Node runtime, locked production dependencies, a launcher, a SHA-256 checksum and build metadata. Users extract the whole folder and keep `lib/` beside the launcher; Google Chrome remains a separate requirement. Source installation stays supported, and private state remains outside the installation folder.

- An operator skill covering installation, authentication, scoped archive operations, troubleshooting and updates. Agents can use the CLI without the author's personal vault or agent setup.

- Scoped incremental refreshes, archive-first queries, a change feed, file verification, text extraction and previewable exports/vault integration. An operation requires an explicit course/profile selection or deliberate `--all`, rather than silently downloading every account membership. Incomplete sections preserve earlier data instead of inferring removal.

### Changed

- Expired Blackboard sessions can reuse remembered university SSO after an interactive sign-in. The CLI still cannot bypass provider expiry or MFA requirements.

- Release packages are built from an explicit source allowlist, with runtime/dependency licences preserved and private profiles, configuration and archives excluded. Native checks exercise the extracted launcher, dependencies and SQLite using synthetic data before publication. Packages are unsigned and not notarised.

### Fixed

- Node SQLite warning handling in command-error checks, database cleanup before removing Windows fixtures, and Windows launcher quoting in the portable smoke check.

[0.3.4]: https://github.com/jacobcorbett/myaberdeen-cli/releases/tag/v0.3.4
[0.3.3]: https://github.com/jacobcorbett/myaberdeen-cli/releases/tag/v0.3.3
[0.3.2]: https://github.com/jacobcorbett/myaberdeen-cli/releases/tag/v0.3.2
[0.3.1]: https://github.com/jacobcorbett/myaberdeen-cli/releases/tag/v0.3.1
[0.3.0]: https://github.com/jacobcorbett/myaberdeen-cli/releases/tag/v0.3.0
[0.2.0]: https://github.com/jacobcorbett/myaberdeen-cli/releases/tag/v0.2.0
