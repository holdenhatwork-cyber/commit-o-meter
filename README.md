# Commit-o-meter

**Live: <https://holdenhatwork-cyber.github.io/commit-o-meter/>**

A fun, zero-backend dashboard that answers one question: **how much code has this team actually shipped?**

Point it at a GitLab or GitHub repository and it draws an odometer of total commits, a
damage report of lines added and deleted, a year-long commit heatmap, a contributor
leaderboard, a language breakdown, and a short awards ceremony.

Built for a hackathon. Everything runs in the browser — there is no server, no database
and nothing is stored anywhere.

## Using it

Paste any of these into the box:

| Input | What it reads |
| --- | --- |
| `https://gitlab.nortal.com/group/project` | Self-hosted GitLab, via `/api/v4` |
| `https://gitlab.com/group/project` | GitLab SaaS |
| `facebook/react` or a full GitHub URL | GitHub, via `api.github.com` |

Deep links work too: `?repo=<url>` loads a repo straight away, so a dashboard can be shared.

### Private repos and rate limits

Open **"Private repo or rate-limited?"** and store an access token:

- **GitLab** — a personal access token with the `read_api` scope.
- **GitHub** — a classic token with *no scopes*; this lifts the anonymous limit of
  60 API calls per hour to 5,000.

Tokens are kept per host in the browser's `localStorage` and are sent only to that host's
API. They never reach the server hosting this page — which is a plain static file host and
has no way to receive them.

### Offline mode (the reliable fallback)

Corporate GitLab servers often refuse cross-origin browser requests, and a browser cannot
work around that. Offline mode sidesteps the network entirely: run

```
git log --numstat --date=iso-strict --pretty=format:"@|%H|%an|%aI"
```

in a clone of the repo, paste the output into the box at the bottom of the page, and you
get the same dashboard. This works for any repository, public or private, and nothing
leaves your machine.

Offline mode is in some ways the *better* source — it reads every commit directly, whereas
GitHub declines to report per-line statistics for very large repositories.

## Shared snapshots (private projects, no token for teammates)

A private project can be published as a static snapshot so anyone on the team can
open the page and see it without a token of their own.

`.github/workflows/refresh-data.yml` runs every 30 minutes on a GitHub runner. It
executes `scripts/fetch-snapshot.mjs`, which reads the `GITLAB_TOKEN` repository
secret, calls the GitLab API and writes `data/overseer.json`. The front end loads
that file instead of calling GitLab, unless the viewer has stored their own token —
in which case they get live data.

**The token never reaches a browser.** It is decrypted only inside the runner.

### What the snapshot contains, and what it cannot

The snapshot is *constructed* from named fields, never filtered or spread from the
API response. It contains only: commit counts, dates, lines added/deleted, author
display names, and language percentages.

It cannot contain source code — the only endpoints called are `/repository/commits`
with `with_stats=true` (which returns counts, not diffs) and `/languages`. No blob,
tree, file or diff endpoint is ever requested.

It must not contain commit messages, titles, SHAs, e-mail addresses or credentials.
`scripts/verify-snapshot.mjs` re-reads the finished file and fails the build if any
appear. It enforces a strict key allowlist, so a future change that starts copying
extra API fields through breaks the build rather than publishing quietly.

To point it at a different project, change `GITLAB_HOST` / `GITLAB_PROJECT` in the
workflow and the matching entry in the `SNAPSHOTS` map in `app.js`.

### Setting the secret

```
gh secret set GITLAB_TOKEN --repo <owner>/<repo>
```

Paste the value when prompted. Use a GitLab **project** access token (Reporter role,
`read_api` scope) rather than a personal one, so it is scoped to the single project.

Note that `read_api` also grants repository read — there is no stats-only scope in
GitLab. That is precisely why the token stays server-side.

## Where the numbers come from

| Source | Commits | Lines added/deleted | Languages |
| --- | --- | --- | --- |
| GitLab | every commit on the default branch (capped at 4,000) | per-commit `stats` | reported by GitLab |
| GitHub | `Link` header page count on `/commits` | `/stats/contributors` | tracked bytes |
| `git log` | every commit in the log | `--numstat` totals | added lines, by file extension |

Line counts measure *churn over the repo's history* — lines ever written and ever removed —
not the size of the current checkout. "Net lines shipped" is added minus deleted.

## Running it locally

No build step and no dependencies:

```
npx http-server -p 8899
```

Then open <http://127.0.0.1:8899>. Editing `index.html`, `styles.css` or `app.js` and
reloading is the whole development loop.

## Deployment

The site is three static files, so any static host works. It is published with GitHub
Pages from the `main` branch.

## Accessibility and design notes

- Colours follow a validated categorical palette; the added/deleted pair is distinguished
  by direction (up vs. down from a zero baseline) and by labels as well as by hue, so it
  stays readable for colourblind viewers.
- Every chart has hover and keyboard-focus tooltips, and the underlying weekly numbers are
  available as a table.
- Light and dark themes are both hand-picked, with a toggle that overrides the OS setting.
- `prefers-reduced-motion` disables the odometer animation.
