# repostr — vision

> git history as generative print. paste a repo, get a painting that's unmistakably *yours*.

## the one-liner

every repo has a shape — bursts, dead zones, rewrites, the 3am hotfix, the great refactor of 2023. repostr reads that shape from github's own data and paints it as an organic, poster-grade image. no two repos look alike. that's the whole point.

## the insight (why this spreads)

the magic in data-art that goes viral isn't the art — it's that **everyone runs it on their own data and gets a unique fingerprint they want to post.** spotify wrapped, github skyline, wordle grids. same mechanic.

repostr has the three ingredients baked in:

- **personal substrate** — every dev has repos they have *feelings* about
- **per-subject uniqueness** — the output is deterministic from the data, so each repo is a fresh, ownable image
- **one-click "make mine"** — paste `owner/name`, done

the share isn't a favor we ask for. it's the product working.

## who it's for

devs and designers in the same breath. devs bring the repos and the emotional attachment; designers bring the eye and the reposts. the color system (real linguist language colors) and the print aesthetic are the bridge — it reads as *art* before it reads as *infographic*, so it lands outside the usual dev-tool bubble.

## how it works — five systems, stacked

lifted from zeh fernandes' world-cup poster method, mapped onto git. each system carries exactly one variable, and they compound — that's why repos diverge instead of all looking the same.

1. **chrono-grid** — the repo's full lifespan mapped to an 8-column grid. kickoff = first commit, final whistle = latest. time becomes space.
2. **lines** — each week emits brush strokes. stroke *count + length* ∝ churn that week. **additions flow left, deletions flow right** — the confrontation. build vs prune, leaning into each other.
3. **gravity** — release tags are attractor wells in a flow field. strokes nearby bend toward them. versions reorganize the space around themselves, like goals warping a match.
4. **drama** — churn variance across the project's life. chaotic repos (big spikes, mass deletions, rewrites) swirl; steady repos flow straight. keeps high-energy repos visually loud and stops everything collapsing into mud.
5. **palette** — language breakdown → linguist colors, automatically. a typescript repo is blue-dominant, a python repo yellow. zero hand-picking. the repo colors itself.

plus the texture move: **commit SHAs printed faintly across the background.** the poster exposes its own source material — admits it was born from data.

## aesthetic north star

print, not dashboard. paper, ink, painterly spray, real typography. something you'd frame, not something you'd screenshot into a slack. the boldness lives in *one* place — the brush field — and everything around it (grid, labels, title block) stays quiet and disciplined.

reference: zeh's gencup, p5.brush textures, risograph/screen-print restraint. never neon-on-black "data viz."

## the viral loop, end to end

1. dev pastes their repo → gets a poster in seconds
2. shared link **unfurls as the poster itself** (og-image rendered server-side) — the unfurl *is* the ad
3. viewer thinks "what does *mine* look like" → step 1
4. optional terminal: `npx repostr owner/name` for the cli crowd
5. optional tail: order a real print, framed

## why this is the lakebed test project

repostr is, conveniently, the perfect shape to prove out an agent-native runtime:

- each repo render = a **capsule** — fetch github data, run the generative pipeline, cache the output + og-image
- the data pipeline (fetch → transform → render → store) is exactly the full-stack story lakebed wants to demonstrate
- broad public value, not internal tooling — it's a thing people actually share
- "i built this to test lakebed" is a better launch narrative than a todo app

so: ship it as a real toy *and* as the reference capsule. two birds.

## roadmap

**v0 — prototype (done)**
client-side, unauthenticated github api, custom spray brush, faked tag dates. proves the concept renders and reads.

**v1 — truthful**
- resolve real release dates (per-tag commit date or `/releases`) so gravity wells land where versions actually happened — biggest single quality jump
- swap custom spray → **p5.brush.js** for genuine painterly texture
- tune the 8×N grid + drama curve across repo sizes (a 6-month repo and a 10-year repo should both look right)

**v2 — backend / capsule**
- tiny authed proxy + cache (the lakebed capsule) — kills the 60/hr rate limit
- deterministic render so the same repo always yields the same poster
- **og-image endpoint** — the actual viral mechanic

**v3 — distribution**
- `npx repostr`
- shareable permalink per repo
- print-on-demand tail

## non-goals

- not an infographic. if it needs a legend to feel meaningful, it failed.
- not a dashboard, not analytics, not "repo insights." no charts.
- not configurable to death. a handful of honest knobs, max. the data drives it.
- not a github-skyline clone — that's a 3d bar chart. this is paint.

## open questions

- what are the *two forces*, really? additions/deletions is clean and universal, but top-2-contributors or main-vs-branches could be richer for some repos. test both.
- tags as gravity is elegant but tag-less repos exist — fall back to biggest commits? merge commits?
- private repos = auth = friction. worth it, or stay public-only for the share loop?
- one poster per repo, or per-year editions (skyline-style annual drop)?

---

*paste a repo. see its shape. the rest takes care of itself.*
