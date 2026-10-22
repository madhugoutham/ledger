// Ledger — a static page that reads GitHub from your browser with your token.
import {
  DEFAULT_ORGS, WEIGHTS, isBot, normalizeLogin, normalizeOrg, windowBounds,
  splitWindow, groupByAuthor, score, weeklyBuckets, sparklinePath, fmt, sortRows, relativeTime
} from "./lib.js";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TOKEN_KEY = "ledger.githubToken";
const SESSION_KEY = "ledger.sessionToken";
const ORGS_KEY = "ledger.orgs";
const RECENT_KEY = "ledger.recentLogins";
const THEME_KEY = "ledger.theme";
const CACHE_PREFIX = "ledger.cache.";
const CACHE_TTL_MS = 30 * 60 * 1000;
const RATE_FLOOR = 150;
const TOP_ENRICH = 50;            // leaderboard rows enriched with reviews/issues/commits
const ENRICH_BATCH = 10;          // users per contributionsCollection request
const SEARCH_CAP = 1000;          // GitHub search returns at most 1,000 results per query
const DEMO = new URLSearchParams(location.search).has("demo") || (() => { try { return sessionStorage.getItem("ledger.demo") === "1"; } catch { return false; } })();

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const state = {
  token: "",
  remember: false,
  orgs: store.get(ORGS_KEY, DEFAULT_ORGS),
  active: new Set(),
  days: 90,
  rate: { remaining: null, limit: null, reset: 0 },
  view: "person",
  login: "",
  person: null,            // { user, orgs: { [org]: { totals, rows } } }
  board: {},               // { [org]: { rows, enriched, slices, truncated } }
  boardOrg: null,
  boardSort: { key: "score", dir: "desc" },
  boardFilter: "",
  loading: { person: false, board: false }
};
state.active = new Set(state.orgs);

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- GitHub ----------
function authHeaders() {
  return { Authorization: `Bearer ${state.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION };
}

function throttled() {
  const r = state.rate;
  return r.remaining !== null && r.remaining < RATE_FLOOR && Date.now() < r.reset;
}

async function gql(query, variables = {}) {
  if (DEMO) return demoGql(query, variables);
  if (!state.token) throw new Error("Connect a GitHub token first.");
  if (throttled()) throw new Error(`API quota is nearly used up; it resets ${relativeReset()}.`);
  const response = await fetch(`${API_ROOT}/graphql`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    state.rate = {
      remaining: Number(remaining),
      limit: Number(response.headers.get("x-ratelimit-limit")),
      reset: Number(response.headers.get("x-ratelimit-reset")) * 1000
    };
    renderRate();
  }
  if (response.status === 401) { signOut("GitHub rejected the token."); throw new Error("GitHub rejected the token."); }
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.data) {
    throw new Error(json?.errors?.[0]?.message || json?.message || `${response.status} ${response.statusText}`);
  }
  if (json.errors?.length) console.warn("GraphQL partial errors", json.errors);
  return json.data;
}

async function rest(path) {
  if (DEMO) return demoRest(path);
  const response = await fetch(`${API_ROOT}${path}`, { headers: authHeaders() });
  if (response.status === 401) { signOut("GitHub rejected the token."); throw new Error("GitHub rejected the token."); }
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.message || `${response.status} ${response.statusText}`);
  return json;
}

function relativeReset() {
  const s = Math.max(0, Math.round((state.rate.reset - Date.now()) / 60000));
  return s <= 1 ? "in about a minute" : `in ${s} minutes`;
}

// Simple cache: memory + localStorage with a TTL. Refresh bypasses it.
const mem = new Map();
function cacheKey(parts) { return CACHE_PREFIX + parts.join("|"); }
function cacheGet(key) {
  const hit = mem.get(key) || store.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) { mem.set(key, hit); return hit.v; }
  return null;
}
function cacheSet(key, v) { const rec = { t: Date.now(), v }; mem.set(key, rec); store.set(key, rec); }

// Run async jobs with a concurrency limit (search pages, enrichment batches).
async function pool(jobs, limit = 4) {
  const results = new Array(jobs.length);
  let i = 0;
  async function worker() {
    while (i < jobs.length) { const idx = i++; results[idx] = await jobs[idx](); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

// ---------- queries ----------
const PR_FIELDS = `
  ... on PullRequest {
    number title url state isDraft createdAt closedAt mergedAt
    additions deletions
    author { login __typename ... on User { avatarUrl } }
    repository { nameWithOwner isFork }
  }`;

const SEARCH_PRS = `
query($q: String!, $first: Int!, $after: String) {
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${PR_FIELDS} }
  }
}`;

const SEARCH_ISSUES = `
query($q: String!, $first: Int!, $after: String) {
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { number title url state createdAt closedAt repository { nameWithOwner isFork } } }
  }
}`;

const CONTRIB_FIELDS = `
  commitContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner isFork } contributions { totalCount } }
  pullRequestContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner isFork } contributions { totalCount } }
  pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner isFork } contributions { totalCount } }
  issueContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner isFork } contributions { totalCount } }`;

function userQuery() {
  return `query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) { login name avatarUrl url c: contributionsCollection(from: $from, to: $to) { ${CONTRIB_FIELDS} } }
  }`;
}

// Sum a by-repository list for one org (repository owner, case-insensitive).
function sumForOrg(list, org) {
  const o = org.toLowerCase();
  return list.filter((x) => x.repository.nameWithOwner.split("/")[0].toLowerCase() === o);
}

function enrichQuery(logins) {
  const blocks = logins.map((l, i) => `u${i}: user(login: ${JSON.stringify(l)}) {
    login avatarUrl
    c: contributionsCollection(from: $from, to: $to) {
      pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } contributions { totalCount } }
      issueContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } contributions { totalCount } }
      commitContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } contributions { totalCount } }
    }
  }`).join("\n");
  return `query($from: DateTime!, $to: DateTime!) { ${blocks} }`;
}

// Paginate a search until done or until the 1,000-result cap.
async function searchAll(query, q, { first = 100, onPage } = {}) {
  const nodes = [];
  let after = null, issueCount = 0;
  for (let page = 0; page < 10; page++) {
    const data = await gql(query, { q, first, after });
    const s = data.search;
    issueCount = s.issueCount;
    nodes.push(...s.nodes.filter(Boolean));
    onPage?.(nodes.length, issueCount);
    if (!s.pageInfo.hasNextPage) break;
    after = s.pageInfo.endCursor;
  }
  return { nodes, issueCount, truncated: issueCount > nodes.length };
}

// ---------- person ----------
async function loadPerson(login, { refresh = false } = {}) {
  const orgs = [...state.active];
  if (!orgs.length) throw new Error("Pick at least one organization.");
  const key = cacheKey(["person", login, orgs.join(","), state.days]);
  if (!refresh) { const hit = cacheGet(key); if (hit) return hit; }

  const w = windowBounds(state.days);
  const data = await gql(userQuery(), { login, from: w.from, to: w.to });
  if (!data.user) throw new Error(`No GitHub user named "${login}".`);
  const all = data.user.c;

  const perOrg = {};
  const jobs = [];
  orgs.forEach((org) => {
    const c = {
      commitContributionsByRepository: sumForOrg(all.commitContributionsByRepository, org),
      pullRequestReviewContributionsByRepository: sumForOrg(all.pullRequestReviewContributionsByRepository, org),
      issueContributionsByRepository: sumForOrg(all.issueContributionsByRepository, org)
    };
    const total = (list) => list.reduce((n, x) => n + x.contributions.totalCount, 0);
    const rows = new Map();
    const row = (name, isFork) => {
      let r = rows.get(name);
      if (!r) { r = { repo: name, isFork: !!isFork, merged: 0, open: 0, closed: 0, reviews: 0, issues: 0, commits: 0, additions: 0, deletions: 0, prs: [], issueList: [] }; rows.set(name, r); }
      return r;
    };
    for (const x of c.commitContributionsByRepository) row(x.repository.nameWithOwner, x.repository.isFork).commits = x.contributions.totalCount;
    for (const x of c.pullRequestReviewContributionsByRepository) row(x.repository.nameWithOwner, x.repository.isFork).reviews = x.contributions.totalCount;
    for (const x of c.issueContributionsByRepository) row(x.repository.nameWithOwner, x.repository.isFork).issues = x.contributions.totalCount;
    perOrg[org] = {
      totals: { merged: 0, open: 0, closed: 0, reviews: total(c.pullRequestReviewContributionsByRepository), issues: total(c.issueContributionsByRepository), commits: total(c.commitContributionsByRepository), additions: 0, deletions: 0 },
      rows, mergedAt: [], truncated: false
    };
    const base = `is:pr author:${login} org:${org}`;
    const queries = [
      ["merged", `${base} is:merged merged:${w.fromDay}..${w.toDay}`],
      ["open", `${base} is:open`],
      ["closed", `${base} is:closed is:unmerged closed:${w.fromDay}..${w.toDay}`]
    ];
    for (const [kind, q] of queries) {
      jobs.push(async () => {
        const res = await searchAll(SEARCH_PRS, q);
        const o = perOrg[org];
        if (res.truncated) o.truncated = true;
        for (const pr of res.nodes) {
          if (pr.repository?.isFork) continue;
          const r = row(pr.repository.nameWithOwner, false);
          r[kind] += 1;
          r.prs.push({ ...pr, kind });
          o.totals[kind] += 1;
          if (kind === "merged") {
            r.additions += pr.additions || 0; r.deletions += pr.deletions || 0;
            o.totals.additions += pr.additions || 0; o.totals.deletions += pr.deletions || 0;
            o.mergedAt.push(pr.mergedAt);
          }
        }
      });
    }
    jobs.push(async () => {
      const res = await searchAll(SEARCH_ISSUES, `is:issue author:${login} org:${org} created:${w.fromDay}..${w.toDay}`);
      for (const is of res.nodes) {
        if (is.repository?.isFork) continue;
        row(is.repository.nameWithOwner, false).issueList.push(is);
      }
    });
  });
  await pool(jobs, 4);

  for (const org of orgs) {
    const o = perOrg[org];
    o.rows = [...o.rows.values()].filter((r) => !r.isFork && (r.merged || r.open || r.closed || r.reviews || r.issues || r.commits));
    for (const r of o.rows) r.prs.sort((a, b) => Date.parse(b.mergedAt || b.closedAt || b.createdAt) - Date.parse(a.mergedAt || a.closedAt || a.createdAt));
    o.rows = sortRows(o.rows, "merged");
  }
  const result = { user: { login: data.user.login, name: data.user.name, avatarUrl: data.user.avatarUrl, url: data.user.url }, orgs: perOrg, window: w, days: state.days, fetchedAt: Date.now() };
  cacheSet(key, result);
  return result;
}

// ---------- leaderboard ----------
async function countMerged(org, fromDay, toDay) {
  const data = await gql(SEARCH_PRS, { q: `is:pr is:merged org:${org} merged:${fromDay}..${toDay}`, first: 1, after: null });
  return data.search.issueCount;
}

// Split the window until each slice holds fewer than 1,000 merged PRs.
async function planSlices(org, fromDay, toDay, onProgress) {
  const n = await countMerged(org, fromDay, toDay);
  onProgress?.(`Counting merged PRs ${fromDay}..${toDay}: ${n}`);
  if (n < SEARCH_CAP) return [{ fromDay, toDay, count: n }];
  const halves = splitWindow(fromDay, toDay);
  if (!halves) return [{ fromDay, toDay, count: n, over: true }];
  const [a, b] = halves;
  const left = await planSlices(org, a[0], a[1], onProgress);
  const right = await planSlices(org, b[0], b[1], onProgress);
  return [...left, ...right];
}

async function loadBoard(org, { refresh = false, onProgress } = {}) {
  const key = cacheKey(["board", org, state.days]);
  if (!refresh) { const hit = cacheGet(key); if (hit) return hit; }
  const w = windowBounds(state.days);
  const slices = await planSlices(org, w.fromDay, w.toDay, onProgress);
  const total = slices.reduce((s, x) => s + x.count, 0);
  let got = 0;
  const pages = await pool(slices.map((sl) => async () => {
    if (!sl.count) return { nodes: [], truncated: false };
    const res = await searchAll(SEARCH_PRS, `is:pr is:merged org:${org} merged:${sl.fromDay}..${sl.toDay}`, {
      onPage: (n) => { onProgress?.(`Reading merged PRs: ${got + n} of ${total}`); }
    });
    got += res.nodes.length;
    return res;
  }), 3);
  const nodes = pages.flatMap((p) => p.nodes);
  const truncated = pages.some((p) => p.truncated) || slices.some((s) => s.over);
  const grouped = groupByAuthor(nodes);
  let rows = [...grouped.values()].map((r) => ({
    login: r.login, avatarUrl: r.avatarUrl, merged: r.merged, additions: r.additions, deletions: r.deletions,
    repos: r.repos.size, mergedAt: r.mergedAt, reviews: null, issues: null, commits: null, enriched: false
  }));
  rows = sortRows(rows, "merged");
  const board = { org, rows, window: w, days: state.days, truncated, fetchedAt: Date.now(), totalMerged: nodes.length };
  await enrichBoard(board, 0, TOP_ENRICH, onProgress);
  finalizeBoard(board);
  cacheSet(key, board);
  return board;
}

async function enrichBoard(board, start, count, onProgress) {
  const targets = board.rows.slice(start, start + count).filter((r) => !r.enriched);
  if (!targets.length) return;
  const batches = [];
  for (let i = 0; i < targets.length; i += ENRICH_BATCH) batches.push(targets.slice(i, i + ENRICH_BATCH));
  let done = 0;
  await pool(batches.map((batch) => async () => {
    const data = await gql(enrichQuery(batch.map((r) => r.login)), { from: board.window.from, to: board.window.to });
    const total = (list) => sumForOrg(list, board.org).reduce((n, x) => n + x.contributions.totalCount, 0);
    batch.forEach((r, i) => {
      const u = data[`u${i}`];
      if (!u) { r.enriched = true; return; }
      r.avatarUrl = r.avatarUrl || u.avatarUrl;
      r.reviews = total(u.c.pullRequestReviewContributionsByRepository);
      r.issues = total(u.c.issueContributionsByRepository);
      r.commits = total(u.c.commitContributionsByRepository);
      r.enriched = true;
    });
    done += batch.length;
    onProgress?.(`Adding reviews and issues: ${Math.min(done, targets.length)} of ${targets.length}`);
  }), 3);
}

function finalizeBoard(board) {
  for (const r of board.rows) r.score = score({ merged: r.merged, reviews: r.reviews || 0, issues: r.issues || 0 });
  board.rows = sortRows(board.rows, "score");
  board.rows.forEach((r, i) => { r.rank = i + 1; });
}

// ---------- demo ----------
function demoGql(query, variables) {
  const D = window.LEDGER_DEMO;
  return new Promise((resolve) => setTimeout(() => resolve(D.gql(query, variables)), 120));
}
function demoRest(path) { return Promise.resolve(window.LEDGER_DEMO.rest(path)); }

// ---------- rendering ----------
function bar(value, max, cls) {
  const p = max ? Math.min(1, value / max) : 0;
  return `<td class="num bar ${cls}" style="--p:${p.toFixed(3)}"><span>${fmt(value)}</span></td>`;
}

function spark(timestamps, w) {
  const vals = weeklyBuckets(timestamps, w.from, w.to);
  const { d, last } = sparklinePath(vals, 96, 28);
  if (!vals.some(Boolean)) return "";
  return `<svg class="spark" width="96" height="28" viewBox="0 0 96 28" role="img" aria-label="Merged PRs per week: ${vals.join(", ")}"><path d="${d}"/>${last ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2"/>` : ""}</svg>`;
}

function linesCell(a, d) {
  if (!a && !d) return `<td class="num lines hide-sm">—</td>`;
  return `<td class="num lines hide-sm"><span class="plus">+${fmt(a)}</span> <span class="minus">−${fmt(d)}</span></td>`;
}

function renderPerson() {
  const el = $("#view-person");
  if (state.loading.person) { el.innerHTML = skeleton("Reading contributions…"); return; }
  if (!state.person) {
    el.innerHTML = state.token || DEMO
      ? `<p class="notice">Enter a GitHub username above to see their merged pull requests, reviews and issues per repository.</p>`
      : connectNotice();
    return;
  }
  const p = state.person;
  const grand = { merged: 0, open: 0, reviews: 0, issues: 0, commits: 0, additions: 0, deletions: 0 };
  const allMerged = [];
  for (const o of Object.values(p.orgs)) {
    for (const k of Object.keys(grand)) grand[k] += o.totals[k] || 0;
    allMerged.push(...o.mergedAt);
  }
  const stale = Date.now() - p.fetchedAt > 60000 ? ` · fetched ${relativeTime(new Date(p.fetchedAt).toISOString())}` : "";
  let html = `
    <div class="person-head">
      <img class="avatar" src="${esc(p.user.avatarUrl)}" alt="">
      <div>
        <div class="person-name">${esc(p.user.name || p.user.login)}</div>
        <div class="person-login"><a href="${esc(p.user.url)}" target="_blank" rel="noopener">@${esc(p.user.login)}</a> · last ${p.days} days${stale}
          · <button class="ghost" type="button" data-action="refresh-person" style="padding:0 4px">Refresh</button></div>
      </div>
    </div>
    <div class="totals">
      <div class="total hero"><div class="val">${fmt(grand.merged)}</div><div class="lbl">merged PRs</div>${spark(allMerged, p.window)}</div>
      <div class="total"><div class="val">${fmt(grand.reviews)}</div><div class="lbl">reviews</div></div>
      <div class="total"><div class="val">${fmt(grand.issues)}</div><div class="lbl">issues opened</div></div>
      <div class="total"><div class="val">${fmt(grand.open)}</div><div class="lbl">PRs open now</div></div>
      <div class="total"><div class="val">${fmt(grand.commits)}</div><div class="lbl">commits</div></div>
    </div>`;

  for (const [org, o] of Object.entries(p.orgs)) {
    const t = o.totals;
    const maxM = Math.max(1, ...o.rows.map((r) => r.merged));
    const maxR = Math.max(1, ...o.rows.map((r) => r.reviews));
    const maxI = Math.max(1, ...o.rows.map((r) => r.issues));
    html += `
      <section class="org-section">
        <div class="org-head">
          <h2><a href="https://github.com/${esc(org)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(org)}</a></h2>
          <div class="org-sum">
            <span><b>${fmt(t.merged)}</b> merged</span><span><b>${fmt(t.reviews)}</b> reviews</span>
            <span><b>${fmt(t.issues)}</b> issues</span><span><b>${fmt(t.open)}</b> open</span>
            <span><b>${fmt(t.commits)}</b> commits</span>
            <span class="hide-sm"><span class="plus" style="color:var(--issue)">+${fmt(t.additions)}</span> <span style="color:var(--open)">−${fmt(t.deletions)}</span></span>
          </div>
        </div>`;
    if (!o.rows.length) {
      html += `<p class="notice">No activity in ${esc(org)} in the last ${p.days} days.</p></section>`;
      continue;
    }
    if (o.truncated) html += `<p class="notice">More than 1,000 matches in one list; only the first 1,000 are shown. Shorten the window for an exact count.</p>`;
    html += `<div class="table-wrap"><table><thead><tr>
        <th class="repo">Repository</th><th class="num">Merged</th><th class="num hide-sm">Open</th><th class="num">Reviews</th><th class="num">Issues</th><th class="num hide-sm">Commits</th><th class="num hide-sm">Lines</th>
      </tr></thead><tbody>`;
    for (const r of o.rows) {
      const hasDetail = r.prs.length || r.issueList.length;
      const short = r.repo.split("/")[1] || r.repo;
      html += `<tr class="${hasDetail ? "expandable" : ""}" ${hasDetail ? 'aria-expanded="false" tabindex="0"' : ""} data-repo="${esc(r.repo)}">
        <td class="repo" title="${esc(r.repo)}"><a href="https://github.com/${esc(r.repo)}" target="_blank" rel="noopener" tabindex="-1">${esc(short)}</a></td>
        ${bar(r.merged, maxM, "merged")}
        <td class="num hide-sm">${r.open ? fmt(r.open) : "—"}</td>
        ${bar(r.reviews, maxR, "review")}
        ${bar(r.issues, maxI, "issue")}
        <td class="num hide-sm">${r.commits ? fmt(r.commits) : "—"}</td>
        ${linesCell(r.additions, r.deletions)}
      </tr>`;
      if (hasDetail) {
        html += `<tr class="detail" hidden data-detail="${esc(r.repo)}"><td colspan="7"><ul class="prs">`;
        for (const pr of r.prs) {
          const when = pr.mergedAt || pr.closedAt || pr.createdAt;
          html += `<li><span class="st ${pr.kind}">${pr.kind}${pr.isDraft ? " · draft" : ""}</span>
            <a class="t" href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number} ${esc(pr.title)}</a>
            <span class="l">+${fmt(pr.additions)} −${fmt(pr.deletions)}</span>
            <span class="d">${when ? isoDate(when) : ""}</span></li>`;
        }
        for (const is of r.issueList) {
          html += `<li><span class="st ${is.state === "OPEN" ? "open" : "closed"}">issue</span>
            <a class="t" href="${esc(is.url)}" target="_blank" rel="noopener">#${is.number} ${esc(is.title)}</a>
            <span class="l"></span><span class="d">${isoDate(is.createdAt)}</span></li>`;
        }
        html += `</ul></td></tr>`;
      }
    }
    html += `</tbody></table></div></section>`;
  }
  el.innerHTML = html;
  requestAnimationFrame(() => el.classList.add("is-ready"));
}

function isoDate(s) { return String(s).slice(0, 10); }

function renderBoard() {
  const el = $("#view-board");
  const orgs = [...state.active];
  if (!orgs.length) { el.innerHTML = `<p class="notice">Pick at least one organization.</p>`; return; }
  if (!state.boardOrg || !orgs.includes(state.boardOrg)) state.boardOrg = orgs[0];
  const org = state.boardOrg;
  const board = state.board[org];
  let html = `<div class="board-tools">
      <div class="seg" role="group" aria-label="Organization">${orgs.map((o) => `<button type="button" data-board-org="${esc(o)}" aria-pressed="${o === org}">${esc(o)}</button>`).join("")}</div>
      <input type="search" id="board-filter" placeholder="Filter by login" value="${esc(state.boardFilter)}" aria-label="Filter by login">
      <span class="spacer"></span>
      <span class="status" id="board-status">${board ? `${fmt(board.totalMerged)} merged PRs · ${board.rows.length} people · last ${board.days} days` : ""}</span>
      <button class="ghost" type="button" data-action="refresh-board">${board ? "Refresh" : "Load"}</button>
    </div>`;
  if (state.loading.board) { el.innerHTML = html + `<p class="progress" id="board-progress">Starting…</p>` + skeleton(); return; }
  if (!board) {
    el.innerHTML = html + (state.token || DEMO
      ? `<p class="notice">Everyone who merged a pull request in <b>${esc(org)}</b> in the selected window, ranked by score (merged ×${WEIGHTS.merged}, reviews ×${WEIGHTS.reviews}, issues ×${WEIGHTS.issues}).<br><button class="primary" type="button" data-action="refresh-board">Load leaderboard</button></p>`
      : connectNotice());
    return;
  }
  const me = state.login;
  const mine = me && board.rows.find((r) => r.login.toLowerCase() === me);
  if (me) {
    html += mine
      ? `<p class="me-note"><b>@${esc(mine.login)}</b> is #${mine.rank} of ${board.rows.length} in ${esc(org)} with ${fmt(mine.merged)} merged PRs.</p>`
      : `<p class="me-note"><b>@${esc(me)}</b> has no merged PRs in ${esc(org)} in this window.</p>`;
  }
  if (board.truncated) html += `<p class="notice">GitHub search capped one of the date slices at 1,000 results; counts for busy days may be low.</p>`;
  const f = state.boardFilter.trim().toLowerCase();
  let rows = f ? board.rows.filter((r) => r.login.toLowerCase().includes(f)) : board.rows;
  rows = sortRows(rows, state.boardSort.key, state.boardSort.dir);
  const maxS = Math.max(1, ...board.rows.map((r) => r.score));
  const maxM = Math.max(1, ...board.rows.map((r) => r.merged));
  const maxR = Math.max(1, ...board.rows.map((r) => r.reviews || 0));
  const maxI = Math.max(1, ...board.rows.map((r) => r.issues || 0));
  const th = (key, label, cls = "num") => {
    const s = state.boardSort.key === key ? (state.boardSort.dir === "desc" ? "descending" : "ascending") : "none";
    return `<th class="${cls}"><button type="button" data-sort="${key}" aria-sort="${s}">${label}</button></th>`;
  };
  html += `<div class="table-wrap"><table><thead><tr>
      <th class="rank">#</th><th class="who">Contributor</th>${th("score", "Score")}${th("merged", "Merged")}${th("reviews", "Reviews")}${th("issues", "Issues")}${th("commits", "Commits", "num hide-sm")}${th("repos", "Repos", "num hide-sm")}<th class="wk hide-sm">Weekly</th><th class="num hide-sm">Lines</th>
    </tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr class="${mine && r.login === mine.login ? "me" : ""}">
      <td class="rank num">${r.rank}</td>
      <td class="who"><a href="https://github.com/${esc(r.login)}" target="_blank" rel="noopener"><img class="avatar sm" src="${esc(r.avatarUrl || `https://github.com/${r.login}.png?size=48`)}" alt="" loading="lazy">${esc(r.login)}</a></td>
      ${bar(r.score, maxS, "score")}
      ${bar(r.merged, maxM, "merged")}
      ${r.enriched ? bar(r.reviews, maxR, "review") : `<td class="num muted">…</td>`}
      ${r.enriched ? bar(r.issues, maxI, "issue") : `<td class="num muted">…</td>`}
      <td class="num hide-sm">${r.enriched ? fmt(r.commits) : "…"}</td>
      <td class="num hide-sm">${fmt(r.repos)}</td>
      <td class="wk hide-sm">${spark(r.mergedAt, board.window)}</td>
      ${linesCell(r.additions, r.deletions)}
    </tr>`;
  }
  html += `</tbody></table></div>`;
  const pending = board.rows.filter((r) => !r.enriched).length;
  if (pending) html += `<p class="more muted">Reviews, issues and commits are loaded for the top ${TOP_ENRICH}. <button class="ghost" type="button" data-action="enrich-more">Load ${Math.min(TOP_ENRICH, pending)} more</button></p>`;
  el.innerHTML = html;
  requestAnimationFrame(() => el.classList.add("is-ready"));
}

function skeleton(label = "") {
  return `${label ? `<p class="progress">${esc(label)}</p>` : ""}<div class="skeleton" aria-busy="true" aria-label="Loading"><i></i><i></i><i></i><i></i><i></i><i></i></div>`;
}

function connectNotice() {
  return `<p class="notice">Connect a GitHub token to read live data. <button class="primary" type="button" data-action="connect">Connect to GitHub</button>
    <br><button class="ghost" type="button" data-action="demo">Or look at the demo with sample data</button></p>`;
}

function renderOrgs() {
  const nav = $("#orgs");
  nav.innerHTML = state.orgs.map((o) => `<button type="button" class="chip" data-org="${esc(o)}" aria-pressed="${state.active.has(o)}">${esc(o)}${DEFAULT_ORGS.includes(o) ? "" : `<span class="x" data-remove="${esc(o)}" title="Remove">×</span>`}</button>`).join("")
    + `<button type="button" class="chip add" data-action="add-org">+ org</button>`;
}

function renderRate() {
  const b = $("#rate");
  if (DEMO) { b.textContent = "Demo data"; return; }
  if (state.rate.remaining === null) { b.textContent = state.token ? "API —" : "API"; b.classList.remove("low"); return; }
  b.textContent = `API ${fmt(state.rate.remaining)} / ${fmt(state.rate.limit)}`;
  b.title = `GraphQL points left this hour; resets ${relativeReset()}`;
  b.classList.toggle("low", state.rate.remaining < RATE_FLOOR);
}

function renderAccount() {
  const b = $("#account");
  b.textContent = DEMO ? "Exit demo" : state.token ? "Sign out" : "Connect";
}

function renderView() {
  $("#tab-person").setAttribute("aria-selected", state.view === "person");
  $("#tab-board").setAttribute("aria-selected", state.view === "board");
  $("#view-person").hidden = state.view !== "person";
  $("#view-board").hidden = state.view !== "board";
  if (state.view === "person") renderPerson(); else renderBoard();
}

// ---------- actions ----------
async function showPerson(raw, { refresh = false } = {}) {
  const login = normalizeLogin(raw);
  if (!login) return;
  state.login = login;
  $("#login").value = login;
  pushRecent(login);
  state.view = "person";
  state.loading.person = true;
  renderView();
  try {
    state.person = await loadPerson(login, { refresh });
  } catch (e) {
    state.person = null;
    state.loading.person = false;
    $("#view-person").innerHTML = `<p class="notice error">${esc(e.message)}</p>`;
    renderView();
    $("#view-person").innerHTML = `<p class="notice error">${esc(e.message)}</p>`;
    return;
  }
  state.loading.person = false;
  renderView();
}

async function showBoard({ refresh = false } = {}) {
  const org = state.boardOrg || [...state.active][0];
  if (!org) return;
  state.boardOrg = org;
  state.loading.board = true;
  renderView();
  const progress = (msg) => { const p = $("#board-progress"); if (p) p.textContent = msg; };
  try {
    state.board[org] = await loadBoard(org, { refresh, onProgress: progress });
  } catch (e) {
    state.loading.board = false;
    renderView();
    $("#view-board").insertAdjacentHTML("beforeend", `<p class="notice error">${esc(e.message)}</p>`);
    return;
  }
  state.loading.board = false;
  renderView();
}

async function enrichMore() {
  const board = state.board[state.boardOrg];
  if (!board) return;
  const start = board.rows.findIndex((r) => !r.enriched);
  const btn = $('[data-action="enrich-more"]');
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    await enrichBoard(board, start, TOP_ENRICH);
    finalizeBoard(board);
    cacheSet(cacheKey(["board", board.org, board.days]), board);
  } catch (e) {
    $("#view-board").insertAdjacentHTML("beforeend", `<p class="notice error">${esc(e.message)}</p>`);
  }
  renderBoard();
}

function pushRecent(login) {
  const list = store.get(RECENT_KEY, []).filter((x) => x !== login);
  list.unshift(login);
  store.set(RECENT_KEY, list.slice(0, 12));
  $("#recent-logins").innerHTML = list.slice(0, 12).map((l) => `<option value="${esc(l)}">`).join("");
}

function setTheme(next) {
  if (next) { document.documentElement.setAttribute("data-theme", next); store.set(THEME_KEY, next); }
  else { document.documentElement.removeAttribute("data-theme"); store.del(THEME_KEY); }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  setTheme(cur === "dark" ? "light" : "dark");
}

async function connect(token, remember) {
  state.token = token.trim();
  const me = await rest("/user");
  state.remember = remember;
  if (remember) { store.set(TOKEN_KEY, state.token); sessionStorage.removeItem(SESSION_KEY); }
  else { sessionStorage.setItem(SESSION_KEY, state.token); store.del(TOKEN_KEY); }
  renderAccount(); renderRate();
  if (!$("#login").value && me?.login) $("#login").value = me.login;
  renderView();
}

function signOut(reason) {
  state.token = ""; state.rate = { remaining: null, limit: null, reset: 0 };
  store.del(TOKEN_KEY); try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  state.person = null; state.board = {};
  renderAccount(); renderRate(); renderView();
  if (reason) $("#ask-hint").textContent = reason;
}

function addOrg() {
  const nav = $("#orgs");
  const btn = nav.querySelector('[data-action="add-org"]');
  if (!btn) return;
  const input = document.createElement("input");
  input.className = "chip";
  input.placeholder = "org login";
  input.setAttribute("aria-label", "Organization to add");
  input.size = 14;
  btn.replaceWith(input);
  input.focus();
  const finish = (commit) => {
    const org = commit ? normalizeOrg(input.value) : "";
    if (org) {
      if (!state.orgs.includes(org)) state.orgs.push(org);
      state.active.add(org);
      store.set(ORGS_KEY, state.orgs);
    }
    renderOrgs();
    if (org) afterScopeChange();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
}

function afterScopeChange() {
  state.person = null;
  if (state.login) showPerson(state.login); else renderView();
}

// ---------- wiring ----------
function init() {
  state.token = store.get(TOKEN_KEY, "") || (() => { try { return sessionStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } })();
  state.remember = Boolean(store.get(TOKEN_KEY, ""));
  $("#method-weights").textContent = `merged PRs × ${WEIGHTS.merged} + reviews × ${WEIGHTS.reviews} + issues opened × ${WEIGHTS.issues}`;
  renderOrgs(); renderAccount(); renderRate();
  $("#recent-logins").innerHTML = store.get(RECENT_KEY, []).map((l) => `<option value="${esc(l)}">`).join("");

  $("#ask-form").addEventListener("submit", (e) => { e.preventDefault(); showPerson($("#login").value); });
  $("#window").addEventListener("change", (e) => { state.days = Number(e.target.value); state.board = {}; afterScopeChange(); if (state.view === "board" && (state.token || DEMO)) showBoard(); });
  $("#theme").addEventListener("click", toggleTheme);
  $("#rate").addEventListener("click", () => { $("#ask-hint").textContent = DEMO ? "Sample data; no GitHub requests are made in the demo." : state.rate.remaining === null ? "No GitHub requests made yet." : `${state.rate.remaining} of ${state.rate.limit} GraphQL points left this hour; resets ${relativeReset()}.`; });
  $("#account").addEventListener("click", () => {
    if (DEMO) { try { sessionStorage.removeItem("ledger.demo"); } catch { /* ignore */ } location.href = location.pathname; return; }
    if (state.token) signOut(); else openTokenDialog();
  });
  $("#tab-person").addEventListener("click", () => { state.view = "person"; renderView(); });
  $("#tab-board").addEventListener("click", () => { state.view = "board"; renderView(); if (!state.board[state.boardOrg || [...state.active][0]] && (state.token || DEMO)) showBoard(); });

  $("#orgs").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) { const o = rm.dataset.remove; state.orgs = state.orgs.filter((x) => x !== o); state.active.delete(o); store.set(ORGS_KEY, state.orgs); renderOrgs(); afterScopeChange(); return; }
    const chip = e.target.closest("[data-org]");
    if (chip) { const o = chip.dataset.org; if (state.active.has(o)) state.active.delete(o); else state.active.add(o); renderOrgs(); afterScopeChange(); return; }
    if (e.target.closest('[data-action="add-org"]')) addOrg();
  });

  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-action]");
    if (a) {
      const act = a.dataset.action;
      if (act === "connect") openTokenDialog();
      if (act === "demo") { try { sessionStorage.setItem("ledger.demo", "1"); } catch { /* ignore */ } location.reload(); }
      if (act === "refresh-person") showPerson(state.login, { refresh: true });
      if (act === "refresh-board") showBoard({ refresh: Boolean(state.board[state.boardOrg]) });
      if (act === "enrich-more") enrichMore();
      return;
    }
    const bo = e.target.closest("[data-board-org]");
    if (bo) { state.boardOrg = bo.dataset.boardOrg; renderBoard(); if (!state.board[state.boardOrg]) showBoard(); return; }
    const srt = e.target.closest("[data-sort]");
    if (srt) {
      const key = srt.dataset.sort;
      state.boardSort = state.boardSort.key === key ? { key, dir: state.boardSort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" };
      renderBoard(); return;
    }
    const row = e.target.closest("tr.expandable");
    if (row && !e.target.closest("a")) toggleRow(row);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.expandable")) { e.preventDefault(); toggleRow(e.target); }
    if (e.key === "/" && !/input|select|textarea/i.test(e.target.tagName)) { e.preventDefault(); $("#login").focus(); }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "board-filter") { state.boardFilter = e.target.value; const v = e.target.value; renderBoard(); const f = $("#board-filter"); f.value = v; f.focus(); f.setSelectionRange(v.length, v.length); }
  });

  // Token dialog
  const dlg = $("#token-dialog");
  $("#token-cancel").addEventListener("click", () => dlg.close());
  $("#token-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#token-error");
    err.hidden = true;
    $("#token-submit").disabled = true;
    try { await connect($("#token-input").value, $("#token-remember").checked); dlg.close(); $("#token-input").value = ""; }
    catch (ex) { state.token = ""; err.textContent = ex.message === "Bad credentials" ? "GitHub did not accept that token." : ex.message; err.hidden = false; }
    finally { $("#token-submit").disabled = false; }
  });

  window.addEventListener("storage", (e) => { if (e.key === TOKEN_KEY) { state.token = store.get(TOKEN_KEY, "") || ""; renderAccount(); renderView(); } });

  const params = new URLSearchParams(location.search);
  const u = params.get("u") || (DEMO ? window.LEDGER_DEMO.defaultLogin : "");
  renderView();
  if (u) showPerson(u);
}

function openTokenDialog() { $("#token-error").hidden = true; $("#token-dialog").showModal(); $("#token-input").focus(); }

function toggleRow(row) {
  const open = row.getAttribute("aria-expanded") === "true";
  row.setAttribute("aria-expanded", String(!open));
  const d = row.parentElement.querySelector(`tr.detail[data-detail="${CSS.escape(row.dataset.repo)}"]`);
  if (d) d.hidden = open;
}

init();
