// Generative poster renderer (canvas 2D), tunable live via RenderParams.
//
// The five systems are the *driver*; in the final print they're invisible.
// What you see is a soft airbrushed spray gradient: thousands of soft pigment
// stamps walked along a flow field build smooth bands of language colour.
//   1. chrono-grid  — repo lifespan binned onto an 8-column grid (time -> space)
//   2. flow         — additions stream LEFT, deletions stream RIGHT (build vs prune)
//   3. gravity      — releases bend the flow toward them (invisible attractors)
//   4. volatility   — churn variance -> turbulence/curl of the flow
//   5. palette      — language bytes -> linguist colours, weighted per stamp
// plus the texture move: the repo's own commit messages + SHAs printed faintly
// full-bleed — the source material made visible.
//
// Wireframe mode exposes the scaffolding: the grid, the flow lines, and the
// gravity wells as rings + crosshairs.

import { hexToRgb } from "../shared/linguist";
import { formatDateRange, makeRng, type PosterModel } from "../shared/poster";

const W = 1200;
const H = 1600;
const ML = 96;
const MR = 76;
const MT = 96;
const MB = 150;
const GX0 = ML;
const GX1 = W - MR;
const GY0 = MT;
const GY1 = H - MB;
const PAPER = "#efece3";
const INK = "#1a1813";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// per-render context (set at the top of renderPoster). Lets us recolour for a
// dark paper override without threading params through every layer. Safe
// because renderPoster runs synchronously to completion.
let RP_PAPER = PAPER;
let RP_PAPER_RGB = { r: 239, g: 236, b: 227 };
let RP_INK = "26,24,19"; // marks/text/grid as "r,g,b"
let RP_INK_HEX = INK; // scorebox fill


export type RenderParams = {
  seed: number;
  volatility: number;
  density: number;
  flow: number;
  spread: number;
  releasePull: number;
  grain: number;
  gridOpacity: number;
  /** crop into the flow field and scale it up — bigger, calmer colour masses */
  zoom: number;
  /** translucent era bands under the flow field, inspired by watercolor washes */
  watercolor: number;
  /** render the gradient as an ordered (Bayer) halftone dither */
  dither: boolean;
  /** what fills the dithered cells: round dots, or hex chars from the SHAs */
  ditherStyle: "dots" | "hex";
  /** dither cell size in px — smaller = finer */
  pixelSize: number;
  /** how much of the poster the data-driven dither covers (0..1) */
  ditherCoverage: number;
  /** contrast of the actual dither marks, without painting square cells */
  ditherContrast: number;
  /** faint commit-message + SHA wallpaper, layered on top */
  sourceText: number;
  /** number of scattered vertical tick marks */
  tickCount: number;
  /** opacity of the tick marks */
  tickOpacity: number;
  /** show the thin full-res flow lines across the whole field (off by default;
   * release-converging lines still show regardless) */
  filaments: boolean;
  /** density of the data-block layer: random grid cells filled solid, sized +
   * shaded by their churn, coloured by language zone (0 = off) */
  blocks: number;
  /** negative space: how much clean paper breathes through — clean side margins
   * plus organic empty zones carved out of the paint (0 = paint everywhere) */
  negativeSpace: number;
  // --- topographic engine controls ---
  /** variant override: auto = seed decides, else force light/dark */
  dark: "auto" | "light" | "dark";
  /** iso-contour level spacing — smaller = denser lines */
  contourGap: number;
  /** contour stroke width */
  lineWeight: number;
  /** churn-dot size multiplier (0 hides them) */
  dotScale: number;
  wireframe: boolean;
};

export function defaultParams(model: PosterModel): RenderParams {
  return {
    seed: model.seed,
    volatility: model.volatility,
    density: 1,
    flow: 1,
    spread: 0.55,
    releasePull: 0.6,
    grain: 0.28,
    gridOpacity: 0,
    zoom: 1.6,
    // "telemetry print" defaults: the colour wash is the GROUND (calmer bloom),
    // while the repo's data — commit-text, halftone, year spine — reads as the
    // hero. Airbrush softness dialled down; typographic texture dialled up.
    watercolor: 0.18,
    dither: true,
    ditherStyle: "dots",
    pixelSize: 4,
    ditherCoverage: 0.62,
    ditherContrast: 0.58,
    sourceText: 0.46,
    tickCount: 30,
    tickOpacity: 0.4,
    filaments: false,
    blocks: 0.24,
    negativeSpace: 0.4,
    dark: "auto",
    contourGap: 0.105,
    lineWeight: 1.1,
    dotScale: 1,
    wireframe: false
  };
}

// rows fill the whole poster: ~8 weeks per row, so a short repo isn't crammed
// into the top and a long one stays legible.
function rowCount(model: PosterModel): number {
  return clamp(Math.ceil(model.totalWeeks / 8), 2, 40);
}

type Pt = { x: number; y: number };
type Cell = { col: number; row: number; cx: number; cy: number; add: number; del: number; t: number };
type RGB = { r: number; g: number; b: number };
type Stroke = { pts: Pt[]; color: RGB; isAdd: boolean; norm: number };

// ---------------------------------------------------------------- art engine
// repostr's poster is a topographic "git telemetry print": dense iso-contours
// over a noise flow field warped by weekly activity, with churn dots, release
// rings, a year-axis timeline scale and a typographic frame. Each repo/seed
// rolls a variant — light vs dark (glowing), a colour ground, and a zoom level.

const ART = { X0: 64, Y0: 74, X1: W - 64, Y1: H - 90 };
const ART_NEUTRALS: RGB[] = [
  "#e9e5d6", "#e4e7df", "#e7e2ea", "#dfe6e8", "#efe7d4", "#eae1de", "#dde4e2", "#e8e4dd"
].map(hexToRgb);

// Curated Riso/poster-grade palettes — d:1 = dark (i = glowing contour colour),
// d:0 = light (i = ink/contour colour). a = accent (release rings + pop). Bold,
// spectrum-spanning, decoupled from language so repos don't all look the same.
type Pal = { dark: boolean; ground: RGB; frameInk: RGB; lineCol: RGB; accent: RGB };
const PALS: Array<{ d: number; g: string; i: string; a: string }> = [
  { d: 0, g: "#e8e3d3", i: "#1b1915", a: "#e2603a" }, // sand / orange
  { d: 0, g: "#efe7d4", i: "#4a1e1b", a: "#c8463a" }, // cream / oxblood
  { d: 0, g: "#dce6dc", i: "#1f3a2e", a: "#d98a3d" }, // sage / ochre
  { d: 0, g: "#dbe5ec", i: "#16233a", a: "#e2603a" }, // pale blue / navy
  { d: 0, g: "#e7e1ee", i: "#352247", a: "#cf7fae" }, // lilac / plum
  { d: 0, g: "#efe7c6", i: "#23201a", a: "#2f6f6f" }, // butter / teal
  { d: 0, g: "#d8ece4", i: "#163a32", a: "#ef6f5a" }, // mint / coral
  { d: 0, g: "#f1ddcf", i: "#52211f", a: "#2f6f6f" }, // peach / maroon
  { d: 0, g: "#e9e6dd", i: "#13494a", a: "#e8a13a" }, // bone / deep teal
  { d: 0, g: "#ece5da", i: "#372a58", a: "#e0633f" }, // oat / violet
  { d: 0, g: "#e6e8ea", i: "#1c1c20", a: "#ff5da2" }, // grey / riso pink
  { d: 1, g: "#0c0c10", i: "#ff5da2", a: "#49d6e0" }, // black / pink glow
  { d: 1, g: "#0a0f18", i: "#49d6e0", a: "#ffd23f" }, // ink / cyan glow
  { d: 1, g: "#0b0e0a", i: "#b6f24a", a: "#ff8a3d" }, // black / acid green
  { d: 1, g: "#150d14", i: "#ff8a3d", a: "#ff5da2" }, // plum / orange glow
  { d: 1, g: "#100f0c", i: "#f2c14a", a: "#7fe0c0" }, // charcoal / gold
  { d: 1, g: "#0c0a14", i: "#b18cff", a: "#5de0a0" }, // black / violet glow
  { d: 1, g: "#0a1012", i: "#5de0c8", a: "#ff6f6f" }  // black / aqua glow
];
function satOf(c: RGB): number {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}
function pickPalette(rng: () => number, forced: string, base: RGB, mono: boolean): Pal {
  if (mono) {
    // repos with a greyscale dominant colour (e.g. next.js) stay black & white
    const isDark = forced === "dark" ? true : forced === "light" ? false : rng() < 0.45;
    return isDark
      ? { dark: true, ground: hexToRgb("#0c0c0d"), frameInk: { r: 233, g: 231, b: 226 }, lineCol: { r: 233, g: 231, b: 226 }, accent: { r: 150, g: 150, b: 150 } }
      : { dark: false, ground: hexToRgb("#ece9e2"), frameInk: hexToRgb("#1a1a18"), lineCol: hexToRgb("#1a1a18"), accent: { r: 95, g: 95, b: 95 } };
  }
  let pool = PALS;
  if (forced === "light") pool = PALS.filter((p) => !p.d);
  else if (forced === "dark") pool = PALS.filter((p) => p.d);
  const p = pool[Math.floor(rng() * pool.length)] || PALS[0];
  const ground = hexToRgb(p.g);
  const lineCol = hexToRgb(p.i);
  // ~1/3 of the time tie the accent to the repo's dominant language hue
  const accent = rng() < 0.33 ? base : hexToRgb(p.a);
  const frameInk = p.d ? { r: 230, g: 228, b: 222 } : lineCol;
  return { dark: !!p.d, ground, frameInk, lineCol, accent };
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
}
function lightenC(c: RGB, t: number): RGB {
  return lerpRgb(c, { r: 255, g: 255, b: 255 }, t);
}
function darkenC(c: RGB, t: number): RGB {
  return lerpRgb(c, { r: 0, g: 0, b: 0 }, t);
}

// 2D simplex noise (Gustavson), seeded — the flow field the contours trace.
function createNoise2D(seed: number): (x: number, y: number) => number {
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const perm = new Uint8Array(512);
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    const j = s % (i + 1);
    const t = src[i];
    src[i] = src[j];
    src[j] = t;
  }
  for (let i = 0; i < 256; i++) {
    perm[i] = src[i];
    perm[i + 256] = src[i];
  }
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const dot = (g: number[], x: number, y: number) => g[0] * x + g[1] * y;
  return (xin, yin) => {
    const sk = (xin + yin) * F2;
    const i = Math.floor(xin + sk);
    const j = Math.floor(yin + sk);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const gi0 = perm[ii + perm[jj]] % 8;
    const gi1 = perm[ii + i1 + perm[jj + j1]] % 8;
    const gi2 = perm[ii + 1 + perm[jj + 1]] % 8;
    let n0 = 0, n1 = 0, n2 = 0;
    let tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt >= 0) { tt *= tt; n0 = tt * tt * dot(G[gi0], x0, y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt >= 0) { tt *= tt; n1 = tt * tt * dot(G[gi1], x1, y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt >= 0) { tt *= tt; n2 = tt * tt * dot(G[gi2], x2, y2); }
    return 70 * (n0 + n1 + n2);
  };
}

// marching squares: draw iso-lines of a scalar field at the given levels.
function isoContours(
  ctx: CanvasRenderingContext2D,
  field: (x: number, y: number) => number,
  levels: number[],
  cell: number,
  X0: number,
  Y0: number,
  X1: number,
  Y1: number,
  mask?: (x: number, y: number) => boolean
): void {
  const cols = Math.ceil((X1 - X0) / cell);
  const rows = Math.ceil((Y1 - Y0) / cell);
  const vals: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    vals[j] = [];
    for (let i = 0; i <= cols; i++) vals[j][i] = field(X0 + i * cell, Y0 + j * cell);
  }
  const segTable: Record<number, number[]> = {
    1: [3, 2], 2: [2, 1], 3: [3, 1], 4: [0, 1], 6: [0, 2], 7: [0, 3],
    8: [0, 3], 9: [0, 2], 11: [0, 1], 12: [3, 1], 13: [2, 1], 14: [3, 2]
  };
  const pt = (edge: number, x: number, y: number, tl: number, tr: number, br: number, bl: number, lv: number): [number, number] => {
    const f = (a: number, b: number) => {
      const d = b - a;
      return Math.abs(d) < 1e-9 ? 0.5 : (lv - a) / d;
    };
    if (edge === 0) return [x + cell * f(tl, tr), y];
    if (edge === 1) return [x + cell, y + cell * f(tr, br)];
    if (edge === 2) return [x + cell * f(bl, br), y + cell];
    return [x, y + cell * f(tl, bl)];
  };
  for (const lv of levels) {
    ctx.beginPath();
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x = X0 + i * cell, y = Y0 + j * cell;
        if (mask && !mask(x, y)) continue; // negative-space carve-out
        const tl = vals[j][i], tr = vals[j][i + 1], br = vals[j + 1][i + 1], bl = vals[j + 1][i];
        let idx = 0;
        if (tl > lv) idx |= 8;
        if (tr > lv) idx |= 4;
        if (br > lv) idx |= 2;
        if (bl > lv) idx |= 1;
        const draw = (a: number, b: number) => {
          const p0 = pt(a, x, y, tl, tr, br, bl, lv);
          const p1 = pt(b, x, y, tl, tr, br, bl, lv);
          ctx.moveTo(p0[0], p0[1]);
          ctx.lineTo(p1[0], p1[1]);
        };
        if (idx === 5) { draw(0, 3); draw(2, 1); }
        else if (idx === 10) { draw(0, 1); draw(3, 2); }
        else if (segTable[idx]) draw(segTable[idx][0], segTable[idx][1]);
      }
    ctx.stroke();
  }
}

// big repo name set 90° up the right edge — a typographic anchor that reads as
// a ghosted watermark behind the field (timeline lives on the left, so no clash)
function artSideName(ctx: CanvasRenderingContext2D, model: PosterModel, ink: RGB): void {
  const { X1, Y0, Y1 } = ART;
  const name = (model.name || "").toLowerCase();
  if (!name) return;
  const FH = Y1 - Y0;
  ctx.font = "700 100px Helvetica, Arial, sans-serif";
  const w100 = ctx.measureText(name).width || 1;
  const fs = clamp((FH * 0.92) / w100 * 100, 40, 230);
  ctx.font = `700 ${fs}px Helvetica, Arial, sans-serif`;
  const tw = ctx.measureText(name).width;
  ctx.save();
  ctx.translate(X1 - fs - 4, Y1 - (FH - tw) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = rgba(ink, 0.16);
  ctx.fillText(name, 0, 0);
  ctx.restore();
}

function artTimeline(ctx: CanvasRenderingContext2D, model: PosterModel, ink: RGB): void {
  if (!model.firstT || !model.lastT) return;
  const { X0, Y0, Y1 } = ART;
  const span = Math.max(1, model.lastT - model.firstT);
  const yOf = (t: number) => Y0 + ((t - model.firstT) / span) * (Y1 - Y0);
  const ax = X0 + 6;
  ctx.strokeStyle = rgba(ink, 0.42);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ax, Y0);
  ctx.lineTo(ax, Y1);
  ctx.stroke();
  const fy = new Date(model.firstT * 1000).getUTCFullYear();
  const ly = new Date(model.lastT * 1000).getUTCFullYear();
  const step = Math.max(1, Math.ceil((ly - fy + 1) / 12));
  ctx.font = `14px ${MONO}`;
  ctx.textBaseline = "middle";
  const darkInk = (ink.r * 0.299 + ink.g * 0.587 + ink.b * 0.114) / 255 > 0.5;
  for (let Y = fy; Y <= ly; Y++) {
    const isL = (Y - fy) % step === 0 || Y === ly;
    const ys = Date.UTC(Y, 0, 1) / 1000;
    if (ys < model.firstT || ys > model.lastT) continue;
    const y = yOf(ys);
    ctx.strokeStyle = rgba(ink, isL ? 0.55 : 0.28);
    ctx.beginPath();
    ctx.moveTo(ax, y);
    ctx.lineTo(ax + (isL ? 9 : 5), y);
    ctx.stroke();
    if (isL) {
      const lx = ax + 14;
      const t = String(Y);
      const tw = ctx.measureText(t).width;
      ctx.fillStyle = darkInk ? "rgba(12,13,18,0.5)" : "rgba(244,242,235,0.62)";
      ctx.fillRect(lx - 3, y - 9, tw + 6, 18);
      ctx.fillStyle = rgba(ink, 0.82);
      ctx.textAlign = "left";
      ctx.fillText(t, lx, y);
    }
  }
}

function artFooter(ctx: CanvasRenderingContext2D, model: PosterModel, ink: RGB): void {
  const { X0, X1, Y1 } = ART;
  const fy = new Date((model.firstT || 0) * 1000).getUTCFullYear();
  const ly = new Date((model.lastT || 0) * 1000).getUTCFullYear();
  // one full-width rectangle with two rows; each row has a left + right field
  const y0 = Y1 + 12, h = 52, mid = y0 + h / 2;
  ctx.strokeStyle = rgba(ink, 0.5);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(X0, y0, X1 - X0, h);
  ctx.beginPath();
  ctx.moveTo(X0, mid);
  ctx.lineTo(X1, mid);
  ctx.stroke();
  ctx.font = `13px ${MONO}`;
  ctx.textBaseline = "middle";
  const padL = X0 + 10, padR = X1 - 10, r1 = y0 + h * 0.25, r2 = y0 + h * 0.75;
  // top row: repo · span
  ctx.fillStyle = rgba(ink, 0.82);
  ctx.textAlign = "left";
  ctx.fillText(`${model.owner}/${model.name}`.toLowerCase(), padL, r1);
  ctx.fillStyle = rgba(ink, 0.7);
  ctx.textAlign = "right";
  ctx.fillText(`${fy}  →  ${ly}`, padR, r1);
  // bottom row: identity · stats (no language — that lives in the app caption)
  ctx.fillStyle = rgba(ink, 0.6);
  ctx.textAlign = "left";
  ctx.fillText("repostr.lakebed.app — git history as print", padL, r2);
  ctx.textAlign = "right";
  ctx.fillText(`${model.totalWeeks} wks · ${model.wells.length} rel`, padR, r2);
}

function artPoster(ctx: CanvasRenderingContext2D, model: PosterModel, params: RenderParams): void {
  const { X0, Y0, X1, Y1 } = ART;
  const pal = model.paletteOverride?.length
    ? model.paletteOverride.map((p) => p.color)
    : model.palette.map((p) => p.color);
  const base = hexToRgb(pal[0] || "#8a8a8a");
  const c2 = hexToRgb(pal[1] || pal[0] || "#8a8a8a");
  // shuffle re-rolls everything via params.seed (model.seed is the fixed default)
  const seed = (params.seed >>> 0) || model.seed;
  const rng = makeRng((seed ^ 0xa5a5a5) >>> 0);

  // variant: dark (glowing) vs light (ink on coloured ground). The seed rolls it;
  // a dark paper override or the `dark` control can force it. We always consume
  // the roll so later rolls (ground, zoom) stay deterministic.
  const paperLum = model.paper
    ? (hexToRgb(model.paper).r * 0.299 + hexToRgb(model.paper).g * 0.587 + hexToRgb(model.paper).b * 0.114) / 255
    : 1;
  const forced = params.dark !== "auto" ? params.dark : model.paper && paperLum < 0.45 ? "dark" : "auto";
  // a greyscale dominant colour (e.g. next.js's charcoal override) -> stay B&W
  const mono = satOf(base) < 0.12;
  const PAL = pickPalette(rng, forced, base, mono);
  const dark = PAL.dark;
  const glow = dark;
  const ink = PAL.frameInk;
  ctx.fillStyle = rgba(PAL.ground, 1);
  ctx.fillRect(0, 0, W, H);

  // zoom widens the contour masses (slider/shuffle-controlled); the seed only
  // shifts the crop so each poster samples a different patch of the field
  const zoom = clamp(params.zoom || 1, 1, 4);
  const ox = rng() * 5000, oy = rng() * 5000;
  const noise = createNoise2D(seed);
  const sc = 0.0022 / zoom;
  const span = Math.max(1, model.lastT - model.firstT);
  const maxChurn = Math.max(1, ...model.weeks.map((w) => w.add + w.del));
  const actAt = (f: number) => {
    let best = 0;
    for (const w of model.weeks) {
      const wf = (w.t - model.firstT) / span;
      if (Math.abs(wf - f) < 0.03) best = Math.max(best, (w.add + w.del) / maxChurn);
    }
    return best;
  };
  const field = (x: number, y: number) => {
    const act = actAt((y - Y0) / (Y1 - Y0));
    return noise((x + ox) * sc * (1 + act * 0.9), (y + oy) * sc * (1 + act * 0.5));
  };

  // STRUCTURED NEGATIVE SPACE — the field is split into blocks of VARYING width
  // and height (seeded column/row edges), and whole blocks are sparsely dropped,
  // so the empties read as irregular architectural tiles rather than a uniform
  // grid of equal rectangles.
  const ns = clamp(params.negativeSpace, 0, 0.85);
  const mrng = makeRng((seed ^ 0x51ed270b) >>> 0);
  const baseU = (X1 - X0) / 16;
  const edges = (lo: number, hi: number, units: number[]): number[] => {
    const e = [lo];
    while (e[e.length - 1] < hi - 2) {
      const m = units[Math.floor(mrng() * units.length)];
      e.push(Math.min(hi, e[e.length - 1] + m * baseU));
    }
    return e;
  };
  const colEdges = edges(X0, X1, [1, 2, 2, 3, 4]);
  const rowEdges = edges(Y0, Y1, [1, 2, 2, 3]);
  const idxOf = (v: number, e: number[]): number => {
    for (let i = 0; i < e.length - 1; i++) if (v >= e[i] && v < e[i + 1]) return i;
    return Math.max(0, e.length - 2);
  };
  const cellHash = (ci: number, ri: number): number => {
    let v = (seed ^ Math.imul(ci, 73856093) ^ Math.imul(ri, 19349663)) >>> 0;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v >>> 0) % 100000) / 100000;
  };
  const present = (x: number, y: number): boolean => {
    if (ns <= 0.001) return true;
    return cellHash(idxOf(x, colEdges), idxOf(y, rowEdges)) >= ns * 0.6;
  };

  const gap = clamp(params.contourGap || 0.105, 0.05, 0.28);
  const lw = clamp(params.lineWeight || 1.1, 0.5, 2.5);
  const dotScale = clamp(params.dotScale ?? 1, 0, 3);
  const levels: number[] = [];
  for (let l = -0.88; l <= 0.88; l += gap) levels.push(l);

  if (params.wireframe) {
    ctx.strokeStyle = rgba(ink, 0.5);
    ctx.lineWidth = 1;
    isoContours(ctx, field, levels, 6, X0, Y0, X1, Y1);
    artTimeline(ctx, model, ink);
    artFooter(ctx, model, ink);
    return;
  }

  const drawContours = (
    fld: (x: number, y: number) => number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    msk?: (x: number, y: number) => boolean
  ) => {
    if (glow) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = lw * 3.6;
      ctx.strokeStyle = rgba(PAL.lineCol, 0.05);
      isoContours(ctx, fld, levels, 5, x0, y0, x1, y1, msk);
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgba(lightenC(PAL.lineCol, 0.18), 0.55);
      isoContours(ctx, fld, levels, 5, x0, y0, x1, y1, msk);
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgba(PAL.accent, 0.2);
      isoContours(ctx, (x, y) => fld(x + 150, y + 90), levels, 6, x0, y0, x1, y1, msk);
      ctx.restore();
    } else {
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgba(PAL.lineCol, 0.5);
      isoContours(ctx, fld, levels, 5, x0, y0, x1, y1, msk);
    }
  };

  // base field everywhere except the dropped blocks
  drawContours(field, X0, Y0, X1, Y1, present);

  // those dropped blocks become MAGNIFIER LENSES — each reveals a zoomed-in
  // close-up of the same field, framed, so empties turn into focal windows.
  if (ns > 0.001) {
    const MAG = 2.4;
    for (let ci = 0; ci < colEdges.length - 1; ci++) {
      for (let ri = 0; ri < rowEdges.length - 1; ri++) {
        if (cellHash(ci, ri) >= ns * 0.6) continue;
        const bx0 = colEdges[ci], bx1 = colEdges[ci + 1];
        const by0 = rowEdges[ri], by1 = rowEdges[ri + 1];
        const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
        const fmag = (x: number, y: number) => field(cx + (x - cx) / MAG, cy + (y - cy) / MAG);
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx0, by0, bx1 - bx0, by1 - by0);
        ctx.clip();
        drawContours(fmag, bx0, by0, bx1, by1);
        ctx.restore();
        ctx.strokeStyle = rgba(ink, glow ? 0.32 : 0.24);
        ctx.lineWidth = 1;
        ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
      }
    }
  }

  // churn dots, one per week on its time-row
  const dotCol = glow ? rgba(lightenC(PAL.lineCol, 0.3), 0.92) : rgba(PAL.lineCol, 0.85);
  for (const w of model.weeks) {
    const n = (w.add + w.del) / maxChurn;
    if (n <= 0) continue;
    const y = Y0 + ((w.t - model.firstT) / span) * (Y1 - Y0);
    const nx = noise(w.t * 0.00006 + oy, 5.1);
    const x = X0 + (0.16 + 0.72 * (0.5 + nx * 0.5)) * (X1 - X0);
    const r = (2 + Math.sqrt(n) * 14) * dotScale;
    if (r < 0.4) continue;
    if (!present(x, y)) continue;
    ctx.fillStyle = dotCol;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // release rings
  for (const wl of model.wells) {
    if (wl.t < model.firstT || wl.t > model.lastT) continue;
    const y = Y0 + ((wl.t - model.firstT) / span) * (Y1 - Y0);
    const nx = noise(wl.t * 0.00006 + oy, 2.7);
    const x = X0 + (0.16 + 0.72 * (0.5 + nx * 0.5)) * (X1 - X0);
    ctx.strokeStyle = rgba(PAL.accent, glow ? 0.95 : 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  artTimeline(ctx, model, ink);
  artFooter(ctx, model, ink);
  // white-noise grain reads much hotter on a dark ground — keep just a touch
  grain(ctx, glow ? Math.min(params.grain, 0.16) * 0.75 : params.grain);
}

export function renderPoster(
  canvas: HTMLCanvasElement,
  model: PosterModel,
  params: RenderParams,
  scale = 1.5
): void {
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";
  artPoster(ctx, model, params);
}

// renders the print poster to a fresh high-resolution canvas (for PNG export)
export function renderToDataUrl(model: PosterModel, params: RenderParams, scale = 3): string {
  const off = document.createElement("canvas");
  renderPoster(off, model, params, scale);
  return off.toDataURL("image/png");
}

// Renders the OG share image: just the poster itself at its native tall 3:4,
// no card chrome or text. Uploaded by the client and served from /og.
//
// Lakebed string() columns cap at 64KB, so the base64 JPEG must land under
// ~62k chars. We render the poster once at full res, then downscale + lower
// quality until the encoded image fits. JPEG (not PNG) because the poster's
// grain is near-incompressible as PNG.
export function renderOgDataUrl(model: PosterModel, params: RenderParams): string {
  const src = document.createElement("canvas");
  renderPoster(src, model, params, 1); // 1200x1600 source

  const MAX_B64 = 62000;
  const widths = [600, 528, 456, 384, 324];
  const qualities = [0.6, 0.5, 0.42, 0.35, 0.3];
  let smallest = "";
  let smallestLen = Infinity;

  for (const w of widths) {
    const h = Math.round((w * src.height) / src.width);
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    for (const q of qualities) {
      const url = off.toDataURL("image/jpeg", q);
      const len = (url.split(",")[1] ?? "").length;
      if (len <= MAX_B64) return url;
      if (len < smallestLen) {
        smallestLen = len;
        smallest = url;
      }
    }
  }
  // Nothing fit (very grainy poster) — return the smallest we made; the server
  // rejects oversize uploads and the /og SVG fallback covers the slug.
  return smallest;
}

// ----------------------------------------------------------------- geometry

// Bin by CALENDAR TIME so every cell is an equal time slice: rows map to equal
// spans, dead periods show as empty cells, and the year markers run linearly to
// the true last date (matching the corner box).
function buildCells(model: PosterModel, cols: number, rows: number): Cell[] {
  const n = cols * rows;
  const cellW = (GX1 - GX0) / cols;
  const cellH = (GY1 - GY0) / rows;
  const span = Math.max(1, model.lastT - model.firstT);
  const agg = Array.from({ length: n }, () => ({ add: 0, del: 0 }));
  for (const w of model.weeks) {
    let b = Math.floor(((w.t - model.firstT) / span) * n);
    b = Math.max(0, Math.min(n - 1, b));
    agg[b].add += w.add;
    agg[b].del += w.del;
  }
  const cells: Cell[] = [];
  for (let b = 0; b < n; b++) {
    const col = b % cols;
    const row = Math.floor(b / cols);
    cells.push({
      col,
      row,
      cx: GX0 + (col + 0.5) * cellW,
      cy: GY0 + (row + 0.5) * cellH,
      add: agg[b].add,
      del: agg[b].del,
      t: model.firstT + ((b + 0.5) / n) * span // slice centre time
    });
  }
  return cells;
}

function wellPositions(model: PosterModel, cols: number, rows: number): Pt[] {
  const n = cols * rows;
  const cellW = (GX1 - GX0) / cols;
  const cellH = (GY1 - GY0) / rows;
  const span = Math.max(1, model.lastT - model.firstT);
  return model.wells.map((w) => {
    let b = Math.floor(((w.t - model.firstT) / span) * n);
    b = Math.max(0, Math.min(n - 1, b));
    return {
      x: GX0 + ((b % cols) + 0.5) * cellW,
      y: GY0 + (Math.floor(b / cols) + 0.5) * cellH
    };
  });
}

// ----------------------------------------------------------------- strokes

function buildStrokes(
  ctx: CanvasRenderingContext2D,
  model: PosterModel,
  params: RenderParams,
  cells: Cell[],
  wells: Pt[],
  rng: () => number
): Stroke[] {
  const cellW = (GX1 - GX0) / 8;
  const cellH = (GY1 - GY0) / rowCount(model);
  const live = cells.filter((c) => c.add + c.del > 0);
  const maxChurn = Math.max(1, ...live.map((c) => c.add + c.del));
  const total = live.reduce((a, c) => a + c.add + c.del, 0) || 1;
  const budget = clamp(Math.round((1500 + model.volatility * 1400) * params.density), 200, 4200);
  const palette = buildPalette(model, rng);
  const reach = (GX1 - GX0) * 0.46 * params.flow;

  const strokes: Stroke[] = [];
  for (let s = 0; s < budget; s++) {
    const cell = pickWeighted(live, rng() * total);
    if (!cell) continue;
    const churn = cell.add + cell.del;
    const norm = churn / maxChurn;
    const isAdd = rng() < (churn > 0 ? cell.add / churn : 0.5);

    const origin: Pt = {
      x: cell.cx + (rng() - 0.5) * cellW * 0.7,
      y: cell.cy + (rng() - 0.5) * cellH * (0.5 + params.spread * 1.8)
    };
    const base = isAdd ? Math.PI : 0;
    const lean = (rng() - 0.5) * (0.35 + params.spread * 0.9);
    const len = reach * (0.25 + 0.75 * norm) * (0.5 + rng() * 1.0);

    // language chosen by a smooth spatial field (coherent colour zones), shade
    // chosen at random within it (richness without mud).
    const lang = pickLang(palette, coherentNoise(origin.x, origin.y, model.seed));
    const color = lang.shades[(rng() * lang.shades.length) | 0] ?? lang.shades[0];

    strokes.push({
      pts: walk(origin, base + lean, len, params, wells, model.seed),
      color,
      isAdd,
      norm
    });
  }
  void ctx;
  return strokes;
}

function walk(
  origin: Pt,
  ang0: number,
  len: number,
  params: RenderParams,
  wells: Pt[],
  seed: number
): Pt[] {
  const steps = clamp(Math.floor(len / 9), 3, 60);
  const stepLen = len / steps;
  let ang = ang0;
  let pos = { ...origin };
  const pts: Pt[] = [{ ...pos }];
  for (let i = 0; i < steps; i++) {
    ang += curlField(pos.x, pos.y, seed) * params.volatility * 0.13;
    ang += gravityNudge(pos, ang, wells, params.releasePull);
    pos = { x: pos.x + Math.cos(ang) * stepLen, y: pos.y + Math.sin(ang) * stepLen };
    pts.push({ ...pos });
  }
  return pts;
}

// Each repo gets a distinct flow *character*, not just a phase offset, so two
// repos with the same languages still look different. The seed sets the field's
// wavelength (tight nervous curls vs broad lazy sweeps), a global rotation (the
// direction the current runs), and how much turbulence rides on top.
function curlField(x: number, y: number, seed: number): number {
  const s = (seed % 1000) * 0.001;
  const fs = 0.55 + ((seed >>> 3) % 100) / 100 * 1.7; // 0.55..2.25 wavelength
  const rot = ((seed >>> 7) % 360) * (Math.PI / 180); // current direction
  const mix = 0.25 + ((seed >>> 11) % 100) / 100 * 0.7; // turbulence weight
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const xr = x * cr - y * sr;
  const yr = x * sr + y * cr;
  return (
    Math.sin(xr * 0.011 * fs + s * 6.2) +
    Math.cos(yr * 0.013 * fs + s * 9.1) +
    mix * Math.sin((xr + yr) * 0.007 * fs + s * 3.3)
  );
}

function gravityNudge(pos: Pt, ang: number, wells: Pt[], pull: number): number {
  if (pull <= 0) return 0;
  let nudge = 0;
  const R = 250;
  for (const w of wells) {
    const dx = w.x - pos.x;
    const dy = w.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > R || dist < 1) continue;
    let diff = Math.atan2(dy, dx) - ang;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    nudge += diff * (1 - dist / R) * 0.12 * pull;
  }
  return nudge;
}

// ----------------------------------------------------------------- spray paint

// The smoothness trick: paint the colour field at LOW resolution, then upscale
// with bilinear smoothing. Lumps become buttery large-scale gradients. Fine
// grain is added separately so the result is "smooth but noisy" — the airbrush.
// The zoom crop, shared by the painted field and the wireframe so both frame
// the SAME sub-region. A 1.8x baseline is folded in so the slider's 1.0 already
// reads as a close, calm crop; higher pushes further in. fx/fy (seeded) pick
// which part of the field the crop lands on.
function zoomCrop(
  params: RenderParams,
  seed: number
): { z: number; fx: number; fy: number } {
  return {
    z: clamp(params.zoom, 1, 4) * 1.8,
    fx: 0.3 + ((seed % 41) / 41) * 0.4,
    fy: 0.3 + (((seed >> 5) % 37) / 37) * 0.4
  };
}

function sprayField(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  rng: () => number,
  params: RenderParams,
  model: PosterModel
): Field {
  const seed = model.seed;
  const fw = 280; // field resolution (also sampled by the dither overlay)
  const fh = Math.round((fw * H) / W);
  const fc = document.createElement("canvas");
  fc.width = fw;
  fc.height = fh;
  const f = fc.getContext("2d");
  if (!f) return;
  f.fillStyle = RP_PAPER;
  f.fillRect(0, 0, fw, fh);

  const sx = fw / W;
  const sy = fh / H;
  const sprites = new Map<string, HTMLCanvasElement>();
  const sprite = (c: RGB): HTMLCanvasElement => {
    const key = `${c.r},${c.g},${c.b}`;
    let s = sprites.get(key);
    if (!s) {
      s = softSprite(c);
      sprites.set(key, s);
    }
    return s;
  };

  // zoom: sample a sub-region of the field (close-up crop) for big calm masses.
  // Computed up-front so the negative-space mask can be evaluated in the SAME
  // canvas space the crop lands in — that's what keeps the empty zones (and the
  // clean side margins) aligned across the spray, the dither and the blocks.
  const { z, fx, fy } = zoomCrop(params, seed);
  const srcW = fw / z;
  const srcH = fh / z;
  const srcX = (fw - srcW) * fx;
  const srcY = (fh - srcH) * fy;
  const ns = clamp(params.negativeSpace, 0, 1);

  const scaleR = fw / 92; // keep footprint constant across field resolutions
  // BASE layer: large, faint soft dabs along each stroke that merge into the
  // buttery airbrush masses (the soft cloud look). Thin flow detail can't live
  // here — it would blur away on upscale — so it's drawn full-res afterwards.
  for (const stroke of strokes) {
    const sp = sprite(stroke.color);
    const n = stroke.pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const taper = Math.sin(t * Math.PI);
      const rad = (3.2 + stroke.norm * 8) * (0.5 + taper * 0.9) * scaleR;
      let a = (0.05 + stroke.norm * 0.1) * (0.4 + taper * 0.9);
      const x = stroke.pts[i].x * sx + (rng() - 0.5) * rad * 0.6;
      const y = stroke.pts[i].y * sy + (rng() - 0.5) * rad * 0.6;
      if (ns > 0.001) {
        // canvas-normalized position this field dab maps to after the crop
        const m = breathMask((x - srcX) / srcW, (y - srcY) / srcH, seed, ns);
        if (m < 0.05) continue; // truly empty -> leave clean paper
        a *= m;
      }
      f.globalAlpha = a;
      f.drawImage(sp, x - rad, y - rad, rad * 2, rad * 2);
    }
  }
  f.globalAlpha = 1;

  // always lay down the smooth gradient as the base
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  (ctx as unknown as { imageSmoothingQuality: string }).imageSmoothingQuality = "high";
  ctx.drawImage(fc, srcX, srcY, srcW, srcH, 0, 0, W, H);
  ctx.restore();

  return { f, fw, fh, srcX, srcY, srcW, srcH };
}

function watercolorWash(
  ctx: CanvasRenderingContext2D,
  model: PosterModel,
  params: RenderParams,
  width: number,
  height: number
): void {
  const amount = clamp(params.watercolor, 0, 1);
  if (amount <= 0.001) return;

  const rng = makeRng(((params.seed ^ 0x85ebca6b) >>> 0) || 1);
  const palette = buildPalette(model, rng);
  const rows = rowCount(model);
  const cells = buildCells(model, 8, rows);
  const maxChurn = Math.max(1, ...cells.map((c) => c.add + c.del));
  const regions = clamp(Math.round(3 + model.volatility * 5), 3, 8);
  const regionH = height / regions;
  const layerCount = Math.round(36 + amount * 140 + model.volatility * 45);
  const jitter = (10 + model.volatility * 34 + params.spread * 18) * (height / H);
  const baseAlpha = amount * (0.018 + model.volatility * 0.012);
  const darkPaper = (RP_PAPER_RGB.r * 0.299 + RP_PAPER_RGB.g * 0.587 + RP_PAPER_RGB.b * 0.114) / 255 < 0.45;

  ctx.save();
  ctx.globalCompositeOperation = darkPaper ? "screen" : "multiply";
  for (let r = 0; r < regions; r++) {
    const top = r * regionH;
    const t0 = r / regions;
    const t1 = (r + 0.5) / regions;
    const eraCells = cells.filter((c) => {
      const f = rows <= 1 ? 0 : c.row / (rows - 1);
      return f >= t0 && f < (r + 1) / regions;
    });
    const eraChurn =
      eraCells.reduce((sum, c) => sum + c.add + c.del, 0) / Math.max(1, eraCells.length);
    const churnLift = Math.log1p(eraChurn) / Math.log1p(maxChurn);
    const a = baseAlpha * (0.65 + churnLift * 1.3);
    const topColor = washColor(pickLang(palette, coherentNoise(W * 0.35, GY0 + t0 * (GY1 - GY0), model.seed)), rng);
    const botColor = washColor(pickLang(palette, coherentNoise(W * 0.65, GY0 + t1 * (GY1 - GY0), model.seed)), rng);

    for (let l = 0; l < layerCount; l++) {
      const y = top + (rng() * (regionH + jitter * 2) - jitter);
      const x = rng() * width - width * 0.18;
      const w = width * (0.45 + rng() * 0.85);
      const h = regionH * (0.12 + rng() * 0.55);
      const mix = clamp((y - top) / regionH, 0, 1);
      const c = lerpRgb(topColor, botColor, mix);
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      ctx.globalAlpha = a * (0.45 + rng() * 1.2);
      ctx.fillRect(x, y, w, h);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

function washColor(lang: LangPigment, rng: () => number): RGB {
  const shades = lang.shades;
  return shades[clamp(Math.round((0.35 + rng() * 0.55) * (shades.length - 1)), 0, shades.length - 1)];
}

type Field = {
  f: CanvasRenderingContext2D;
  fw: number;
  fh: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
};

// FILAMENT pass: thin, faint flow lines drawn at FULL canvas resolution on top
// of the smooth airbrush base — a delicate version of the wireframe laid over
// the painting, so the current running through the soft masses reads clearly.
// Drawn full-res (not into the low-res field) so the lines don't blur away.
// Mapped through the same zoom crop the base used, so they line up exactly.
function filamentPass(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  field: Field,
  strength: number,
  rng: () => number,
  wells: Pt[]
): void {
  const { fw, fh, srcX, srcY, srcW, srcH } = field;
  const sx = fw / W;
  const sy = fh / H;
  const kx = W / srcW; // field px -> display px (folds in the zoom crop)
  const ky = H / srcH;
  const tx = (x: number) => (x * sx - srcX) * kx;
  const ty = (y: number) => (y * sy - srcY) * ky;

  // Only a sparse, randomly-chosen subset of strokes show as filaments, so they
  // read as a scattered few flow lines rather than a dense net. Deterministic
  // (seeded rng) so a poster always draws the same ones; reroll reshuffles them.
  const SHOW = 0.18;
  const NEAR = 200; // a filament tip within this of a release is "converging"

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    const n = stroke.pts.length;
    if (n < 2) continue;
    // does this filament run into a release? if so it always shows, brighter +
    // thicker, so you see the current pulling into the important moments.
    const tip = stroke.pts[n - 1];
    let near = false;
    for (const w of wells) {
      if (Math.hypot(w.x - tip.x, w.y - tip.y) < NEAR) {
        near = true;
        break;
      }
    }
    const lucky = rng() < SHOW;
    const jitter = 0.6 + rng() * 0.8; // keep rng stream stable regardless of show
    // a sparse subset shows as flow lines; release-converging ones always show
    // (brighter + thicker) so the current pulling into releases reads.
    if (!near && !lucky) continue;

    const c = stroke.color;
    const boost = near ? 2.1 : 1;
    ctx.strokeStyle = `rgb(${c.r},${c.g},${c.b})`;
    ctx.globalAlpha = clamp((0.05 + stroke.norm * 0.12) * jitter * strength * boost, 0, 0.6);
    // super slim, only mildly thickened by churn, zoom, and convergence
    ctx.lineWidth = clamp((0.28 + stroke.norm * 0.65) * Math.sqrt(kx) * (near ? 1.7 : 1), 0.35, 2.4);
    ctx.beginPath();
    ctx.moveTo(tx(stroke.pts[0].x), ty(stroke.pts[0].y));
    for (let i = 1; i < n; i++) ctx.lineTo(tx(stroke.pts[i].x), ty(stroke.pts[i].y));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Release landmarks: at each release tag, a faint concentric ring + center node
// (echoing the wireframe's gravity rings) and a tiny version label — the repo's
// important moments printed onto the finished poster as "source made visible".
// Drawn full-res through the same zoom crop as the base so they sit exactly on
// their wells; wells cropped out of the zoom view are skipped.
function releaseLandmarks(
  ctx: CanvasRenderingContext2D,
  model: PosterModel,
  wells: Pt[],
  field: Field,
  strength: number
): void {
  if (!wells.length) return;
  const { fw, fh, srcX, srcY, srcW, srcH } = field;
  const sx = fw / W;
  const sy = fh / H;
  const kx = W / srcW;
  const ky = H / srcH;
  const tx = (x: number) => (x * sx - srcX) * kx;
  const ty = (y: number) => (y * sy - srcY) * ky;
  const r = clamp(7 * Math.sqrt(kx), 9, 30);

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(clamp(8 * Math.sqrt(kx), 9, 15))}px "JetBrains Mono", ui-monospace, monospace`;
  for (let i = 0; i < wells.length; i++) {
    const dx = tx(wells[i].x);
    const dy = ty(wells[i].y);
    if (dx < GX0 - 30 || dx > GX1 + 30 || dy < GY0 - 30 || dy > GY1 + 30) continue;

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `rgba(${RP_INK},${(0.38 * strength).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${RP_INK},${(0.18 * strength).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(dx, dy, r * 1.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(${RP_INK},${(0.8 * strength).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(dx, dy, 2.4, 0, Math.PI * 2);
    ctx.fill();

    const label = model.wells[i]?.label?.slice(0, 12);
    if (label) {
      ctx.fillStyle = `rgba(${RP_INK},${(0.6 * strength).toFixed(3)})`;
      ctx.fillText(label, dx + r + 5, dy);
    }
  }
  ctx.restore();
}

// can an s x s block be placed with top-left at (cx,cy) — in bounds and on
// only free cells of the SUB x SUB occupancy grid?
function fitsBlock(occ: Uint8Array, SUB: number, cx: number, cy: number, s: number): boolean {
  if (cx + s > SUB || cy + s > SUB) return false;
  for (let dy = 0; dy < s; dy++)
    for (let dx = 0; dx < s; dx++) if (occ[(cy + dy) * SUB + (cx + dx)]) return false;
  return true;
}

// Data-block layer: each time/language grid cell becomes a little unit-chart
// (waffle) of small squares. The NUMBER of filled squares ~ that period's churn
// (busy weeks fill more of the cell, dead periods stay blank); within a cell the
// squares split into lighter "additions" and darker "deletions" by the real
// add/del ratio. Colour = language zone, position = true time grid (aligns with
// the year axis + corner). Only WHICH squares fill is random (seeded).
function gridBlocks(
  ctx: CanvasRenderingContext2D,
  model: PosterModel,
  params: RenderParams,
  rng: () => number
): void {
  const amount = clamp(params.blocks, 0, 1);
  if (amount <= 0) return;
  const ns = clamp(params.negativeSpace, 0, 1);
  const cols = 8;
  const rows = rowCount(model);
  const cells = buildCells(model, cols, rows);
  const maxChurn = Math.max(1, ...cells.map((c) => c.add + c.del));
  const palette = buildPalette(model, rng);
  const cellW = (GX1 - GX0) / cols;
  const cellH = (GY1 - GY0) / rows;
  const minSide = Math.min(cellW, cellH);
  // subdivide each cell into a SUB x SUB grid of small squares (~9px each)
  const SUB = clamp(Math.round(minSide / 9), 4, 12);
  const maxFill = SUB * SUB;
  const subW = cellW / SUB;
  const subH = cellH / SUB;
  const density = clamp(amount * 1.6, 0, 1);
  const idxs = Array.from({ length: maxFill }, (_, i) => i);

  // recompute the dither's mask threshold (same formula as ditherOverlay) so we
  // can fade blocks out where the dither takes over — the two layers don't fight.
  const ditherOn = params.dither;
  const coverage = clamp(params.ditherCoverage, 0, 1);
  const dataShift = (params.density - 1) * 0.14 + (params.volatility - 0.4) * 0.2;
  const thr = clamp(0.66 - coverage * 0.52 - dataShift, 0.05, 0.93);

  ctx.save();
  for (const c of cells) {
    const churn = c.add + c.del;
    if (churn <= 0) continue; // genuinely no sampled activity -> stay blank
    // LOG scale, not linear: a single huge spike shouldn't make every other
    // active period look dead. And any period with real churn always gets a
    // couple of squares, so "active but modest" never reads as "dead".
    const norm = Math.log1p(churn) / Math.log1p(maxChurn);
    const count = clamp(Math.round(norm * maxFill * density), 2, maxFill);

    const lang = pickLang(palette, coherentNoise(c.cx, c.cy, model.seed));
    const sh = lang.shades;
    const last = sh.length - 1;
    const addBudget = Math.round(count * (c.add / churn)); // build-vs-prune split

    // Fisher–Yates shuffle so the placement order scatters within the cell
    for (let i = maxFill - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = idxs[i];
      idxs[i] = idxs[j];
      idxs[j] = t;
    }

    const ox = GX0 + c.col * cellW;
    const oy = GY0 + c.row * cellH;
    const gap = subW * 0.17; // consistent gap around every block, any size
    const gapH = subH * 0.17;
    // busier cells may host bigger blocks (visual hierarchy by churn)
    const maxSize = clamp(1 + Math.floor(norm * 3), 1, Math.min(4, SUB));

    // greedy pack: drop mixed-size squares that tile without overlapping until
    // we've covered ~`count` sub-cells (so total area still tracks the churn).
    const occ = new Uint8Array(maxFill);
    let covered = 0;
    for (let p = 0; p < maxFill && covered < count; p++) {
      const si = idxs[p];
      if (occ[si]) continue;
      const cxi = si % SUB;
      const cyi = (si / SUB) | 0;

      // pick a size, biased small, then shrink until it fits free space + bounds
      let s = 1;
      const r = rng();
      if (maxSize >= 3 && r > 0.88) s = 3;
      else if (maxSize >= 2 && r > 0.58) s = 2;
      while (s > 1 && !fitsBlock(occ, SUB, cxi, cyi, s)) s--;
      for (let dy = 0; dy < s; dy++)
        for (let dx = 0; dx < s; dx++) occ[(cyi + dy) * SUB + (cxi + dx)] = 1;

      // colour: adds from the lighter half of the ramp, dels from the darker —
      // decided by how much we've covered vs the add budget. Varies per block.
      const isAdd = covered < addBudget;
      covered += s * s;
      const f = isAdd ? 0.52 + rng() * 0.46 : 0.04 + rng() * 0.34;
      const col = sh[clamp(Math.round(last * f), 0, last)];

      const bx = ox + cxi * subW + gap;
      const by = oy + cyi * subH + gapH;
      const bwS = s * subW - gap * 2;
      const bhS = s * subH - gapH * 2;

      const mcx = bx + bwS / 2;
      const mcy = by + bhS / 2;
      // fade out where the dither mask is strong so the layers don't collide
      let fade = 1;
      if (ditherOn) {
        const region = maskNoise(mcx, mcy, params.seed, params.volatility, params.flow);
        fade = 1 - smoothstep(thr - 0.04, thr + 0.5, region) * 0.9;
      }
      // a second, independent organic mask -> scattered random fade-outs that
      // break the blocks up into drifting islands (always on).
      const m2 = maskNoise(mcx, mcy, (params.seed ^ 0x9e3779b9) >>> 0, params.volatility, params.flow);
      fade *= 1 - smoothstep(0.3, 0.82, m2) * 0.96;
      // honour the same negative-space zones the paint leaves open, so blocks
      // don't fill the breathing room (uses canvas-normalized coords like spray)
      if (ns > 0.001) {
        const bm = breathMask(mcx / W, mcy / H, model.seed, ns);
        if (bm < 0.06) continue;
        fade *= bm;
      }
      // wide per-block opacity, occasionally near-solid for pop
      ctx.globalAlpha = clamp(0.22 + rng() * rng() * 1.0, 0.16, 0.92) * fade;
      ctx.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
      ctx.fillRect(bx, by, bwS, bhS);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// 8x8 Bayer ordered-dither matrix, normalized to (0..1)
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
].map((row) => row.map((v) => (v + 0.5) / 64));


// Flat ordered-dither (ascii/halftone), laid OVER the smooth gradient and
// dissolved with a CLEAN directional fade rather than a blobby mask: the poster
// resolves into a coloured halftone on paper at one end and stays painterly at
// the other. The fade direction is seeded per-repo; the timeline runs top->down
// so the dissolve still tracks the repo's history. Coverage sets how far it
// reaches; a little noise feathers the boundary into scattered pixels.
function ditherOverlay(
  ctx: CanvasRenderingContext2D,
  field: Field,
  params: RenderParams,
  model: PosterModel,
  wells: Pt[],
  rng: () => number
): void {
  const { f, fw, fh, srcX, srcY, srcW, srcH } = field;
  const data = f.getImageData(0, 0, fw, fh).data;
  const seed = params.seed; // keyed to seed so reroll reshuffles the regions
  const hex = params.ditherStyle === "hex";
  const P = clamp(params.pixelSize, 2, 16);
  // hex glyphs need a bigger cell than dots to stay legible
  const step = hex ? clamp(P * 2.4, 9, 26) : P;
  const cols = Math.ceil(W / step);
  const rows = Math.ceil(H / step);
  const dotR = Math.max(0.8, step * 0.46);
  const contrast = clamp(params.ditherContrast, 0, 1);
  // dither area is data-driven: denser + more volatile repos bubble through
  // more of the poster; the slider is a manual master on top.
  const coverage = clamp(params.ditherCoverage, 0, 1);
  const dataShift = (params.density - 1) * 0.14 + (params.volatility - 0.4) * 0.2;
  const thr = clamp(0.66 - coverage * 0.52 - dataShift, 0.05, 0.93);
  // release wells bloom extra dither around them (radius grows with coverage)
  const wellR = 150 + coverage * 220 + params.volatility * 110;

  // the repo's commit hashes, streamed contiguously through the lit cells so the
  // clusters read like a ledger of SHAs. Falls back to a seed-derived hex run.
  const hexStream = (model.shas.join("") || seed.toString(16)).replace(/[^0-9a-f]/gi, "");
  let hi = 0;

  ctx.save();
  if (hex) {
    ctx.font = `${Math.round(step * 1.02)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
  }
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const ox = gx * step;
      const oy = gy * step;
      const fxp = Math.min(fw - 1, Math.max(0, Math.floor(srcX + (ox / W) * srcW)));
      const fyp = Math.min(fh - 1, Math.max(0, Math.floor(srcY + (oy / H) * srcH)));

      // big scaled-up organic noise (the cool base look), with extra dither
      // blooming around the release wells — additive, so it only adds, never
      // removes. Wells use the original (un-cropped) coord so they track the
      // gradient under zoom.
      const nz = maskNoise(ox, oy, seed, params.volatility, params.flow);
      const region = Math.max(nz, wellBloom((fxp / fw) * W, (fyp / fh) * H, wells, wellR));
      const fzz = edgeNoise(ox, oy, seed);
      const m = clamp(smoothstep(thr - 0.04, thr + 0.5, region) * (0.7 + 0.5 * fzz), 0, 1);
      if (m <= 0.02) continue;

      const idx = (fyp * fw + fxp) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const dr = r - RP_PAPER_RGB.r;
      const dg = g - RP_PAPER_RGB.g;
      const db = b - RP_PAPER_RGB.b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      const v = clamp(0.1 + Math.pow(dist / 175, 0.85) * 0.8, 0, 1);
      // cells thin out progressively toward the edges -> soft, large feather
      if (v > BAYER8[gy & 7][gx & 7] && rng() < m * m) {
        const markAlpha = clamp(m * (0.45 + contrast * 0.9), 0, 1);
        const paperAlpha = clamp(m * (0.12 + contrast * 0.58), 0, 0.82);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        if (hex) {
          const ch = hexStream[hi % hexStream.length];
          hi++;
          ctx.lineWidth = Math.max(1, step * 0.18);
          ctx.strokeStyle = RP_PAPER;
          ctx.globalAlpha = paperAlpha;
          ctx.strokeText(ch, ox + step / 2, oy + step / 2);
          ctx.globalAlpha = markAlpha;
          ctx.fillText(ch, ox + step / 2, oy + step / 2);
        } else {
          ctx.globalAlpha = paperAlpha;
          ctx.fillStyle = RP_PAPER;
          ctx.beginPath();
          ctx.arc(ox + step / 2, oy + step / 2, dotR * 1.05, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = markAlpha;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.beginPath();
          ctx.arc(ox + step / 2, oy + step / 2, dotR * (0.68 + contrast * 0.22), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Smooth low-frequency value field in 0..1 from a handful of seeded sine lobes —
// the basis for organic empty zones. Coords are canvas-normalized (0..1).
function breatheNoise(nx: number, ny: number, seed: number): number {
  const a = ((seed % 997) / 997) * 6.2831853;
  const b = (((seed >>> 5) % 991) / 991) * 6.2831853;
  const c = (((seed >>> 13) % 983) / 983) * 6.2831853;
  const v =
    Math.sin(nx * 2.3 + a) * 0.55 +
    Math.cos(ny * 2.7 + b) * 0.5 +
    Math.sin((nx + ny) * 1.7 + c) * 0.45 +
    Math.cos((nx - ny) * 3.1 + a * 0.6) * 0.32;
  return clamp(0.5 + v / 3.3, 0, 1);
}

// Presence mask (0 = clean paper, 1 = full paint) in canvas-normalized coords.
// Two ingredients, both seeded per-repo so no two posters breathe alike:
//   • asymmetric clean margins on all four sides (the "looks good from the
//     sides" Zeh trait — paint never runs to the edge)
//   • organic interior voids carved where the low-freq field dips
// `amount` scales the whole effect; at 0 it returns 1 (paint everywhere).
function breathMask(nx: number, ny: number, seed: number, amount: number): number {
  if (amount <= 0.001) return 1;
  const lm = 0.04 + ((seed >>> 3) % 100) / 100 * 0.09;
  const rm = 0.04 + ((seed >>> 11) % 100) / 100 * 0.09;
  const tm = 0.03 + ((seed >>> 17) % 100) / 100 * 0.06;
  const bm = 0.03 + ((seed >>> 23) % 100) / 100 * 0.06;
  const edge =
    smoothstep(0, lm + 0.05, nx) *
    smoothstep(0, rm + 0.05, 1 - nx) *
    smoothstep(0, tm + 0.05, ny) *
    smoothstep(0, bm + 0.05, 1 - ny);
  const field = breatheNoise(nx, ny, seed);
  const thr = 0.16 + amount * 0.46; // more amount -> wider voids
  const voids = smoothstep(thr - 0.13, thr + 0.12, field);
  // Side/edge margins clean up faster than interior voids: even a gentle setting
  // pulls the paint off the edges, while the organic interior holes only open up
  // as the slider climbs.
  const edgeApplied = 1 - Math.min(1, amount * 1.6) * (1 - edge);
  const voidApplied = 1 - amount * (1 - voids);
  return clamp(edgeApplied * voidApplied, 0, 1);
}

// soft 0..1 falloff that peaks at each release well — the dither blooms here
function wellBloom(x: number, y: number, wells: Pt[], R: number): number {
  let m = 0;
  for (const w of wells) {
    const d = Math.hypot(x - w.x, y - w.y);
    if (d >= R) continue;
    const v = 1 - d / R;
    const s = v * v * (3 - 2 * v); // smoothstep falloff
    if (s > m) m = s;
  }
  return m;
}

// small high-freq noise just to break up the mask edges (the dissolve)
function edgeNoise(x: number, y: number, seed: number): number {
  const s = (seed % 997) * 0.001;
  // lower frequency -> larger, softer mottled feather zone
  const n = Math.sin(x * 0.022 + s * 4) + Math.cos(y * 0.026 + s * 6) + Math.sin((x + y) * 0.018 + s * 8);
  return clamp(n / 3 + 0.5, 0, 1);
}

// big, low-frequency organic noise -> large dither regions that bubble through
// different sections of the poster. Phase is driven by the seed so reroll moves
// the regions around. Two octaves keep the blobs from looking like a sine grid.
function maskNoise(x: number, y: number, seed: number, volatility: number, flow: number): number {
  // volatility -> region frequency (chaotic = smaller patches); kept low so
  // regions read as big zoomed-in masses. flow -> horizontal stretch.
  const base = 0.0032 + clamp(volatility, 0, 1) * 0.004;
  const fx = base / clamp(flow, 0.5, 2);
  const fy = base;
  // sum several octaves along seed-rotated directions with non-harmonic
  // frequencies -> an organic, irregular field that's distinct per seed.
  const FREQS = [1, 1.73, 2.61, 0.62, 3.29];
  let n = 0;
  let amp = 0;
  for (let i = 0; i < FREQS.length; i++) {
    const ang = (((seed >> (i * 3)) % 360) / 360) * Math.PI * 2 + i * 1.13;
    const ph = (((seed >> (i * 4)) % 628) / 100) + i * 2.39;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const proj = x * fx * ux + y * fy * uy;
    const a = 1 / (1 + i * 0.85); // decaying amplitude
    n += a * Math.sin(proj * FREQS[i] + ph);
    amp += a;
  }
  return clamp(n / (amp * 1.4) + 0.5, 0, 1);
}

function softSprite(c: RGB): HTMLCanvasElement {
  const size = 64;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const g = cv.getContext("2d");
  if (!g) return cv;
  const mid = size / 2;
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.95)`);
  grad.addColorStop(0.4, `rgba(${c.r},${c.g},${c.b},0.5)`);
  grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return cv;
}

// ----------------------------------------------------------------- background

function paper(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = RP_PAPER;
  ctx.fillRect(0, 0, W, H);
}

// ---- the source-material wallpaper -------------------------------------
// The repo's own commit messages + SHAs, printed faintly full-bleed and layered
// over the (optionally dithered) gradient — the "born from data" texture.
function textWallpaper(
  ctx: CanvasRenderingContext2D,
  model: PosterModel,
  params: RenderParams,
  rng: () => number
): void {
  const tokens: string[] = [];
  for (const c of model.commits) tokens.push(c.toUpperCase());
  for (const s of model.shas) tokens.push(s);
  if (tokens.length === 0) tokens.push(model.slug.toUpperCase());
  ctx.save();
  ctx.font = `10px ${MONO}`;
  ctx.fillStyle = `rgba(${RP_INK},${clamp(params.sourceText * 0.16, 0, 0.6).toFixed(3)})`;
  const lineH = 15;
  let idx = Math.floor(rng() * tokens.length);
  for (let y = 54; y < H - 38; y += lineH) {
    let line = "";
    while (ctx.measureText(line).width < W - 76) {
      line += tokens[idx % tokens.length] + "   ";
      idx++;
    }
    ctx.fillText(line, 38, y);
  }
  ctx.restore();
}

// ----------------------------------------------------------------- scaffolding

function grid(ctx: CanvasRenderingContext2D, cols: number, rows: number, opacity: number): void {
  const a = clamp(opacity, 0, 1);
  ctx.save();
  ctx.strokeStyle = `rgba(${RP_INK},${(a * 0.7).toFixed(3)})`;
  ctx.lineWidth = 0.8;
  const cellW = (GX1 - GX0) / cols;
  const cellH = (GY1 - GY0) / rows;
  for (let c = 0; c <= cols; c++) line(ctx, GX0 + c * cellW, GY0, GX0 + c * cellW, GY1);
  for (let r = 0; r <= rows; r++) line(ctx, GX0, GY0 + r * cellH, GX1, GY0 + r * cellH);
  const tk = 6;
  for (let c = 0; c <= cols; c++) {
    const x = GX0 + c * cellW;
    line(ctx, x, GY0 - tk, x, GY0);
    line(ctx, x, GY1, x, GY1 + tk);
  }
  for (let r = 0; r <= rows; r++) {
    const y = GY0 + r * cellH;
    line(ctx, GX0 - tk, y, GX0, y);
    line(ctx, GX1, y, GX1 + tk, y);
  }
  ctx.restore();
}

function drawWireLines(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
  ctx.save();
  ctx.lineCap = "round";
  for (const stroke of strokes) {
    const { r, g, b } = stroke.color;
    ctx.strokeStyle = `rgba(${r},${g},${b},${(0.16 + stroke.norm * 0.12).toFixed(3)})`;
    ctx.lineWidth = 0.7 + stroke.norm * 0.9;
    ctx.beginPath();
    ctx.moveTo(stroke.pts[0].x, stroke.pts[0].y);
    for (let i = 1; i < stroke.pts.length; i++) ctx.lineTo(stroke.pts[i].x, stroke.pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function wellMarks(ctx: CanvasRenderingContext2D, wells: Pt[], opacity: number): void {
  if (wells.length === 0) return;
  ctx.save();
  ctx.strokeStyle = `rgba(${RP_INK},${opacity.toFixed(3)})`;
  ctx.fillStyle = `rgba(${RP_INK},${opacity.toFixed(3)})`;
  ctx.lineWidth = 0.9;
  for (const w of wells) {
    ctx.beginPath();
    ctx.arc(w.x, w.y, 18, 0, Math.PI * 2);
    ctx.stroke();
    line(ctx, w.x - 6, w.y, w.x + 6, w.y);
    line(ctx, w.x, w.y - 6, w.x, w.y + 6);
    ctx.beginPath();
    ctx.arc(w.x, w.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function wireframeCells(ctx: CanvasRenderingContext2D, cells: Cell[]): void {
  const maxChurn = Math.max(1, ...cells.map((c) => c.add + c.del));
  ctx.save();
  for (const c of cells) {
    const churn = c.add + c.del;
    if (churn <= 0) continue;
    ctx.fillStyle = `rgba(${RP_INK},0.16)`;
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, 2 + (churn / maxChurn) * 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ----------------------------------------------------------------- finish layers

function tickMarks(ctx: CanvasRenderingContext2D, params: RenderParams, rng: () => number): void {
  // scattered faint vertical ticks, like the reference's stray marks
  const count = Math.round(clamp(params.tickCount, 0, 400));
  const op = clamp(params.tickOpacity, 0, 1);
  if (count <= 0 || op <= 0.001) return;
  ctx.save();
  ctx.strokeStyle = `rgba(${RP_INK},${op.toFixed(3)})`;
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    const x = 60 + rng() * (W - 120);
    const y = 80 + rng() * (H - 200);
    const h = 5 + rng() * 5;
    line(ctx, x, y, x, y + h);
  }
  ctx.restore();
}

// year labels placed at their true linear vertical position (a real time axis),
// so they span exactly first->last year and agree with the corner block.
// The time-spine: repostr's backbone. A faint vertical axis down the left
// margin with a small tick + year label at each year — the repo's lifespan made
// into the structure everything else hangs from.
function timeMarkers(ctx: CanvasRenderingContext2D, model: PosterModel, opacity: number): void {
  if (!model.firstT || !model.lastT) return;
  const span = Math.max(1, model.lastT - model.firstT);
  const fy = new Date(model.firstT * 1000).getUTCFullYear();
  const ly = new Date(model.lastT * 1000).getUTCFullYear();
  const step = Math.max(1, Math.ceil((ly - fy + 1) / 12)); // keep ≤ ~12 labels
  const axisX = GX0 - 30;

  ctx.save();
  // the spine itself — hairline, quieter than the labels
  ctx.strokeStyle = `rgba(${RP_INK},${opacity * 0.5})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(axisX, GY0);
  ctx.lineTo(axisX, GY1);
  ctx.stroke();

  ctx.font = `9px ${MONO}`;
  ctx.textBaseline = "middle";
  for (let Y = fy; Y <= ly; Y++) {
    const isLabel = (Y - fy) % step === 0 || Y === ly;
    const ys = Date.UTC(Y, 0, 1) / 1000;
    const f = clamp((ys - model.firstT) / span, 0, 1);
    const y = GY0 + f * (GY1 - GY0);
    // every year gets a tick; only labelled years carry the number
    ctx.strokeStyle = `rgba(${RP_INK},${opacity * (isLabel ? 0.9 : 0.4)})`;
    ctx.beginPath();
    ctx.moveTo(axisX, y);
    ctx.lineTo(axisX + (isLabel ? 7 : 4), y);
    ctx.stroke();
    if (isLabel) {
      ctx.fillStyle = `rgba(${RP_INK},${opacity})`;
      ctx.textAlign = "right";
      ctx.fillText(String(Y), axisX - 6, y);
    }
  }
  ctx.restore();
}

// Real film grain: a full-resolution black/white noise texture (built once,
// cached) composited over everything. The slider scales overall strength.
let NOISE_CANVAS: HTMLCanvasElement | null = null;
function noiseCanvas(): HTMLCanvasElement {
  if (NOISE_CANVAS) return NOISE_CANVAS;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (g) {
    const img = g.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = Math.random() * 255; // white noise, varying opacity
    }
    g.putImageData(img, 0, 0);
  }
  NOISE_CANVAS = c;
  return c;
}

function grain(ctx: CanvasRenderingContext2D, amount: number): void {
  if (amount <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = clamp(amount, 0, 1) * 0.85;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(noiseCanvas(), 0, 0, W, H);
  ctx.restore();
}

function vignette(ctx: CanvasRenderingContext2D): void {
  const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, H * 0.78);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.06)"); // neutral, no warm cast
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function cornerBlock(ctx: CanvasRenderingContext2D, model: PosterModel): void {
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  ctx.fillStyle = RP_INK_HEX;
  const rx = GX1;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(model.owner.toUpperCase(), rx - 92, H - 74);
  ctx.font = `700 13px ${MONO}`;
  ctx.fillText(model.name.toUpperCase(), rx - 92, H - 58);

  const y0 = H - 86;
  const boxW = 84;
  const boxH = 30;
  const bx = rx - boxW;
  const y1 = yearOf(model.firstT);
  const y2 = yearOf(model.lastT);
  ctx.strokeStyle = `rgba(${RP_INK},0.6)`;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, y0, boxW, boxH);
  ctx.fillStyle = RP_INK_HEX;
  ctx.font = `9px ${MONO}`;
  ctx.textAlign = "center";
  if (y1 === y2) {
    // single year — no divider, just centre it
    ctx.font = `11px ${MONO}`;
    ctx.fillText(y1, bx + boxW / 2, y0 + boxH / 2 + 4);
  } else {
    line(ctx, bx, y0 + boxH / 2, bx + boxW, y0 + boxH / 2);
    ctx.fillText(y1, bx + boxW / 2, y0 + 11);
    ctx.fillText(y2, bx + boxW / 2, y0 + boxH - 5);
  }
  ctx.restore();
  void formatDateRange;
}

// ----------------------------------------------------------------- palette pick

type LangPigment = { upto: number; shades: RGB[] };

// Limit the palette to the few languages that actually matter, biased hard
// toward the dominant one, and expand each into a shade family (base + softer +
// deeper, slight analogous drift — Zeh's base/"soft" pairing). Keeps posters
// cohesive instead of a six-language confetti.
function buildPalette(model: PosterModel, rng: () => number): LangPigment[] {
  // hand-picked artwork palette wins over the auto language colours
  const source =
    model.paletteOverride && model.paletteOverride.length
      ? model.paletteOverride
      : model.palette;
  let entries = source.filter((p) => p.weight >= 0.05).slice(0, 3);
  if (entries.length === 0) entries = [source[0]];
  const mono = entries.length <= 1;

  // bias toward the dominant language so minor ones read as accents, not noise
  const biased = entries.map((e) => ({ color: e.color, w: Math.pow(e.weight, 1.5) }));
  const total = biased.reduce((a, e) => a + e.w, 0) || 1;
  const perLang = mono ? 8 : 6;
  const hueSpread = mono ? 54 : 30;

  // Per-repo tonal signature: a bounded hue rotation + lightness bias so two
  // repos sharing a dominant language still diverge in tone (one a cooler/lighter
  // blue, another a deeper indigo). Greys are untouched (sFactor ~0 in shadesOf).
  const sig = model.seed;
  const hueShift = ((sig >>> 13) % 41) - 20; // -20..+20 deg
  const lightBias = (((sig >>> 19) % 21) - 10) / 100; // -0.10..+0.10

  let acc = 0;
  return biased.map((e) => {
    acc += e.w / total;
    return {
      upto: acc,
      shades: shadesOf(e.color, perLang, hueSpread, hueShift, lightBias, rng)
    };
  });
}

function shadesOf(
  hex: string,
  count: number,
  hueSpread: number,
  hueShift: number,
  lightBias: number,
  rng: () => number
): RGB[] {
  const base = hexToHsl(hex);
  const out: RGB[] = [];
  const sFactor = Math.min(1, base.s * 2.5); // ~0 for greys -> stay neutral
  for (let i = 0; i < count; i++) {
    const f = count > 1 ? i / (count - 1) : 0.5; // 0 dark .. 1 light
    const L = clamp(base.l + lightBias + (f - 0.42) * 0.44, 0.05, 0.92);
    const H =
      (base.h + (hueShift + (f - 0.5) * hueSpread + (rng() - 0.5) * 12) * sFactor + 360) % 360;
    const S = clamp(base.s * (0.55 + 0.55 * (1 - Math.abs(f - 0.5) * 1.4)), 0, 1);
    out.push(hslToRgb(H, S, L));
  }
  return out;
}

// Pick a language from a smooth spatial field so each region is dominated by
// one hue (clean zones), then a random shade gives richness within the zone.
function pickLang(palette: LangPigment[], region: number): LangPigment {
  for (const p of palette) if (region <= p.upto) return p;
  return palette[palette.length - 1];
}

function coherentNoise(x: number, y: number, seed: number): number {
  const s = (seed % 1000) * 0.001;
  const zs = 0.65 + ((seed >>> 17) % 100) / 100 * 1.0; // per-repo zone scale
  const v =
    Math.sin(x * 0.0042 * zs + s * 5) +
    Math.cos(y * 0.0047 * zs + s * 7) +
    Math.sin((x * 0.003 - y * 0.0035) * zs + s * 3);
  return clamp(v / 3 + 0.5, 0, 1);
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255)
  };
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t)
  };
}

function pickWeighted(cells: Cell[], target: number): Cell | null {
  let acc = 0;
  for (const c of cells) {
    acc += c.add + c.del;
    if (target <= acc) return c;
  }
  return cells[cells.length - 1] ?? null;
}

// ----------------------------------------------------------------- utils

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function yearOf(sec: number): string {
  if (!sec) return "—";
  return String(new Date(sec * 1000).getUTCFullYear());
}
