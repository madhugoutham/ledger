# Ledger

Who shipped what, per repo, per org. Enter a GitHub username and see their merged pull requests, reviews and issues in every repository of llm-d, vllm-project and opendatahub-io (or any org you add), consolidated per org. A second tab ranks everyone who merged a PR in an org over the last 30/90/180/365 days.

It is a static page that talks to the GitHub API from your browser, in the spirit of [pingboard](https://github.com/mgoin/pingboard): no server, no build step, no dependencies. Your token never leaves your browser.

## Run it

1. Open `index.html` directly, or serve the folder:

   ```
   python3 -m http.server 8080
   ```

2. Open http://localhost:8080 and press **Connect**.
3. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **no** repository access and **no** permissions. Public data is readable by default, and a token with nothing attached can do nothing else if it leaks. A classic token with no scopes works too.
4. Paste it. It is kept in `sessionStorage`, or in `localStorage` if you tick "Keep token after closing this tab".

To preview the layout with sample data, open `index.html?demo`. To deep-link a person, use `?u=login`.

## What it counts

| Column | Source |
| --- | --- |
| Merged | `search(type: ISSUE, "is:pr is:merged author:X org:Y merged:A..B")`, forks and bots excluded |
| Open / closed | same search with `is:open` / `is:closed is:unmerged closed:A..B` |
| Reviews, issues, commits | `user.contributionsCollection(organizationID:, from:, to:)` with per-repository breakdowns, so they match the profile graph |
| Lines | additions and deletions summed over merged PRs |
| Score | merged × 3 + reviews × 2 + issues × 1; weights are published on the page |

The leaderboard lists everyone who merged a PR in the window, not only org members. It reads merged PRs 100 at a time (1 GraphQL point per page), splitting the window in halves whenever a slice would exceed GitHub's 1,000-result search cap, then adds reviews/issues/commits for the top 50 in batches of 10 users per request. A full refresh of a busy org costs roughly 60–110 of your 5,000 hourly points; the quota and reset time are shown in the top bar, and loading pauses below 150 points.

Commits are shown but not scored: in squash-merge orgs one PR is one commit, so scoring both would count the same work twice.

This board is for seeing work, not grading people. Review and triage work is undercounted by every metric here; please do not use it for performance reviews, pay or promotion.

## Files

- `index.html`, `styles.css`, `app.js` — the page
- `lib.js` — pure helpers (window maths, bot filter, scoring, sparklines), shared with the tests
- `demo-data.js` — sample data for `?demo`
- `tests/lib.test.mjs` — unit tests (`node --test tests/lib.test.mjs`)
- `.github/workflows/pages.yml` — publishes the folder to GitHub Pages on every push to `main`

## Adding an org

Press **+ org** in the top bar and type the org login or URL. The list is kept in `localStorage`. Chips toggle which orgs are included in the person view; the leaderboard is always one org at a time.
