import test from "node:test";
import assert from "node:assert/strict";
import { isBot, normalizeLogin, normalizeOrg, windowBounds, splitWindow, groupByAuthor, score, weeklyBuckets, sparklinePath, sortRows, fmt } from "../lib.js";

test("bots are excluded by typename, suffix and known logins", () => {
  assert.equal(isBot({ login: "dependabot[bot]" }), true);
  assert.equal(isBot({ login: "x", __typename: "Bot" }), true);
  assert.equal(isBot({ login: "openshift-ci" }), true);
  assert.equal(isBot({ login: "madhugoutham", __typename: "User" }), false);
  assert.equal(isBot(null), true);
});

test("logins and orgs are normalized from handles and URLs", () => {
  assert.equal(normalizeLogin("@MadhuGoutham"), "madhugoutham");
  assert.equal(normalizeLogin("https://github.com/mgoin/pingboard"), "mgoin");
  assert.equal(normalizeLogin("  bad name! "), "badname");
  assert.equal(normalizeOrg("https://github.com/llm-d"), "llm-d");
});

test("window bounds cover whole UTC days", () => {
  const w = windowBounds(90, new Date("2026-10-22T16:00:00Z"));
  assert.equal(w.toDay, "2026-10-22");
  assert.equal(w.fromDay, "2026-07-25");
  assert.equal(w.from, "2026-07-25T00:00:00.000Z");
  assert.equal(w.to, "2026-10-22T23:59:59.000Z");
});

test("splitWindow halves ranges and stops at one day", () => {
  assert.deepEqual(splitWindow("2026-10-01", "2026-10-10"), [["2026-10-01", "2026-10-05"], ["2026-10-06", "2026-10-10"]]);
  assert.deepEqual(splitWindow("2026-10-01", "2026-10-02"), [["2026-10-01", "2026-10-01"], ["2026-10-02", "2026-10-02"]]);
  assert.equal(splitWindow("2026-10-01", "2026-10-01"), null);
});

test("groupByAuthor skips bots and forks, sums sizes and repos", () => {
  const nodes = [
    { author: { login: "a", __typename: "User" }, additions: 10, deletions: 2, mergedAt: "2026-10-01T00:00:00Z", repository: { nameWithOwner: "o/r1", isFork: false } },
    { author: { login: "a", __typename: "User" }, additions: 5, deletions: 1, mergedAt: "2026-10-02T00:00:00Z", repository: { nameWithOwner: "o/r2", isFork: false } },
    { author: { login: "a", __typename: "User" }, additions: 99, deletions: 0, mergedAt: "2026-10-02T00:00:00Z", repository: { nameWithOwner: "o/fork", isFork: true } },
    { author: { login: "renovate[bot]", __typename: "Bot" }, additions: 1, deletions: 1, repository: { nameWithOwner: "o/r1", isFork: false } },
    null
  ];
  const m = groupByAuthor(nodes);
  assert.equal(m.size, 1);
  const a = m.get("a");
  assert.equal(a.merged, 2);
  assert.equal(a.additions, 15);
  assert.equal(a.repos.size, 2);
});

test("score uses the published weights", () => {
  assert.equal(score({ merged: 2, reviews: 3, issues: 4 }), 2 * 3 + 3 * 2 + 4 * 1);
  assert.equal(score({ merged: 1 }), 3);
});

test("weekly buckets count into 7-day bins oldest first", () => {
  const v = weeklyBuckets(["2026-10-01T12:00:00Z", "2026-10-02T12:00:00Z", "2026-10-20T00:00:00Z", "2020-01-01T00:00:00Z"], "2026-10-01T00:00:00Z", "2026-10-21T23:59:59Z");
  assert.deepEqual(v, [2, 0, 1]);
});

test("sparkline path has one point per value and marks the last", () => {
  const { d, last } = sparklinePath([0, 2, 1], 96, 28);
  assert.match(d, /^M2\.0 26\.0 L48\.0 2\.0 L94\.0 14\.0$/);
  assert.equal(last[0], 94);
});

test("sortRows is stable by login and handles nulls", () => {
  const rows = [{ login: "b", merged: 1, reviews: null }, { login: "a", merged: 1, reviews: 2 }, { login: "c", merged: 3, reviews: 0 }];
  assert.deepEqual(sortRows(rows, "merged").map((r) => r.login), ["c", "a", "b"]);
  assert.deepEqual(sortRows(rows, "reviews", "asc").map((r) => r.login), ["b", "c", "a"]);
});

test("fmt abbreviates large numbers", () => {
  assert.equal(fmt(999), "999");
  assert.equal(fmt(12345), "12.3k");
  assert.equal(fmt(null), "—");
});
