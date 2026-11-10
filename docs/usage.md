# Using your archive

[← Back to the README](../README.md)

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

## Cached text

```sh
myab extract --active
myab refresh --active --extract
```

Text extraction is cached by file SHA-256 and extractor version. Supported inputs include PDF (requires Poppler's `pdftotext`), DOCX/PPTX (read by a built-in ZIP reader; no external tool needed; slides are kept in numeric order), notebooks and common text formats. Cached text is reused without rerunning the extractor. Image-only/scanned files need separate inspection; extraction does not claim to preserve diagrams or full visual layout. `brief` distinguishes section checks, file checks and the last text extraction time.

Refreshes are on demand unless a background schedule is separately configured. The command is deterministic and can be called by a local scheduler; overlapping invocations stop at the process lock. The tool does not install a schedule or keep an SSO session alive automatically.

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

## Completed test reviews

Scoped `check`, `sync`, `refresh` and `download` automatically read existing completed test attempts referenced by the current gradebook (first, last, highest and lowest, deduplicated). They never create, start, resume or submit an assessment attempt, and do not request instructor question banks. Other intermediate historical attempts and external LTI assessments are not enumerated.

```sh
myab check --course CODE
myab test-reviews --course CODE
myab test-reviews --course CODE --id ATTEMPT_ID --format text
```

The offline command defaults to JSON. Reviews retain original question HTML, options, question IDs, answer ordering, structured student responses and the visibility flags supplied by Blackboard. Text output includes readable question/option text and original response values; it does not infer hidden correct answers or per-question scores. Images, attachments and other embedded media remain references in JSON and are not downloaded by review archiving.

Pagination, question identities and the advertised question count are checked before replacing an attempt snapshot. Denied, malformed or incomplete reviews make the sync partial and retain the previous successful snapshot. Check the separate `assessment-reviews` section freshness; a successful gradebook read does not prove questions were archived. Old archived reviews are retained when a reference disappears, with historical provenance. A missing test-review table in an older read-only database yields no reviews; run a scoped check to upgrade and collect them. The first writable upgrade backs up the SQLite database.

Course exports include private `_course-data/assessment-reviews.json` and `assessment-reviews.md`. An explicitly requested vault merge adds `MyAberdeen/Assessment-reviews.md` and an index link. Test questions, answers and grades are private runtime data: never include them in source control, public fixtures or shared diagnostics.

## Class Register

Class Register collection is opt-in. Add `--roster` to a scoped `check`, `sync`, `refresh` or `download`, then read the local snapshot without opening Chrome:

```sh
myab check --course EX1000 --roster
myab roster --course EX1000
myab roster --course EX1000 --format text
```

`EX1000` is a synthetic example; use an actual course selector. Repeated `--course`, `--active`, `--profile`, `--term` and explicit `--all` follow the usual scope rules. Resume retains the original roster opt-in. Ordinary refreshes without `--roster` leave the roster and its check time untouched.

JSON output contains one object per selected course, its latest roster `section` status/check time and its `members`. Member records contain membership/course/user IDs, given/family/display names, pronouns where supplied, role code/identifier/label, archive time and presence provenance. Display names are built from the supplied given and family names; Blackboard's `preferredDisplayName` is a setting rather than a name. Custom literal role labels are retained; unresolved localisation keys fall back to a standard role label or identifier.

Only memberships exposed to the signed-in account are read. A completed traversal is not a guarantee that Blackboard exposes every enrolled user. Check `section.status` and `checked_at` before treating a snapshot as current: `never-checked`, `partial` and `unavailable` do not mean an empty register. Failed/incomplete reads preserve the previous successful member data. After a successful complete traversal, disappeared members remain archived with `_archive.presence: historical`; text output labels them. JSON/text are cached views and do not refresh automatically. `brief` exposes roster freshness separately after a roster check.

Expanded email addresses, student numbers, other profile identifiers, avatars, pronunciation media and permission metadata are not stored. No accommodation data is collected. These exclusions also apply to private exports and vault notes. The first writable v5 upgrade makes a private database backup; old read-only archives report the roster as never checked until collected.

Exports add private `_course-data/roster.json` and `roster.md`. An explicitly requested vault merge adds `MyAberdeen/Roster.md` and an index link. These outputs contain personal data: keep them, their backups and diagnostics out of source control and public handoffs. Tests and public examples use synthetic data only.
