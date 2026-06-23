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
    }),
    // client-rendered OG share card (base64 PNG), keyed by slug. The poster is
    // canvas-rendered in the browser, so the client uploads it here and the /og
    // endpoint serves the bytes for link unfurls.
    ogimages: table({
      slug: string(),
      png: text()
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
    }),

    // GET /og?repo=owner/name -> the cached share card as a JPEG (real bytes).
    // Falls back to a branded SVG until a client has warmed the cache.
    og: endpoint({ method: "GET", path: "/og" }, (ctx, req) => {
      const slug = (req.query.get("repo") ?? "").trim().toLowerCase();
      const hit = slug ? ctx.db.ogimages.where("slug", slug).all()[0] : undefined;
      if (hit && hit.png) {
        return binaryResponse(base64ToBytes(hit.png), "image/jpeg", "public, max-age=86400");
      }
      return text(fallbackSvg(slug), {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300"
        }
      });
    }),

    // POST /og?repo=owner/name  body: base64 JPEG -> cache the client-rendered
    // share card. Uses an HTTP body (2MB limit) rather than the websocket so the
    // image upload is reliable and verifiable.
    ogUpload: endpoint({ method: "POST", path: "/og" }, async (ctx, req) => {
      const slug = (req.query.get("repo") ?? "").trim().toLowerCase();
      const body = (await req.text()).replace(/^data:image\/\w+;base64,/, "");
      if (!slug || !slug.includes("/") || !body) {
        return json({ ok: false }, { status: 400 });
      }
      for (const row of ctx.db.ogimages.where("slug", slug).all()) {
        ctx.db.ogimages.delete(row.id);
      }
      ctx.db.ogimages.insert({ slug, png: body });
      return json({ ok: true, bytes: body.length });
    }),

    // GET /share?repo=owner/name&... -> HTML with OG/Twitter/SEO meta so the link
    // unfurls (crawlers read the tags), then redirects humans to the app. This is
    // the canonical shareable URL since we can't inject meta into the SPA shell.
    share: endpoint({ method: "GET", path: "/share" }, (ctx, req) => {
      const slug = (req.query.get("repo") ?? "").trim().toLowerCase();
      let origin = "";
      try {
        origin = new URL(req.url).origin;
      } catch {
        origin = "";
      }

      let title = slug || "Repostr";
      let desc =
        "A generative poster painted from a repository's git history — bursts, dead zones, rewrites and releases.";
      const cached = slug ? ctx.db.repos.where("slug", slug).all()[0] : undefined;
      if (cached) {
        try {
          const p = JSON.parse(cached.payload) as {
            owner?: string;
            name?: string;
            description?: string;
            stars?: number;
            languages?: Record<string, number>;
          };
          if (p.owner && p.name) title = `${p.owner}/${p.name}`;
          const top = topLanguage(p.languages);
          const stars = typeof p.stars === "number" ? `${formatStars(p.stars)}★` : "";
          const bits = [top, stars].filter(Boolean).join(" · ");
          desc = p.description
            ? p.description
            : `${title}${bits ? ` — ${bits}` : ""} — git history as print.`;
        } catch {
          // keep defaults
        }
      }

      const img = `${origin}/og?repo=${encodeURIComponent(slug)}`;
      const appUrl = `${origin}/?${req.query.toString()}`;
      const pageUrl = `${origin}/share?${req.query.toString()}`;
      const t = `${title} — Repostr`;
      const alt = `${title} — git history painted as a generative poster`;
      const secureImg = img.startsWith("https://")
        ? `\n<meta property="og:image:secure_url" content="${escapeHtml(img)}" />`
        : "";

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(t)}</title>
<meta name="description" content="${escapeHtml(desc)}" />
<link rel="canonical" href="${escapeHtml(appUrl)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Repostr" />
<meta property="og:title" content="${escapeHtml(t)}" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta property="og:url" content="${escapeHtml(appUrl)}" />
<meta property="og:image" content="${escapeHtml(img)}" />${secureImg}
<meta property="og:image:type" content="image/jpeg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="1600" />
<meta property="og:image:alt" content="${escapeHtml(alt)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(t)}" />
<meta name="twitter:description" content="${escapeHtml(desc)}" />
<meta name="twitter:image" content="${escapeHtml(img)}" />
<meta name="twitter:image:alt" content="${escapeHtml(alt)}" />
<meta http-equiv="refresh" content="0; url=${escapeHtml(appUrl)}" />
</head>
<body style="background:#0c0c0c;color:#cfcfcf;font-family:system-ui,sans-serif">
<p>Opening <a href="${escapeHtml(appUrl)}">${escapeHtml(title)}</a> on Repostr…</p>
<script>location.replace(${JSON.stringify(appUrl)})</script>
</body>
</html>`;
      return text(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    })
  }
});

// --- OG helpers -------------------------------------------------------------

// pure base64 -> bytes (no Node Buffer / atob dependency)
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let bits = 0;
  let acc = 0;
  let oi = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// the runtime accepts a Uint8Array body even though the type says string
function binaryResponse(
  bytes: Uint8Array,
  contentType: string,
  cacheControl: string
): ReturnType<typeof text> {
  return {
    kind: "response",
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
    body: bytes
  } as unknown as ReturnType<typeof text>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function topLanguage(languages?: Record<string, number>): string {
  if (!languages) return "";
  let best = "";
  let max = -1;
  for (const [name, bytes] of Object.entries(languages)) {
    if (bytes > max) {
      max = bytes;
      best = name;
    }
  }
  return best;
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fallbackSvg(slug: string): string {
  const label = slug ? escapeHtml(slug) : "Git history as print";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
<rect width="1200" height="1600" fill="#0c0c0c"/>
<text x="80" y="780" fill="#ffffff" font-family="monospace" font-size="72" font-weight="700">Repostr</text>
<text x="80" y="850" fill="#8f8f8f" font-family="monospace" font-size="30">${label}</text>
</svg>`;
}
