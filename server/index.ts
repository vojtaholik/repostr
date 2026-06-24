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
      // JSON blob. Lakebed string() columns cap at 64KB, so payloads are
      // trimmed to fit before caching (see MAX_VALUE_BYTES in /api/repo).
      payload: string(),
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
      // base64 JPEG, rendered client-side and downscaled to fit the 64KB
      // string() cap (see MAX_VALUE_BYTES in POST /og).
      png: string()
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
        // Lakebed string() columns cap at 64KB. Trim the heaviest fields
        // (commit subjects + SHAs are texture-only) until the JSON fits, so
        // even huge repos cache instead of throwing on insert.
        const payload = fitPayload(repo);
        // Only cache full-history results, and only when they fit the cap.
        if (!repo.partial && payload) {
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

    // GET /og?repo=owner/name&<render params> -> the cached share card (JPEG).
    // Keyed by the FULL param-set, so every shuffle/edit has its own image (not
    // just one per repo). Falls back to a branded SVG until a client warms it.
    og: endpoint({ method: "GET", path: "/og" }, (ctx, req) => {
      const slug = (req.query.get("repo") ?? "").trim().toLowerCase();
      const key = ogKey(req.query);
      const hit = key ? ctx.db.ogimages.where("slug", key).all()[0] : undefined;
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
      const key = ogKey(req.query); // keyed by the full param-set, like GET
      const body = (await req.text()).replace(/^data:image\/\w+;base64,/, "");
      if (!slug || !slug.includes("/") || !key || !body) {
        return json({ ok: false }, { status: 400 });
      }
      // string() columns cap at 64KB. The client downscales the OG JPEG to fit,
      // but reject anything still over the cap rather than throwing on insert
      // (the /og fallback SVG covers an un-cached slug).
      if (utf8Bytes(body) > MAX_VALUE_BYTES) {
        return json({ ok: false, error: "too_large", bytes: body.length }, { status: 413 });
      }
      for (const row of ctx.db.ogimages.where("slug", key).all()) {
        ctx.db.ogimages.delete(row.id);
      }
      ctx.db.ogimages.insert({ slug: key, png: body });
      return json({ ok: true, bytes: body.length });
    }),

    // GET /share?repo=owner/name&... -> HTML with OG/Twitter/SEO meta so the link
    // unfurls (crawlers read the tags), then redirects humans to the app. This is
    // the canonical shareable URL since we can't inject meta into the SPA shell.
    share: endpoint({ method: "GET", path: "/share" }, (ctx, req) => {
      const slug = (req.query.get("repo") ?? "").trim().toLowerCase();
      let origin = "";
      try {
        // Lakebed terminates TLS at the edge, so req.url's origin is http
        // internally. Public deploys are always served over https — upgrade it,
        // since crawlers (Twitter especially) reject http og:image URLs.
        origin = new URL(req.url).origin.replace(/^http:\/\//, "https://");
      } catch {
        origin = "";
      }

      let title = slug || "Repostr";
      // Branded, descriptive copy — NOT the repo's own GitHub tagline (which is
      // off-topic for the poster). Describes what the image actually is.
      let desc =
        "A generative topographic poster mapped from a GitHub repository's git history — its commit timeline, churn and releases rendered as terrain.";
      const cached = slug ? ctx.db.repos.where("slug", slug).all()[0] : undefined;
      if (cached) {
        try {
          const p = JSON.parse(cached.payload) as {
            owner?: string;
            name?: string;
            description?: string;
            stars?: number;
            languages?: Record<string, number>;
            weeks?: unknown[];
            tags?: unknown[];
          };
          if (p.owner && p.name) title = `${p.owner}/${p.name}`;
          const top = topLanguage(p.languages);
          const stars = typeof p.stars === "number" ? `${formatStars(p.stars)}★` : "";
          const weeks = Array.isArray(p.weeks) ? p.weeks.length : 0;
          const rels = Array.isArray(p.tags) ? p.tags.length : 0;
          const bits = [top, stars, weeks ? `${weeks} weeks` : "", rels ? `${rels} releases` : ""]
            .filter(Boolean)
            .join(" · ");
          desc = `${title} — its git history mapped as a generative topographic print${bits ? `. ${bits}` : ""}.`;
        } catch {
          // keep defaults
        }
      }

      // include the full param-set so the unfurl image matches the exact view
      const img = `${origin}/og?${req.query.toString()}`;
      // redirect humans to the real client route /owner/repo?<render params>
      // (the app now uses path-based routing, not ?repo=).
      const appParams = new URLSearchParams(req.query.toString());
      appParams.delete("repo");
      const appQs = appParams.toString();
      const appUrl = slug.includes("/")
        ? `${origin}/${slug}${appQs ? `?${appQs}` : ""}`
        : `${origin}/`;
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

// --- size helpers -----------------------------------------------------------

// Lakebed string() columns cap each value at 64KB. Leave a little headroom.
const MAX_VALUE_BYTES = 65536;
const PAYLOAD_BUDGET = 63000;

// UTF-8 byte length without Node's Buffer (banned in capsule code).
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// Serialize a repo payload, trimming the texture-only fields (commit subjects
// then SHAs) until it fits the column cap. Returns "" if it can't fit even
// stripped — caller then skips caching.
function fitPayload(repo: { commits?: string[]; shas?: string[] }): string {
  const r = repo as { commits?: string[]; shas?: string[] };
  const commits = Array.isArray(r.commits) ? r.commits : [];
  const shas = Array.isArray(r.shas) ? r.shas : [];
  const caps = [
    [100, 100],
    [60, 60],
    [30, 40],
    [12, 20],
    [0, 0]
  ];
  for (const [c, s] of caps) {
    const trimmed = { ...r, commits: commits.slice(0, c), shas: shas.slice(0, s) };
    const json = JSON.stringify(trimmed);
    if (utf8Bytes(json) <= PAYLOAD_BUDGET) return json;
  }
  return "";
}

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

// Canonical cache key for an OG variant: every query param (repo + render
// params) sorted, so the same view always maps to the same key regardless of
// param order. paramsQuery omits defaults, so the default view keys to just
// "repo=slug" (what the gallery thumbnails request).
function ogKey(q: { forEach: (cb: (v: string, k: string) => void) => void }): string {
  const parts: string[] = [];
  q.forEach((v, k) => parts.push(`${k}=${v}`));
  parts.sort();
  return parts.join("&");
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
