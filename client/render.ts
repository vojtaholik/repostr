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
  /** render the gradient as an ordered (Bayer) halftone dither */
  dither: boolean;
  /** dither cell size in px — smaller = finer */
  pixelSize: number;
  /** how much of the poster the data-driven dither covers (0..1) */
  ditherCoverage: number;
  /** faint commit-message + SHA wallpaper, layered on top */
  sourceText: number;
  /** number of scattered vertical tick marks */
  tickCount: number;
  /** opacity of the tick marks */
  tickOpacity: number;
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
    grain: 0.25,
    gridOpacity: 0,
    zoom: 1.8,
    dither: true,
    pixelSize: 4,
    ditherCoverage: 0.1,
    sourceText: 0.22,
    tickCount: 26,
    tickOpacity: 0.32,
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

  // resolve paper + ink (inverted when the paper is dark)
  RP_PAPER = model.paper ?? PAPER;
  RP_PAPER_RGB = hexToRgb(RP_PAPER);
  const lum = (RP_PAPER_RGB.r * 0.299 + RP_PAPER_RGB.g * 0.587 + RP_PAPER_RGB.b * 0.114) / 255;
  const darkBg = lum < 0.45;
  RP_INK = darkBg ? "226,224,218" : "26,24,19";
  RP_INK_HEX = darkBg ? "#e2e0da" : INK;

  const rng = makeRng((params.seed >>> 0) || 1);
  const cols = 8;
  const rows = rowCount(model);
  const cells = buildCells(model, cols, rows);
  const wells = wellPositions(model, cols, rows);

  paper(ctx);

  if (params.wireframe) {
    if (params.sourceText > 0.001) textWallpaper(ctx, model, params, rng);
    grid(ctx, cols, rows, 0.5);
    const strokes = buildStrokes(ctx, model, params, cells, wells, rng);
    drawWireLines(ctx, strokes);
    wellMarks(ctx, wells, 0.5);
    wireframeCells(ctx, cells);
    timeMarkers(ctx, model, 0.45);
    cornerBlock(ctx, model);
    return;
  }

  const strokes = buildStrokes(ctx, model, params, cells, wells, rng);
  // smooth airbrush gradient base
  const field = sprayField(ctx, strokes, rng, params, model.seed);
  // masked, feathered halftone dither — radiates from the release wells
  if (params.dither) ditherOverlay(ctx, field, params, model, wells, rng);
  // layered on top: the faint commit-message + SHA wallpaper (source material)
  if (params.sourceText > 0.001) textWallpaper(ctx, model, params, rng);
  if (params.gridOpacity > 0.001) grid(ctx, cols, rows, params.gridOpacity);
  tickMarks(ctx, params, rng);
  timeMarkers(ctx, model, 0.3);
  grain(ctx, params.grain); // film grain over everything
  vignette(ctx);
  cornerBlock(ctx, model);
}

// renders the print poster to a fresh high-resolution canvas (for PNG export)
export function renderToDataUrl(model: PosterModel, params: RenderParams, scale = 3): string {
  const off = document.createElement("canvas");
  renderPoster(off, model, params, scale);
  return off.toDataURL("image/png");
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

function curlField(x: number, y: number, seed: number): number {
  const s = (seed % 1000) * 0.001;
  return (
    Math.sin(x * 0.011 + s * 6.2) +
    Math.cos(y * 0.013 + s * 9.1) +
    0.5 * Math.sin((x + y) * 0.007 + s * 3.3)
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
function sprayField(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  rng: () => number,
  params: RenderParams,
  seed: number
): Field {
  const fw = 200; // field resolution (also sampled by the dither overlay)
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

  const scaleR = fw / 92; // keep footprint constant across field resolutions
  for (const stroke of strokes) {
    const sp = sprite(stroke.color);
    const n = stroke.pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const taper = Math.sin(t * Math.PI);
      const rad = (3.2 + stroke.norm * 8) * (0.5 + taper * 0.9) * scaleR;
      const a = (0.05 + stroke.norm * 0.1) * (0.4 + taper * 0.9);
      const x = stroke.pts[i].x * sx + (rng() - 0.5) * rad * 0.6;
      const y = stroke.pts[i].y * sy + (rng() - 0.5) * rad * 0.6;
      f.globalAlpha = a;
      f.drawImage(sp, x - rad, y - rad, rad * 2, rad * 2);
    }
  }
  f.globalAlpha = 1;

  // zoom: sample a sub-region of the field (close-up crop) for big calm masses
  const z = clamp(params.zoom, 1, 4);
  const srcW = fw / z;
  const srcH = fh / z;
  const fx = 0.3 + ((seed % 41) / 41) * 0.4;
  const fy = 0.3 + (((seed >> 5) % 37) / 37) * 0.4;
  const srcX = (fw - srcW) * fx;
  const srcY = (fh - srcH) * fy;

  // always lay down the smooth gradient as the base
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  (ctx as unknown as { imageSmoothingQuality: string }).imageSmoothingQuality = "high";
  ctx.drawImage(fc, srcX, srcY, srcW, srcH, 0, 0, W, H);
  ctx.restore();

  return { f, fw, fh, srcX, srcY, srcW, srcH };
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
  const P = clamp(params.pixelSize, 2, 16);
  const cols = Math.ceil(W / P);
  const rows = Math.ceil(H / P);
  const dotR = Math.max(0.8, P * 0.46);
  // dither area is data-driven: denser + more volatile repos bubble through
  // more of the poster; the slider is a manual master on top.
  const coverage = clamp(params.ditherCoverage, 0, 1);
  const dataShift = (params.density - 1) * 0.14 + (params.volatility - 0.4) * 0.2;
  const thr = clamp(0.66 - coverage * 0.52 - dataShift, 0.05, 0.93);
  // release wells bloom extra dither around them (radius grows with coverage)
  const wellR = 150 + coverage * 220 + params.volatility * 110;

  ctx.save();
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const ox = gx * P;
      const oy = gy * P;
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

      ctx.globalAlpha = m;
      ctx.fillStyle = RP_PAPER;
      ctx.fillRect(ox, oy, P + 0.6, P + 0.6);

      const dr = r - RP_PAPER_RGB.r;
      const dg = g - RP_PAPER_RGB.g;
      const db = b - RP_PAPER_RGB.b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      const v = clamp(0.1 + Math.pow(dist / 175, 0.85) * 0.8, 0, 1);
      // dots thin out progressively toward the edges -> soft, large feather
      if (v > BAYER8[gy & 7][gx & 7] && rng() < m * m) {
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(ox + P / 2, oy + P / 2, dotR, 0, Math.PI * 2);
        ctx.fill();
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
function timeMarkers(ctx: CanvasRenderingContext2D, model: PosterModel, opacity: number): void {
  if (!model.firstT || !model.lastT) return;
  const span = Math.max(1, model.lastT - model.firstT);
  const fy = new Date(model.firstT * 1000).getUTCFullYear();
  const ly = new Date(model.lastT * 1000).getUTCFullYear();
  const step = Math.max(1, Math.ceil((ly - fy + 1) / 12)); // keep ≤ ~12 labels
  ctx.save();
  ctx.font = `9px ${MONO}`;
  ctx.fillStyle = `rgba(${RP_INK},${opacity})`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let Y = fy; Y <= ly; Y++) {
    if ((Y - fy) % step !== 0 && Y !== ly) continue;
    const ys = Date.UTC(Y, 0, 1) / 1000;
    const f = clamp((ys - model.firstT) / span, 0, 1);
    ctx.fillText(String(Y), GX0 - 12, GY0 + f * (GY1 - GY0));
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

  let acc = 0;
  return biased.map((e) => {
    acc += e.w / total;
    return { upto: acc, shades: shadesOf(e.color, perLang, hueSpread, rng) };
  });
}

function shadesOf(hex: string, count: number, hueSpread: number, rng: () => number): RGB[] {
  const base = hexToHsl(hex);
  const out: RGB[] = [];
  const sFactor = Math.min(1, base.s * 2.5); // ~0 for greys -> stay neutral
  for (let i = 0; i < count; i++) {
    const f = count > 1 ? i / (count - 1) : 0.5; // 0 dark .. 1 light
    const L = clamp(base.l + (f - 0.42) * 0.44, 0.05, 0.92);
    const H = (base.h + ((f - 0.5) * hueSpread + (rng() - 0.5) * 12) * sFactor + 360) % 360;
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
  const v =
    Math.sin(x * 0.0042 + s * 5) +
    Math.cos(y * 0.0047 + s * 7) +
    Math.sin((x * 0.003 - y * 0.0035) + s * 3);
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
