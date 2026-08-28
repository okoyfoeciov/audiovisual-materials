# CLAUDE.md — audiovisual-materials

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
    "/home/james/audiovisual-materials/.githelpers/credential-from-env.sh"
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
2. **GitHub API calls** (creating repos, reading repo metadata, releases,
   issues): read the token out of `.env` and pass it explicitly.

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

`.gitignore` excludes `node_modules/` (~565 MB, reinstalled via `npm install`)
and `dist/` (electron-builder output). The two secret files (`.env`, and
anything matching it) must never be committed. Everything else — including
`build/icon.png` and `build/icons/`, which `package.json`'s `build.mac`/
`build.linux` config references directly — is tracked.

### About this project

An Electron desktop clone of comart's "Listen" audio playback feature,
repurposed to browse and play a personal media library (movies, audio,
podcasts) served by this app's own local backend rather than comart.
`app-listen.js` is the cloned page, adapted for the library; `app-base.js` is
the one file that resolves the API base URL (see its own header comment) —
originally comart's, now this app's own backend, tailscale-served, with the
same synchronous-`localStorage`-read shape comart's version used (adapted
from `chrome.storage`, since this page has no origin exemption comart's
extension gets). `main.js` is the Electron shell. Avoid changing
`app-listen.js` unless the task requires it — keep adaptations isolated to
`app-base.js`/`main.js` so the diff against comart's original stays legible.
