// Sample data for ?demo. Answers the same GraphQL/REST calls the page makes,
// so the whole UI can be previewed without a GitHub token. All logins and
// numbers here are invented.
(function () {
  const orgs = {
    "llm-d": { id: "O_demo_llmd", repos: ["llm-d/llm-d-inference-scheduler", "llm-d/llm-d", "llm-d/llm-d-kv-cache-manager", "llm-d/llm-d-deployer", "llm-d/llm-d-benchmark", "llm-d/llm-d-routing-sidecar"] },
    "vllm-project": { id: "O_demo_vllm", repos: ["vllm-project/vllm", "vllm-project/production-stack", "vllm-project/vllm-ascend", "vllm-project/llm-compressor", "vllm-project/guidellm"] },
    "opendatahub-io": { id: "O_demo_odh", repos: ["opendatahub-io/opendatahub-operator", "opendatahub-io/odh-dashboard", "opendatahub-io/kubeflow", "opendatahub-io/model-registry"] }
  };
  const people = ["mira-okoye", "tlindqvist", "rj-ferreira", "ana-cz", "devkapoor", "hsu-wei", "pnowak", "lena-bauer", "sato-k", "jbright", "omarh", "elise-m", "yusuf-a", "cgrant", "ivan-p", "noor-s", "tberg", "quinnd", "zhao-l", "frida-h"];
  const defaultLogin = "mira-okoye";

  // Deterministic pseudo-random so the demo looks the same every time.
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const titles = ["Fix KV cache eviction race", "Add latency predictor scoring", "Refactor scheduler plugin loading", "Support prefix-aware routing", "Bump controller-runtime", "Improve Prometheus labels", "Document deployer values", "Handle empty decode pool", "Add e2e test for P/D disagg", "Reduce allocations in router hot path", "Expose queue depth metric", "Fix flaky benchmark harness", "Add OpenTelemetry spans", "Tune defaults for H100", "Clean up Makefile targets"];

  const now = Date.now();
  const day = 86400000;
  const prs = []; // {org, repo, author, mergedAt, state, additions, deletions, number, title}
  let num = 4000;
  for (const [org, o] of Object.entries(orgs)) {
    const n = org === "vllm-project" ? 520 : org === "llm-d" ? 160 : 90;
    for (let i = 0; i < n; i++) {
      // Skewed: a few people do most of the work.
      const idx = Math.floor(Math.pow(rnd(), 2.2) * people.length);
      const author = people[idx];
      const ageDays = Math.floor(rnd() * 380);
      const state = rnd() < 0.86 ? "MERGED" : rnd() < 0.5 ? "OPEN" : "CLOSED";
      const t = new Date(now - ageDays * day - rnd() * day).toISOString();
      prs.push({
        org, repo: pick(o.repos), author, number: num++, title: pick(titles),
        state, createdAt: t, mergedAt: state === "MERGED" ? t : null, closedAt: state !== "OPEN" ? t : null,
        additions: Math.floor(rnd() * 600) + 2, deletions: Math.floor(rnd() * 240), isDraft: state === "OPEN" && rnd() < 0.2
      });
    }
  }
  // Mira works mostly on the scheduler and has a clear weekly rhythm.
  for (let i = 0; i < 26; i++) {
    const t = new Date(now - i * 4 * day - day).toISOString();
    prs.push({ org: "llm-d", repo: i % 3 ? "llm-d/llm-d-inference-scheduler" : "llm-d/llm-d", author: defaultLogin, number: num++, title: pick(titles), state: "MERGED", createdAt: t, mergedAt: t, closedAt: t, additions: 40 + i * 9, deletions: 10 + i * 2, isDraft: false });
  }
  const issues = [];
  for (const [org, o] of Object.entries(orgs)) {
    for (let i = 0; i < 40; i++) {
      const t = new Date(now - rnd() * 300 * day).toISOString();
      issues.push({ org, repo: pick(o.repos), author: pick(people), number: num++, title: "Investigate " + pick(titles).toLowerCase(), state: rnd() < 0.6 ? "CLOSED" : "OPEN", createdAt: t });
    }
  }

  function parseQ(q) {
    const get = (k) => (q.match(new RegExp(`(?:^|\\s)${k}:(\\S+)`)) || [])[1];
    const range = (k) => { const v = get(k); if (!v) return null; const [a, b] = v.split(".."); return [Date.parse(a + "T00:00:00Z"), Date.parse((b || a) + "T23:59:59Z")]; };
    return {
      isIssue: /is:issue/.test(q), org: get("org"), author: get("author"),
      merged: /is:merged/.test(q), open: /is:open/.test(q), unmerged: /is:unmerged/.test(q),
      mergedRange: range("merged"), closedRange: range("closed"), createdRange: range("created")
    };
  }
  const inRange = (t, r) => !r || (t && Date.parse(t) >= r[0] && Date.parse(t) <= r[1]);

  function searchNodes(q) {
    const f = parseQ(q);
    if (f.isIssue) {
      return issues.filter((x) => (!f.org || x.org === f.org) && (!f.author || x.author === f.author) && inRange(x.createdAt, f.createdRange))
        .map((x) => ({ number: x.number, title: x.title, url: `https://github.com/${x.repo}/issues/${x.number}`, state: x.state, createdAt: x.createdAt, closedAt: null, repository: { nameWithOwner: x.repo, isFork: false } }));
    }
    return prs.filter((x) => (!f.org || x.org === f.org) && (!f.author || x.author === f.author)
      && (!f.merged || x.state === "MERGED") && (!f.open || x.state === "OPEN") && (!f.unmerged || x.state === "CLOSED")
      && inRange(x.mergedAt, f.mergedRange) && inRange(x.closedAt, f.closedRange))
      .map((x) => ({ number: x.number, title: x.title, url: `https://github.com/${x.repo}/pull/${x.number}`, state: x.state, isDraft: x.isDraft, createdAt: x.createdAt, closedAt: x.closedAt, mergedAt: x.mergedAt, additions: x.additions, deletions: x.deletions, author: { login: x.author, __typename: "User", avatarUrl: avatar(x.author) }, repository: { nameWithOwner: x.repo, isFork: false } }));
  }
  function avatar(login) { return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' fill='hsl(${(login.length * 47) % 360},40%,55%)'/><text x='24' y='31' font-family='sans-serif' font-size='20' fill='white' text-anchor='middle'>${login[0].toUpperCase()}</text></svg>`); }

  function contributions(login, orgId, from, to) {
    const org = Object.keys(orgs).find((o) => orgs[o].id === orgId);
    const byRepo = (list) => { const m = new Map(); for (const x of list) m.set(x.repo, (m.get(x.repo) || 0) + 1); return [...m].map(([repo, n]) => ({ repository: { nameWithOwner: repo, isFork: false }, contributions: { totalCount: n } })); };
    const mine = prs.filter((x) => x.org === org && x.author === login && x.state === "MERGED" && inRange(x.mergedAt, [Date.parse(from), Date.parse(to)]));
    const myIssues = issues.filter((x) => x.org === org && x.author === login && inRange(x.createdAt, [Date.parse(from), Date.parse(to)]));
    // Reviews: invented as a function of merged work, skewed toward a few maintainers.
    const reviewFactor = ["tlindqvist", "rj-ferreira", "mira-okoye"].includes(login) ? 2.4 : 0.7;
    const reviews = prs.filter((x) => x.org === org && x.author !== login && x.state === "MERGED" && inRange(x.mergedAt, [Date.parse(from), Date.parse(to)]))
      .filter(() => rnd() < 0.06 * reviewFactor);
    return {
      totalCommitContributions: mine.length, totalPullRequestContributions: mine.length,
      totalPullRequestReviewContributions: reviews.length, totalIssueContributions: myIssues.length,
      totalRepositoriesWithContributedCommits: new Set(mine.map((x) => x.repo)).size,
      commitContributionsByRepository: byRepo(mine), pullRequestContributionsByRepository: byRepo(mine),
      pullRequestReviewContributionsByRepository: byRepo(reviews), issueContributionsByRepository: byRepo(myIssues)
    };
  }

  window.LEDGER_DEMO = {
    defaultLogin,
    rest(path) { return path === "/user" ? { login: defaultLogin } : {}; },
    gql(query, v) {
      if (/organization\(login:/.test(query)) {
        const out = {}; let i = 0;
        for (const m of query.matchAll(/o(\d+): organization\(login: "([^"]+)"\)/g)) { const o = orgs[m[2]]; out[`o${m[1]}`] = o ? { id: o.id, login: m[2], name: m[2], avatarUrl: "" } : null; i++; }
        return out;
      }
      if (/^\s*query\(\$q: String!/.test(query)) {
        const all = searchNodes(v.q);
        const start = v.after ? Number(v.after) : 0;
        const nodes = all.slice(start, start + v.first);
        const end = start + nodes.length;
        return { search: { issueCount: all.length, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes } };
      }
      if (/user\(login: \$login\)/.test(query)) {
        const user = { login: v.login, name: v.login.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), avatarUrl: avatar(v.login), url: `https://github.com/${v.login}` };
        if (!people.includes(v.login)) return { user: null };
        for (const m of query.matchAll(/c(\d+): contributionsCollection\(organizationID: \$org(\d+)/g)) user[`c${m[1]}`] = contributions(v.login, v[`org${m[2]}`], v.from, v.to);
        return { user };
      }
      if (/u0: user\(login:/.test(query)) {
        const out = {};
        for (const m of query.matchAll(/u(\d+): user\(login: "([^"]+)"\)/g)) out[`u${m[1]}`] = { login: m[2], avatarUrl: avatar(m[2]), c: contributions(m[2], v.org, v.from, v.to) };
        return out;
      }
      return {};
    }
  };
})();
