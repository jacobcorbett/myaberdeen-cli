# Panopto recordings

[← Back to the README](../README.md)

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
