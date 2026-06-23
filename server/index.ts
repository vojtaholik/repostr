import { capsule, endpoint, json, mutation, query, string, table, text } from "lakebed/server";
import { fetchRepo, GitHubError } from "./github";

// repostr — the Lakebed capsule.
//
// The runtime fetches GitHub data server-side (authenticated when GITHUB_TOKEN
// is set) and caches the raw payload per repo, so repeated views and the
// gallery cost zero API requests. The generative poster is rendered on the
// client and is deterministic from the cached data — same repo, same poster.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export default capsule({
  name: "repostr",

  schema: {
    // cached raw GitHub payload (JSON), keyed by slug
    repos: table({
      slug: string(),
      payload: text(),
      fetchedAt: string()
    }),
    // gallery of painted repos (social proof + the "what does mine look like" loop)
    posters: table({
      slug: string(),
      owner: string(),
      name: string(),
      language: string().default(""),
      languageColor: string().default("#8a8a8a"),
      volatility: string().default("0")
    })
  },

  queries: {
    // Most-recently painted repos, de-duplicated by slug (newest wins).
    recentPosters: query((ctx) => {
      const rows = ctx.db.posters.orderBy("createdAt", "desc").all();
      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
      }
      const seen = new Set<string>();
      const out: Array<(typeof rows)[number] & { paints: number }> = [];
      for (const row of rows) {
        if (seen.has(row.slug)) continue;
        seen.add(row.slug);
        out.push({ ...row, paints: counts.get(row.slug) ?? 1 });
        if (out.length >= 24) break;
      }
      return out;
    })
  },

  mutations: {
    recordPoster: mutation(
      (
        ctx,
        input: {
          slug: string;
          owner: string;
          name: string;
          language: string;
          languageColor: string;
          volatility: number;
        }
      ) => {
        const slug = (input.slug ?? "").trim().toLowerCase();
        if (!slug || !slug.includes("/")) return;
        ctx.db.posters.insert({
          slug,
          owner: input.owner,
          name: input.name,
          language: input.language ?? "",
          languageColor: input.languageColor ?? "#8a8a8a",
          volatility: String(input.volatility ?? 0)
        });
      }
    )
  },

  endpoints: {
    status: endpoint({ method: "GET", path: "/api/status" }, () => text("ok")),

    // GET /api/repo?owner=&name= -> raw GitHub payload (cached).
    repo: endpoint({ method: "GET", path: "/api/repo" }, async (ctx, req) => {
      const owner = (req.query.get("owner") ?? "").trim();
      const name = (req.query.get("name") ?? "").trim();
      if (!owner || !name) {
        return json({ error: "owner and name are required" }, { status: 400 });
      }
      const slug = `${owner}/${name}`.toLowerCase();

      // serve fresh cache
      const cached = ctx.db.repos.where("slug", slug).all();
      const hit = cached[0];
      if (hit && Date.now() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) {
        return json({ cached: true, repo: JSON.parse(hit.payload) });
      }

      try {
        const repo = await fetchRepo(owner, name, ctx.env.GITHUB_TOKEN);
        const payload = JSON.stringify(repo);
        // Only cache full-history results. Partial (code_frequency still
        // computing) results aren't cached, so the next load gets real history.
        if (!repo.partial) {
          for (const row of cached) ctx.db.repos.delete(row.id);
          ctx.db.repos.insert({ slug, payload, fetchedAt: new Date().toISOString() });
        }
        return json({ cached: false, partial: repo.partial ?? false, repo });
      } catch (err) {
        if (err instanceof GitHubError) {
          // fall back to stale cache rather than failing, if we have any
          if (hit) {
            return json({ cached: true, stale: true, repo: JSON.parse(hit.payload) });
          }
          return json({ error: err.message, kind: err.kind }, { status: err.status });
        }
        return json({ error: "Unexpected error reading the repository." }, { status: 500 });
      }
    })
  }
});
