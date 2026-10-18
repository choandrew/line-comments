# Line Comments

GitHub-style comment threads on any line of code in VS Code, without a pull request. Threads live
outside the repo: in an S3 bucket (AWS, SeaweedFS, MinIO) or a shared folder (Dropbox, Google
Drive, a network share), so everyone pointed at the same place sees each other's comments. Coding
agents (Claude Code, Codex) can read the same files.

## Install

```bash
curl -fsSLO https://github.com/choandrew/line-comments/releases/latest/download/line-comments.vsix && code --install-extension line-comments.vsix
```

Or download `line-comments.vsix` from the [latest release](https://github.com/choandrew/line-comments/releases/latest)
and run **Extensions: Install from VSIX…** in VS Code.

## Set up

One user-level setting covers every repo: each repo's threads go under
`<location>/<owner>/<repo>/`, named from its `origin` remote.

**Shared through S3** (SeaweedFS shown):

```json
{
  "lineComments.location": "s3://trading/line-comments",
  "lineComments.s3.endpoint": "http://seaweedfs.example:8333"
}
```

Requests go without a key at first, so a store that allows anonymous access needs no setup. If
the store refuses them, the Line Comments side bar shows **Set S3 Credentials**; the key is kept
in VS Code's secret storage, never in settings. S3 has no change notifications, so new comments from
others appear within 10 seconds.

**Shared through a folder:** set `lineComments.location` to it, e.g.
`~/Library/CloudStorage/Dropbox/line-comments`. Changes appear as the folder syncs.

Left unset, `lineComments.location` is `~/.line-comments`: comments stay on your machine.

## Use

- **Side bar:** the Line Comments icon in the Activity Bar lists every thread by file, with a
  badge counting open threads; click one to jump to its line. The panel also says why nothing
  shows (off `main`, no S3 key yet).
- **Comment:** hover the gutter next to a line and click `+`.
- **Reply:** anyone can add to any thread.
- **Archive:** the archive button hides a thread; **Unarchive** brings it back.
- **Delete:** the trash button removes a thread and all its comments, after a confirmation.
- **See archived threads:** the archive button in the side bar's title, or
  **Line Comments: Show/Hide Archived Threads**.

Comments show only while the repo is on its default branch (the one `origin/HEAD` names, usually
`main`), because their line numbers refer to that branch. Your name comes from `git config user.name`.
Workspaces in Restricted Mode get no comments, since the extension runs git there.

## Lines follow the code

Each thread records the commit it was written on. When `main` moves (you pull, commit or check
out), the extension replays `git diff` from that commit to the working tree:

- Lines added or removed above a thread move it, even when an identical line exists elsewhere.
- A renamed file takes its threads with it.
- If the commented line itself was rewritten, the thread looks for that text only inside the
  rewritten lines; if it is gone, the thread stays nearby and its header says the line changed.
- If your clone lacks the commit (a teammate commented on a newer `main`), the thread goes to the
  nearest line with the same text until you pull.

## Storage format

```
<location>/<owner>/<repo>/<thread-id>/thread.json
    {"path": "src/app.py", "line": 42, "text": "the line when commented",
     "commit": "<sha the comment was written on>", "archived": false}
<location>/<owner>/<repo>/<thread-id>/<comment-id>.json
    {"author": "Ada", "body": "Markdown text", "at": "2026-10-17T18:03:00.000Z"}
```

- `path` is relative to the repo root; `line` is 1-based and refers to `commit`.
- Each comment is its own file, so two people replying at once never conflict.
- Comments are ordered by `at` (ISO 8601).

To point an agent at the comments, add a line like this to the repo's `AGENTS.md` or `CLAUDE.md`:

> Line review comments live in `s3://trading/line-comments/<owner>/<repo>/`; the format is at https://github.com/choandrew/line-comments#storage-format.

## Develop

```bash
npm ci && npm run check
```

`npm run check` also runs the store tests against S3 when `LINE_COMMENTS_TEST_S3` names a bucket,
e.g. `http://test-key:test-secret@localhost:18333/test`, and against an anonymous one when
`LINE_COMMENTS_TEST_S3_OPEN` does, e.g. `http://localhost:18334/test`; CI starts a SeaweedFS for each.

Push a `v*` tag to build and publish a release.
