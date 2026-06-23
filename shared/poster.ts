// Pure, DOM-free data model + analysis shared by client and server.
// Turns raw GitHub data into a deterministic PosterModel that the renderer
// paints. The five systems from the vision are computed here so client and
// server agree on the shape of a repo.

import { colorForLanguage } from "./linguist";

// prerelease tag names we don't want as release landmarks / labels
const PRERELEASE = /(canary|nightly|alpha|beta|-rc|\.rc|preview|-pre|dev\d|snapshot)/i;

// Hand-picked palettes for specific repos (keyed by lowercase owner/name).
// These override the auto language colours for the ARTWORK only — the data
// panel still shows the real languages. Colours are listed dominant-first.
export const REPO_PALETTES: Record<string, string[]> = {
  // Next.js: monochrome + very dark. Charcoals just above the near-black paper
  // so the gradient stays subtle and the poster reads mostly black.
  "vercel/next.js": ["#343434", "#1e1e1e", "#454545"]
};

// Optional dark/custom paper (poster background) per repo. When set, the
// renderer inverts its ink (text/marks/scorebox) to stay legible.
export const REPO_PAPER: Record<string, string> = {
  "vercel/next.js": "#0b0b0b"
};

export type WeekStat = {
  /** unix seconds at start of the week */
  t: number;
  /** lines added that week */
  add: number;
  /** lines deleted that week (positive magnitude) */
  del: number;
};

export type RepoTag = {
  name: string;
  /** unix seconds of the tag's commit */
  t: number;
};

/** Raw data assembled by the GitHub client before analysis. */
export type RawRepo = {
  owner: string;
  name: string;
  description: string;
  stars: number;
  /** language name -> bytes */
  languages: Record<string, number>;
  weeks: WeekStat[];
  tags: RepoTag[];
  /** short commit SHAs used for the background texture */
  shas: string[];
  /** recent commit subjects, for the blended typography overlay */
  commits: string[];
  /** true when weekly churn came from the last-100-commits fallback, not the
   * full-history code_frequency stats (which may still be computing) */
  partial?: boolean;
};

export type PaletteEntry = {
  name: string;
  color: string;
  /** share of the codebase, 0..1 */
  weight: number;
};

export type GravityWell = {
  /** index into weeks[] where the release lands */
  weekIndex: number;
  /** unix seconds of the release (for time-based placement) */
  t: number;
  label: string;
};

export type PosterModel = {
  slug: string;
  owner: string;
  name: string;
  description: string;
  stars: number;
  weeks: WeekStat[];
  totalWeeks: number;
  firstT: number;
  lastT: number;
  /** largest single-week churn, for normalizing stroke counts */
  maxChurn: number;
  totalAdditions: number;
  totalDeletions: number;
  /** 0..1 — how volatile the repo's churn is over its life (was "drama") */
  volatility: number;
  palette: PaletteEntry[];
  /** hand-picked colours for the artwork (overrides palette for rendering) */
  paletteOverride?: { color: string; weight: number }[];
  /** optional poster background (paper) override; dark -> inverted ink */
  paper?: string;
  wells: GravityWell[];
  shas: string[];
  /** recent commit subjects, for the blended typography overlay */
  commits: string[];
  /** deterministic seed derived from the slug */
  seed: number;
};

export function parseRepoInput(value: string): { owner: string; name: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // Accept: owner/name, github.com/owner/name, full https url, with optional .git
  const cleaned = trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const owner = parts[0];
  const name = parts[1];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) {
    return null;
  }
  return { owner, name };
}

export function slugFor(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

/** Deterministic 32-bit seed from a string. */
export function hashSeed(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function analyze(raw: RawRepo): PosterModel {
  const slug = slugFor(raw.owner, raw.name);
  const weeks = raw.weeks.filter((w) => w.add > 0 || w.del > 0);
  const firstT = weeks.length ? weeks[0].t : 0;
  const lastT = weeks.length ? weeks[weeks.length - 1].t : 0;

  let maxChurn = 1;
  let totalAdditions = 0;
  let totalDeletions = 0;
  const churns: number[] = [];
  for (const w of weeks) {
    const churn = w.add + w.del;
    churns.push(churn);
    if (churn > maxChurn) {
      maxChurn = churn;
    }
    totalAdditions += w.add;
    totalDeletions += w.del;
  }

  // Volatility = coefficient of variation of weekly churn, squashed to 0..1.
  // Steady repos -> low; spiky/rewrite-heavy repos -> high.
  const volatility = volatilityScore(churns);

  // Palette: languages by byte share, sorted, with linguist colors.
  const totalBytes = Object.values(raw.languages).reduce((a, b) => a + b, 0) || 1;
  const palette: PaletteEntry[] = Object.entries(raw.languages)
    .map(([name, bytes]) => ({
      name,
      color: colorForLanguage(name),
      weight: bytes / totalBytes
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
  if (palette.length === 0) {
    palette.push({ name: "Unknown", color: "#8a8a8a", weight: 1 });
  }

  // optional hand-picked artwork palette (dominant-first) + paper override
  const overrideColors = REPO_PALETTES[slug];
  const paletteOverride = overrideColors
    ? overrideColors.map((color, i) => ({ color, weight: overrideColors.length - i }))
    : undefined;
  const paper = REPO_PAPER[slug];

  // Gravity wells = the repo's important moments. Prefer stable releases (drop
  // prereleases — canary/rc/beta/alpha/nightly — so labels stay clean). If the
  // repo publishes no releases at all (e.g. linux), fall back to the biggest
  // churn weeks so there's still something to mark as significant.
  const span = Math.max(1, lastT - firstT);
  let wells: GravityWell[] = raw.tags
    .filter((tag) => tag.t >= firstT && tag.t <= lastT && weeks.length > 0)
    .filter((tag) => !PRERELEASE.test(tag.name))
    .map((tag) => ({
      weekIndex: Math.round(((tag.t - firstT) / span) * (weeks.length - 1)),
      t: tag.t,
      label: tag.name
    }))
    // de-dupe wells that collapse onto the same week
    .filter((well, i, arr) => arr.findIndex((w) => w.weekIndex === well.weekIndex) === i)
    .slice(0, 12);

  if (wells.length === 0 && weeks.length > 2) {
    // churn-peak fallback: the heaviest weeks, spaced out, unlabelled.
    const ranked = weeks
      .map((w, i) => ({ i, t: w.t, churn: w.add + w.del }))
      .sort((a, b) => b.churn - a.churn);
    const chosen: typeof ranked = [];
    for (const cand of ranked) {
      if (chosen.length >= 6) break;
      // keep peaks spaced apart so they don't pile into one knot
      if (chosen.some((c) => Math.abs(c.i - cand.i) < weeks.length / 12)) continue;
      chosen.push(cand);
    }
    wells = chosen.map((c) => ({ weekIndex: c.i, t: c.t, label: "" }));
  }

  return {
    slug,
    owner: raw.owner,
    name: raw.name,
    description: raw.description,
    stars: raw.stars,
    weeks,
    totalWeeks: weeks.length,
    firstT,
    lastT,
    maxChurn,
    totalAdditions,
    totalDeletions,
    volatility,
    palette,
    paletteOverride,
    paper,
    wells,
    shas: raw.shas.slice(0, 400),
    commits: raw.commits.slice(0, 60),
    seed: hashSeed(slug)
  };
}

function volatilityScore(churns: number[]): number {
  if (churns.length < 2) {
    return 0.15;
  }
  const mean = churns.reduce((a, b) => a + b, 0) / churns.length;
  if (mean <= 0) {
    return 0.15;
  }
  const variance =
    churns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / churns.length;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation
  // squash: cv of ~2.5 -> near 1. Most repos land 0.5..1.5.
  return Math.max(0, Math.min(1, cv / 2.5));
}

/** Human label like "Mar 2021 – Jun 2026". */
export function formatDateRange(firstT: number, lastT: number): string {
  if (!firstT || !lastT) {
    return "";
  }
  const fmt = (sec: number) => {
    const d = new Date(sec * 1000);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  return `${fmt(firstT)} — ${fmt(lastT)}`;
}
