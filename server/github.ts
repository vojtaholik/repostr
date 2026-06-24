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

export async function fetchRepo(
  owner: string,
  name: string,
  token?: string
): Promise<RawRepo> {
  const repo = await gh(`/repos/${owner}/${name}`, token);
  const branch = repo.default_branch ?? "main";

  // languages, the first commit page, and releases are independent — fetch them
  // concurrently to stay inside the claimed runtime's 5s budget. The first
  // commit page powers the SHA + message texture and the overlay.
  const [languages, firstPage, tags] = await Promise.all([
    gh(`/repos/${owner}/${name}/languages`, token).catch(
      () => ({}) as Record<string, number>
    ),
    gh(`/repos/${owner}/${name}/commits?sha=${branch}&per_page=100`, token).catch(
      () => [] as any[]
    ),
    fetchReleaseTags(owner, name, token)
  ]);
  const shas = firstPage
    .map((c) => (typeof c.sha === "string" ? c.sha.slice(0, 7) : null))
    .filter((s): s is string => Boolean(s));
  const commits = firstPage
    .map((c) => firstLine(c?.commit?.message ?? ""))
    .filter(Boolean);

  // Weekly churn. The code_frequency stats endpoint 202s while GitHub computes
  // it, which would need a polling/backoff loop — and Lakebed's claimed runtime
  // forbids timers. So we sample commits across the repo's whole lifespan
  // directly (reliable, if add/del-approx): even very active repos (where 500
  // recent commits = a few weeks) still span their full timeline.
  let weeks: WeekStat[] = await weeksAcrossLife(
    owner,
    name,
    branch,
    token,
    repo.created_at,
    firstPage
  );
  const partial = weeks.length < 2;
  if (weeks.length === 0) {
    throw new GitHubError("No readable commit history yet.", "empty", 422);
  }

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
  const BUCKETS = 24; // windows across the lifespan — finer = fewer false gaps
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
  // had any activity registers — no gaps between sample points. Fired
  // CONCURRENTLY: Lakebed's claimed runtime caps each request at 5s, so 24
  // sequential GitHub calls would blow the budget; in parallel they finish in
  // ~1s. A window with >100 commits is capped (busy periods undercount
  // slightly), which the log-scaled visuals tolerate.
  const urls: string[] = [];
  for (let i = 0; i < BUCKETS; i++) {
    const sinceSec = startSec + Math.floor((span * i) / BUCKETS);
    const untilSec = startSec + Math.floor((span * (i + 1)) / BUCKETS);
    const sinceIso = new Date(sinceSec * 1000).toISOString();
    const untilIso = new Date(untilSec * 1000).toISOString();
    urls.push(
      `/repos/${owner}/${name}/commits?sha=${branch}&per_page=100&since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`
    );
  }
  const pages = await Promise.all(urls.map((u) => gh(u, token).catch(() => null)));
  for (const page of pages) {
    if (Array.isArray(page)) for (const c of page) add(c);
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
    // Fetch several pages (100/page) IN PARALLEL so releases span the repo's
    // whole life, not just the last ~30. Active repos ship hundreds of releases;
    // grabbing only the newest made every ring cluster in the past year.
    const pages = await Promise.all(
      [1, 2, 3, 4].map((p) =>
        gh(`/repos/${owner}/${name}/releases?per_page=100&page=${p}`, token).catch(() => [] as any[])
      )
    );
    const releases = pages.flat();
    return releases
      .filter((r) => r && !r.draft && (r.published_at || r.created_at))
      .map((r) => ({
        name: r.tag_name ?? r.name ?? "",
        t: Math.floor(new Date(r.published_at ?? r.created_at).getTime() / 1000)
      }))
      .filter((t) => t.name && t.t > 0);
  } catch {
    return [];
  }
}
