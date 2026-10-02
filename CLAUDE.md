# CLAUDE.md — daily-dictation

Guidance for Claude Code (and any other agent) working in this repository.

---

## 🔴 Remote access rule — read this before touching the remote

**ALL INTERACTIONS WITH THE REMOTE MUST USE THE `GH_TOKEN` IN THE `.env` FILE.**

**DO NOT TRUST OR USE ANYTHING FROM `gh auth status`.**

This is not a style preference. It is a correctness rule, and it is enforced by
config, not just by this document. (Same pattern as `~/parakeet-ov`'s
`CLAUDE.md` — copied here because this machine has the identical problem.)

### Why

This machine's GitHub credential store holds **two** accounts:

| account | where it lives | correct for this repo? |
|---|---|---|
| `okoyfoeciov` | keyring **and** `.env` | ✅ yes |
| `khiemea` | keyring, and `~/.gitconfig` `[user]` | ❌ no |

`~/.gitconfig` globally routes github.com credentials through
`!/usr/bin/gh auth git-credential`, and `gh`'s "active account" can silently
change (`gh auth switch`, a re-login, a keyring refresh, another repo's
session). A push that quietly resolves to `khiemea` lands commits on the wrong
identity, or fails with a confusing 403. `gh auth status` reports *keyring*
state — it says nothing about what this repo is supposed to use.

`.env` is the single source of truth. Nothing else is.

### How it is enforced

`git init` was followed by:

```bash
git config --local credential.https://github.com.helper ""            # reset inherited helpers
git config --local --add credential.https://github.com.helper \
    "/home/james/daily-dictation/.githelpers/credential-from-env.sh"
```

The empty first value **resets** the helper list inherited from `~/.gitconfig`,
so `gh auth git-credential` is not consulted at all inside this repo.
`.githelpers/credential-from-env.sh` reads `GH_TOKEN` out of `.env` and answers
with `username=x-access-token` + that token.

**Do not delete that helper.** It is the mechanism, not a convenience — without
it git falls straight back to the global `gh auth git-credential`, which is the
exact failure this rule exists to prevent.

### Rules for agents

1. **Push / fetch / pull:** just run `git push` / `git fetch`. The local helper
   supplies the `.env` token automatically. Do not pass `-c credential.helper=`,
   do not use `gh auth setup-git`, do not embed a token in the remote URL.
2. **GitHub API calls** (creating repos, reading repo metadata, issues):
   read the token out of `.env` and pass it explicitly.

   ```bash
   GH_TOKEN="$(grep -m1 '^GH_TOKEN=' .env | cut -d= -f2-)"
   curl -sS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
        https://api.github.com/user
   ```

   If you use the `gh` CLI, it must be invoked with the token injected from
   `.env` — `GH_TOKEN="$GH_TOKEN" gh ...` — because an explicit `GH_TOKEN`
   environment variable overrides the keyring. Bare `gh` is not acceptable.
3. **Never run** `gh auth login`, `gh auth switch`, `gh auth setup-git`, or
   `gh auth token` as part of work in this repo.
4. **Never** treat `gh auth status` output as authoritative for anything. If you
   need to know who the token is, ask GitHub with the token itself:
   `curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user`.
5. **`.env` is gitignored and must stay that way.** Never commit it, never echo
   the token into logs, terminal output, commit messages, or a PR body.
6. `.env` holds exactly one line, and the helper expects that shape:

   ```
   GH_TOKEN=gho_xxxxxxxxxxxx
   ```

### Commit identity

Set locally, so the global `khiemea` identity never applies here:

```
user.name  = okoyfoeciov
user.email = 92897177+okoyfoeciov@users.noreply.github.com
```

Check with `git config --local --list` before the first commit of a session.

### Remote

`origin` is `https://github.com/okoyfoeciov/audiovisual-materials.git` (private).

---

## Repo conventions

### Staging

**Never** `git add .` or `git add -A`. `.claude-session-active` is an untracked
worktree marker that must stay untracked *and* must not be added to
`.gitignore`; blanket staging would sweep it in. Use explicit paths or
`git add -u`.

### What is intentionally not in git

`.gitignore` excludes `node_modules/` (~565 MB, reinstalled via `npm install`),
`dist/` (electron-builder output), and `library/` (machine-local user data:
media, `db.json`, `dictation.json`). `.env` must never be committed. Everything
else — including `build/icon.png` and `build/icons/`, which `package.json`'s
`build.mac`/`build.linux` config references directly — is tracked. The
legacy `pbs-sync.log` (from when the sync ran from cron) is untracked by omission, not by rule.

### About this project

A dictation-only Electron desktop app: daily dictation sessions cut from PBS
NewsHour segments (audio-only, 1–2 sentences per session, looped), with
WER-based grading, SM-2 spaced scheduling, and click-a-word AI explanations.
The corpus lives under `library/collections/pbs-newshour*`, with media in
`library/movies/*` (the older mp4 corpus) and `library/audios/*` (the RSS
audio imports), and the only media route is
`GET /api/library/:id/stream`, which serves the segment audio the dictation
loop plays inside of.

`app-player.js` owns the shared `<audio>` transport (play/pause/seek/time,
mobile collapse, keyboard) and the explanation panel (via `/api/explain`,
`/api/pron`, `/api/credits`, all proxied to ai-service on 127.0.0.1:8770); `app-dictation.js` owns
the notepad UI, the session loop, and grading, and reaches the panel through
`window.__dictationExplain` / `window.__dictationCloseExplanations`.
`app-base.js` resolves the API base URL (see its own header comment) — this
app's embedded backend (`main.js` starts `backend/server.js` in-process on
loopback; library lives in `<repo>/library` in dev, `<userData>/library`
packaged — see `backend/paths.js`). `backend/dictation.js` holds the session-partition algorithm, the scheduler,
and the WER grader. `backend/pbs-sync.js` is the catch-up sync: the embedded
backend runs it on app launch and every few hours, pulling new PBS segments
from the segments RSS audio with verbatim transcription via ai-service
(`backend/transcribe.js` → `POST 127.0.0.1:8770/api/transcribe-verbatim`,
Azure MAI-Transcribe-2 under the hood — this app holds no Azure credentials),
repairing broken transcripts, and pruning days past `KEEP_DAYS` (7).
`main.js` is the Electron shell. Avoid changing `app-player.js`'s explanation
engine unless the task requires it.

## Packaging

### This project ships no prebuilt artifacts

There are no GitHub releases here and no binaries attached to the repo, and
none should be created. Every machine that wants the app pulls this source and
builds its own package — on macOS a `.dmg`, on Linux a `.deb`. **Do not create
a release, do not upload an artifact, do not cut a version tag as one.**

The reason is the cross-build wall documented below: neither platform can build
the other's package here, so a release could only ever carry the artifact for
whichever machine happened to cut it — which is exactly the half-empty release
this repo's history ended up with. Building where you run it is both simpler
and always complete.

Seven releases (`v1.0.0`–`v1.0.6`) existed until they were deliberately
deleted. The `vX.Y.Z` tags GitHub created for them may still be on the remote;
they point at real commits and are historical markers only — nothing builds
from them or expects them.

### Build

```
npm install
npm run dist:linux   # → dist/daily-dictation_<version>_amd64.deb
npm run dist:mac     # → dist/*.dmg (plus a .zip side-artifact) — Mac only, see below
```

`version` in `package.json` now only names the output file. It used to be
bumped one patch digit per release; with releases gone there is nothing to bump
it *for*, so change it when you want a different artifact name — not on every
commit, as the old rule had it.

### Why each platform must build its own

`build.mac.target` is `"dmg"`; electron-builder emits a plain `.zip` alongside
it as an auto-update side-artifact, so a Mac build produces both.

Building the mac target **on Linux does not work**. It needs `dmg-license`, a
macOS-only optional dependency (`"os": ["darwin"]` in `package-lock.json`) that
a plain `npm install` prunes on any other platform — that alone fails the build
with `Cannot find module 'dmg-license'` before packaging even starts.
Force-installing it —

```
npm install --no-save --force --os=darwin --cpu=x64 dmg-license
```

gets past that, but its own dependency `iconv-corefoundation` ships a **native
Mach-O binary** (compiled for Darwin), which fails immediately on Linux with
`invalid ELF header`. There is no further workaround short of building on an
actual Mac, or setting up real cross-compilation tooling, which this project
does not have.
