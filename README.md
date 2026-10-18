# Line Comments

Comment threads on any line of code in VS Code, outside pull requests. Threads are stored in S3
(e.g. SeaweedFS) or a shared folder, so your team and coding agents see the same comments.

## Install

```bash
curl -fsSLO https://github.com/choandrew/line-comments/releases/latest/download/line-comments.vsix && code --install-extension line-comments.vsix
```

## Set up

In your user settings:

```json
{
  "lineComments.location": "s3://trading/line-comments",
  "lineComments.s3.endpoint": "http://seaweedfs.example:8333"
}
```

`location` can also be a folder, such as a Dropbox path. Unset, it is `~/.line-comments`. If the
S3 store needs a key, the side bar asks for one.

## Use

- Click `+` next to a line number to start a thread. Anyone can reply.
- Archive hides a thread; delete removes it.
- The Line Comments side bar lists every thread and shows archived ones on request.
- Comments show only on the default branch (usually `main`) and follow the code as it changes.

## Storage format

```
<location>/<owner>/<repo>/<thread-id>/thread.json        {"path", "line", "text", "commit", "archived"}
<location>/<owner>/<repo>/<thread-id>/<comment-id>.json  {"author", "body", "at"}
```

`line` is 1-based and refers to `commit`.

## Develop

```bash
npm ci && npm run check
```

Set `LINE_COMMENTS_TEST_S3` and `LINE_COMMENTS_TEST_S3_OPEN` to also test against S3, as
`.github/workflows/ci.yml` does. Push a `v*` tag to release.
