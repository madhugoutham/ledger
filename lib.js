// Pure helpers shared by the page and the tests. No DOM, no fetch.

export const DEFAULT_ORGS = ["llm-d", "llm-d-incubation", "vllm-project", "opendatahub-io"];

// Published scoring weights. Composite across three dimensions (SPACE: never a
// single count), merged work only, bots excluded. Commits are shown but not
// scored: in squash-merge orgs one PR ≈ one commit, so they would double-count.
export const WEIGHTS = { merged: 3, reviews: 2, issues: 1 };

export const BOT_LOGINS = new Set([
  "dependabot", "dependabot[bot]", "github-actions", "github-actions[bot]",
  "renovate", "renovate[bot]", "mergify", "mergify[bot]", "copilot",
  "copilot-pull-request-reviewer", "openshift-ci", "openshift-ci[bot]",
  "openshift-merge-bot", "openshift-merge-bot[bot]", "red-hat-konflux",
  "red-hat-konflux[bot]", "pre-commit-ci", "pre-commit-ci[bot]", "codecov",
  "codecov[bot]", "allcontributors", "allcontributors[bot]", "k8s-ci-robot",
  "mergify-bot", "sonarcloud", "sonarcloud[bot]", "github-merge-queue[bot]"
]);

export function isBot(author) {
  if (!author) return true;
  if (author.__typename === "Bot") return true;
  const login = String(author.login || "").toLowerCase();
  return BOT_LOGINS.has(login) || login.endsWith("[bot]") || login.endsWith("-bot") || login.endsWith("-robot");
}

export function normalizeLogin(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^@/, "");
  const m = s.match(/github\.com\/([A-Za-z0-9-]+)/);
  if (m) s = m[1];
  s = s.replace(/[^A-Za-z0-9-]/g, "");
  return s.toLowerCase();
}

export function normalizeOrg(raw) {
  let s = String(raw || "").trim();
  const m = s.match(/github\.com\/([A-Za-z0-9-]+)/);
  if (m) s = m[1];
  return s.replace(/[^A-Za-z0-9-]/g, "");
}

// Window boundaries in UTC: [from, to] as ISO strings, plus the date-only
// strings GitHub search accepts. `days` back from `now` (end of that day).
export function windowBounds(days, now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  from.setUTCHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString(), fromDay: isoDay(from), toDay: isoDay(to) };
}

export function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// Split [fromDay, toDay] into two halves at the midpoint. Returns null when the
// window is a single day and cannot be split further.
export function splitWindow(fromDay, toDay) {
  const a = Date.parse(fromDay + "T00:00:00Z");
  const b = Date.parse(toDay + "T00:00:00Z");
  const days = Math.round((b - a) / 86400000) + 1;
  if (days <= 1) return null;
  const leftDays = Math.ceil(days / 2);
  const mid = new Date(a + (leftDays - 1) * 86400000);
  const next = new Date(mid.getTime() + 86400000);
  return [[fromDay, isoDay(mid)], [isoDay(next), toDay]];
}

// Group merged PR nodes (from search) by author login.
export function groupByAuthor(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (!n || !n.author || isBot(n.author)) continue;
    if (n.repository && n.repository.isFork) continue;
    const login = n.author.login;
    let row = map.get(login);
    if (!row) {
      row = { login, avatarUrl: n.author.avatarUrl || "", merged: 0, additions: 0, deletions: 0, repos: new Set(), mergedAt: [] };
      map.set(login, row);
    }
    row.merged += 1;
    row.additions += n.additions || 0;
    row.deletions += n.deletions || 0;
    if (n.repository) row.repos.add(n.repository.nameWithOwner);
    if (n.mergedAt) row.mergedAt.push(n.mergedAt);
  }
  return map;
}

export function score(row, w = WEIGHTS) {
  return (row.merged || 0) * w.merged + (row.reviews || 0) * w.reviews + (row.issues || 0) * w.issues;
}

// Count timestamps per ISO week bucket between from and to. Returns an array of
// counts, oldest first, with one entry per 7 days.
export function weeklyBuckets(timestamps, fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const n = Math.max(1, Math.ceil((to - from) / (7 * 86400000)));
  const out = new Array(n).fill(0);
  for (const t of timestamps) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms) || ms < from || ms > to) continue;
    const i = Math.min(n - 1, Math.floor((ms - from) / (7 * 86400000)));
    out[i] += 1;
  }
  return out;
}

// Build an SVG path for a sparkline. Tufte: word-sized, no frame, last value marked.
export function sparklinePath(values, width = 96, height = 28, pad = 2) {
  if (!values.length) return { d: "", last: null };
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad + i * stepX, height - pad - (v / max) * (height - pad * 2)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return { d, last: pts[pts.length - 1], max };
}

export function fmt(n) {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function sortRows(rows, key, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "string") return sign * av.localeCompare(bv);
    const d = (av ?? -Infinity) - (bv ?? -Infinity);
    return d !== 0 ? sign * d : a.login?.localeCompare(b.login) || 0;
  });
}

export function relativeTime(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  const d = Math.round(h / 24);
  if (d < 60) return d + "d ago";
  return Math.round(d / 30) + "mo ago";
}

// contributionsCollection accepts at most one year per call: split [from, to]
// into chunks of at most 365 days, oldest first.
export function yearChunks(fromIso, toIso) {
  const out = [];
  let a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  while (a <= b) {
    const end = Math.min(b, a + 365 * 86400000 - 1);
    out.push({ from: new Date(a).toISOString(), to: new Date(end).toISOString() });
    a = end + 1;
  }
  return out;
}
