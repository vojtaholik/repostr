// Server-side GitHub fetcher. Runs in the Lakebed runtime (global fetch).
// Authenticated with GITHUB_TOKEN when present (60/hr -> 5000/hr). Kept lean:
// ~6 requests per repo (was ~20) — we use /releases for dated wells instead of
// resolving each tag's commit, and a single /commits call serves SHAs, commit
// subjects, and the churn fallback.

import type { RawRepo, RepoTag, WeekStat } from "../shared/poster";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "rate_limit" | "empty" | "network" | "unknown",
    readonly status = 500
  ) {
    super(message);
  }
}

function authHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "repostr",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function gh(path: string, token?: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers: authHeaders(token) });
  } catch {
    throw new GitHubError("Could not reach GitHub.", "network", 502);
  }
  if (res.status === 404) {
    throw new GitHubError("Repository not found — check the owner/name.", "not_found", 404);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const msg =
      remaining === "0"
        ? "GitHub API limit reached. Add a GITHUB_TOKEN to .env.lakebed.server to raise it to 5000/hr."
        : "GitHub denied the request (403).";
    throw new GitHubError(msg, "rate_limit", 429);
  }
  if (!res.ok) {
    throw new GitHubError(`GitHub returned ${res.status}.`, "unknown", 502);
  }
  return res.json();
}

// stats endpoints answer 202 (with empty body) while GitHub computes them.
// GitHub caches the result after the first compute, so persistent polling
// pays off: the first fetch of a big repo waits, every later fetch is instant.
async function ghStats(path: string, token?: string, attempts = 7): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, { headers: authHeaders(token) });
    } catch {
      return null;
    }
    if (res.status === 403 || res.status === 429) {
      throw new GitHubError(
        "GitHub API limit reached. Add a GITHUB_TOKEN to .env.lakebed.server.",
        "rate_limit",
        429
      );
    }
    if (res.status === 202) {
      await sleep(2000);
      continue;
    }
    if (res.status === 204) return [];
    if (!res.ok) return null;
    const body = await res.json();
    if (Array.isArray(body) && body.length === 0) {
      await sleep(2000);
      continue;
    }
    return body;
  }
  return null;
}

export async function fetchRepo(
  owner: string,
  name: string,
  token?: string
): Promise<RawRepo> {
  const repo = await gh(`/repos/${owner}/${name}`, token);
  const branch = repo.default_branch ?? "main";

  // languages + commits + churn in as few calls as possible
  const languages: Record<string, number> = await gh(
    `/repos/${owner}/${name}/languages`,
    token
  );

  // First commit page powers the SHA + message texture and the overlay.
  const firstPage: any[] = await gh(
    `/repos/${owner}/${name}/commits?sha=${branch}&per_page=100`,
    token
  ).catch(() => []);
  const shas = firstPage
    .map((c) => (typeof c.sha === "string" ? c.sha.slice(0, 7) : null))
    .filter((s): s is string => Boolean(s));
  const commits = firstPage
    .map((c) => firstLine(c?.commit?.message ?? ""))
    .filter(Boolean);

  // Weekly churn. Prefer code_frequency (real additions/deletions across the
  // full lifespan), but GitHub's stats often 202 indefinitely for big repos,
  // so fall back to paginated commit cadence — reliable, if add/del-approx.
  let weeks: WeekStat[] = [];
  let partial = false;
  const codeFreq = await ghStats(
    `/repos/${owner}/${name}/stats/code_frequency`,
    token,
    3
  );
  if (Array.isArray(codeFreq) && codeFreq.length > 1) {
    weeks = codeFreq
      .filter((row: any) => Array.isArray(row) && row.length >= 3)
      .map((row: number[]) => ({
        t: row[0],
        add: Math.max(0, row[1]),
        del: Math.abs(Math.min(0, row[2]))
      }))
      .filter((w) => w.add > 0 || w.del > 0);
  }
  if (weeks.length < 2) {
    // sample commits across the repo's whole life so even very active repos
    // (where 500 recent commits = a few weeks) span their full timeline
    weeks = await weeksAcrossLife(owner, name, branch, token, repo.created_at, firstPage);
    partial = weeks.length < 2;
  }
  if (weeks.length === 0) {
    throw new GitHubError("No readable commit history yet.", "empty", 422);
  }

  // releases give dated gravity wells in a single request (no per-tag lookups)
  const tags = await fetchReleaseTags(owner, name, token);

  return {
    owner: repo.owner?.login ?? owner,
    name: repo.name ?? name,
    description: repo.description ?? "",
    stars: repo.stargazers_count ?? 0,
    languages,
    weeks,
    tags,
    shas,
    commits,
    partial
  };
}

function firstLine(message: string): string {
  return message.split("\n")[0].trim().slice(0, 80);
}

// Sample commits across the repo's ENTIRE lifespan when code_frequency is
// unavailable. We step `until` from creation date to now in ~16 buckets and
// pull a page at each — so even a hyper-active repo (where the latest 500
// commits cover only days) still spans its full history. Deduped by SHA.
async function weeksAcrossLife(
  owner: string,
  name: string,
  branch: string,
  token: string | undefined,
  createdAt: string | undefined,
  firstPage: any[]
): Promise<WeekStat[]> {
  const startSec = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!startSec || nowSec <= startSec) return weeksFromCommits(firstPage);

  const span = nowSec - startSec;
  const BUCKETS = 36; // windows across the lifespan — finer = fewer false gaps
  const seen = new Set<string>();
  const counts = new Map<number, number>();
  const add = (c: any) => {
    const sha = c?.sha;
    if (!sha || seen.has(sha)) return;
    seen.add(sha);
    const iso = c?.commit?.author?.date ?? c?.commit?.committer?.date;
    if (!iso) return;
    const sec = Math.floor(new Date(iso).getTime() / 1000);
    if (!Number.isFinite(sec)) return;
    const wk = sec - (sec % (7 * 86400));
    counts.set(wk, (counts.get(wk) ?? 0) + 1);
  };

  for (const c of firstPage) add(c); // newest slice
  // Probe each time WINDOW independently with since+until, so every window that
  // had any activity registers — no gaps between sample points (the old
  // until-only stepping left quiet-looking stretches between buckets even when
  // the repo was active). A window with >100 commits is capped (busy periods
  // undercount slightly), which the log-scaled visuals tolerate.
  for (let i = 0; i < BUCKETS; i++) {
    const sinceSec = startSec + Math.floor((span * i) / BUCKETS);
    const untilSec = startSec + Math.floor((span * (i + 1)) / BUCKETS);
    const sinceIso = new Date(sinceSec * 1000).toISOString();
    const untilIso = new Date(untilSec * 1000).toISOString();
    try {
      const page = await gh(
        `/repos/${owner}/${name}/commits?sha=${branch}&per_page=100&since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`,
        token
      );
      if (Array.isArray(page)) for (const c of page) add(c);
    } catch {
      // skip this window
    }
  }

  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, count]) => {
      const delShare = 0.28 + ((t / (7 * 86400)) % 11) / 40;
      const a = Math.round(count * 38);
      return { t, add: a, del: Math.round(a * delShare) };
    });
}

// Bucket commits by week of authorship. Real add/del isn't in the commit list,
// so churn is approximated from commit count — additions dominate, with a
// per-week-varying deletion share so the build-vs-prune flow stays alive.
function weeksFromCommits(commits: any[]): WeekStat[] {
  const counts = new Map<number, number>();
  for (const c of commits) {
    const iso = c?.commit?.author?.date ?? c?.commit?.committer?.date;
    if (!iso) continue;
    const sec = Math.floor(new Date(iso).getTime() / 1000);
    if (!Number.isFinite(sec)) continue;
    const weekStart = sec - (sec % (7 * 86400));
    counts.set(weekStart, (counts.get(weekStart) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, count]) => {
      const delShare = 0.28 + ((t / (7 * 86400)) % 11) / 40; // 0.28..0.55, stable
      const add = Math.round(count * 38);
      return { t, add, del: Math.round(add * delShare) };
    });
}

async function fetchReleaseTags(
  owner: string,
  name: string,
  token?: string
): Promise<RepoTag[]> {
  try {
    const releases: any[] = await gh(
      `/repos/${owner}/${name}/releases?per_page=30`,
      token
    );
    return releases
      .filter((r) => !r.draft && (r.published_at || r.created_at))
      .map((r) => ({
        name: r.tag_name ?? r.name ?? "",
        t: Math.floor(new Date(r.published_at ?? r.created_at).getTime() / 1000)
      }))
      .filter((t) => t.name && t.t > 0);
  } catch {
    return [];
  }
}
