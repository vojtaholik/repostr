import { useMutation, useQuery } from "lakebed/client";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  analyze,
  formatDateRange,
  parseRepoInput,
  slugFor,
  type PosterModel,
  type RawRepo
} from "../shared/poster";
import {
  defaultParams,
  renderOgDataUrl,
  renderPoster,
  renderToDataUrl,
  type RenderParams
} from "./render";

// modern type: Space Grotesk for display/UI, JetBrains Mono for the mono chrome
if (typeof document !== "undefined" && !document.getElementById("repostr-fonts")) {
  const link = document.createElement("link");
  link.id = "repostr-fonts";
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;600;700&display=swap";
  document.head.appendChild(link);

  const style = document.createElement("style");
  style.textContent = `
    body { font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; background:#0c0c0c; }
    .font-sans { font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif !important; }
    .font-mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace !important; }
  `;
  document.head.appendChild(style);
}

type Phase =
  | { kind: "idle" }
  | { kind: "loading"; message: string; slug: string }
  | { kind: "done"; model: PosterModel }
  | { kind: "error"; message: string };

type PosterRow = {
  id: string;
  slug: string;
  owner: string;
  name: string;
  language: string;
  languageColor: string;
  paints: number;
};

const SUGGESTIONS = [
  "facebook/react",
  "vercel/next.js",
  "torvalds/linux",
  "rust-lang/rust",
  "tailwindlabs/tailwindcss",
  "sveltejs/svelte"
];

export function App() {
  const gallery = useQuery<PosterRow[]>("recentPosters");
  const recordPoster = useMutation<
    [
      input: {
        slug: string;
        owner: string;
        name: string;
        language: string;
        languageColor: string;
        volatility: number;
      }
    ],
    void
  >("recordPoster");
  const ogDone = useRef<Set<string>>(new Set());

  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [params, setParams] = useState<RenderParams | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runToken = useRef(0);
  const rafRef = useRef(0);

  async function paint(rawInput: string, urlParams?: URLSearchParams) {
    const parsed = parseRepoInput(rawInput);
    if (!parsed) {
      setPhase({ kind: "error", message: "Paste a GitHub repo URL — e.g. github.com/facebook/react." });
      return;
    }
    const { owner, name } = parsed;
    const slug = slugFor(owner, name);
    const token = ++runToken.current;
    setInput(`${owner}/${name}`);
    setEditorOpen(false); // always start in the simple result view
    setPhase({ kind: "loading", message: "reading the shape", slug });
    updateUrl(slug);

    try {
      const res = await fetch(`api/repo?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (runToken.current !== token) return;
      if (!res.ok || data.error) {
        setPhase({ kind: "error", message: data.error ?? `Request failed (${res.status}).` });
        return;
      }
      const model = analyze(data.repo as RawRepo);
      // a deep link carries the exact view (seed + slider edits); otherwise start
      // from the repo's defaults.
      setParams(urlParams ? paramsFromQuery(model, urlParams) : defaultParams(model));
      setPhase({ kind: "done", model });
      const top = model.palette[0];
      void recordPoster({
        slug: model.slug,
        owner: model.owner,
        name: model.name,
        language: top?.name ?? "",
        languageColor: top?.color ?? "#8a8a8a",
        volatility: model.volatility
      });

      // Warm the OG share card once per repo (default view = canonical image).
      // Deferred + idle so the heavy offscreen render doesn't block first paint.
      if (!ogDone.current.has(model.slug)) {
        ogDone.current.add(model.slug);
        const warm = () => {
          try {
            const dataUrl = renderOgDataUrl(model, defaultParams(model));
            const b64 = dataUrl.split(",")[1] ?? "";
            if (b64) {
              void fetch(`og?repo=${encodeURIComponent(model.slug)}`, {
                method: "POST",
                body: b64
              });
            }
          } catch {
            /* OG is best-effort */
          }
        };
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
          .requestIdleCallback;
        if (ric) ric(warm);
        else setTimeout(warm, 800);
      }
    } catch {
      if (runToken.current !== token) return;
      setPhase({ kind: "error", message: "Network error reaching the server." });
    }
  }

  // live render, coalesced to one paint per animation frame
  useEffect(() => {
    if (phase.kind !== "done" || !params || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const model = phase.model;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => renderPoster(canvas, model, params));
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, params, editorOpen]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const repo = sp.get("repo");
    if (repo) void paint(repo, sp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the address bar pointing at the exact current view, so "copy link"
  // (and a plain reload) always reproduce what's on screen — seed, shuffle, and
  // every slider edit included.
  useEffect(() => {
    if (phase.kind !== "done" || !params) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${paramsQuery(phase.model, params)}`
    );
  }, [phase, params]);

  function set<K extends keyof RenderParams>(key: K, value: RenderParams[K]) {
    setParams((p) => (p ? { ...p, [key]: value } : p));
  }

  function shuffle() {
    set("seed", (Math.random() * 4294967296) >>> 0);
  }

  function reset() {
    setPhase({ kind: "idle" });
    setParams(null);
    setEditorOpen(false);
    window.history.replaceState(null, "", window.location.pathname);
  }

  return (
    <main className="min-h-screen bg-[#0c0c0c] font-mono text-[#cfcfcf]">
      {(phase.kind === "idle" || phase.kind === "error") && (
        <>
          <Hero
            input={input}
            setInput={setInput}
            onPaint={() => void paint(input)}
            onPick={(s) => void paint(s)}
            error={phase.kind === "error" ? phase.message : undefined}
          />
          <Gallery rows={gallery} onPick={(s) => void paint(s)} />
        </>
      )}

      {phase.kind === "loading" && <Loading slug={phase.slug} message={phase.message} />}

      {phase.kind === "done" && params && !editorOpen && (
        <ResultView
          canvasRef={canvasRef}
          model={phase.model}
          params={params}
          onShuffle={shuffle}
          onEdit={() => setEditorOpen(true)}
          onReset={reset}
        />
      )}

      {phase.kind === "done" && params && editorOpen && (
        <Editor
          canvasRef={canvasRef}
          model={phase.model}
          params={params}
          set={set}
          onShuffle={shuffle}
          onClose={() => setEditorOpen(false)}
          onReset={reset}
        />
      )}
    </main>
  );
}

// ----------------------------------------------------------------- landing

function Hero({
  input,
  setInput,
  onPaint,
  onPick,
  error
}: {
  input: string;
  setInput: (v: string) => void;
  onPaint: () => void;
  onPick: (s: string) => void;
  error?: string;
}) {
  return (
    <section className="mx-auto flex max-w-2xl flex-col items-center px-6 pb-16 pt-[16vh] text-center">
      <h1 className="font-sans text-6xl font-bold tracking-tight text-white sm:text-7xl">Repostr</h1>
      <h2 className="mt-3 font-mono text-[12px] uppercase tracking-[0.42em] text-[#8f8f8f]">
        Git history as print
      </h2>
      <p className="mt-6 max-w-md text-sm leading-relaxed text-[#8f8f8f]">
        Paste a GitHub repo and get a poster painted from its commit history — bursts, dead zones,
        rewrites, releases. Deterministic, so no two repos look alike.
      </p>

      <form
        className="mt-9 flex w-full max-w-xl flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          onPaint();
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autofocus
          className="min-w-0 flex-1 rounded-md border border-[#2a2a2a] bg-[#161616] px-4 py-3.5 font-mono text-sm text-white outline-none transition placeholder:text-[#5f5f5f] focus:border-white"
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder="https://github.com/owner/repo"
          spellcheck={false}
          autocomplete="off"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md bg-white px-7 py-3.5 text-sm font-semibold uppercase tracking-widest text-black transition hover:bg-[#dcdcdc]"
        >
          paint
        </button>
      </form>

      {error && <p className="mt-3 font-mono text-xs text-[#e06b5a]">{error}</p>}

      <div className="mt-12 w-full">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.3em] text-[#5f5f5f]">
          or try one
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-md border border-[#222] bg-[#141414] px-3 py-2.5 text-left transition hover:border-white"
            >
              <span className="block truncate font-mono text-[10px] text-[#6f6f6f]">{s.split("/")[0]}/</span>
              <span className="block truncate font-mono text-xs text-white">{s.split("/")[1]}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Loading({ slug, message }: { slug: string; message: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 520;
    const H = 680;
    canvas.width = W;
    canvas.height = H;

    // one gravity well the flow converges toward
    const well = { x: W * 0.74, y: H * 0.5 };
    const N = 42; // flow lines
    // slowly drifting curl field
    const curl = (x: number, y: number, t: number) =>
      Math.sin(y * 0.012 + t * 0.5) + 0.6 * Math.cos((x - y) * 0.006 + t * 0.4);

    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round";

      // a soft highlight that travels left -> right along the flow ("reading")
      const sweep = ((t * 0.16) % 1.3) * W - 40;

      for (let i = 0; i < N; i++) {
        const f = i / (N - 1);
        let px = -10;
        let py = H * 0.12 + f * H * 0.76;
        let ang = 0;
        const pts: Array<[number, number]> = [[px, py]];
        for (let s = 0; s < 60 && px < W + 10; s++) {
          ang += curl(px, py, t) * 0.045;
          // converge toward the well
          const dx = well.x - px;
          const dy = well.y - py;
          const d = Math.hypot(dx, dy) || 1;
          if (d < 320) {
            let diff = Math.atan2(dy, dx) - ang;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            ang += diff * (1 - d / 320) * 0.16;
          }
          px += Math.cos(ang) * 11;
          py += Math.sin(ang) * 11;
          pts.push([px, py]);
        }
        // brightness bumps where the sweep passes
        const mid = pts[Math.floor(pts.length / 2)] ?? [0, 0];
        const near = 1 - Math.min(1, Math.abs(mid[0] - sweep) / 120);
        ctx.strokeStyle = `rgba(255,255,255,${(0.1 + near * 0.36).toFixed(3)})`;
        ctx.lineWidth = 0.7 + near * 0.9;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.stroke();
      }

      // breathing gravity ring + crosshair at the convergence point
      const r = 16 + Math.sin(t * 1.8) * 5;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(well.x, well.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(well.x - 8, well.y);
      ctx.lineTo(well.x + 8, well.y);
      ctx.moveTo(well.x, well.y - 8);
      ctx.lineTo(well.x, well.y + 8);
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5">
      <canvas ref={ref} className="w-[300px] opacity-90" style={{ aspectRatio: "520 / 680" }} />
      <div className="flex flex-col items-center gap-1">
        <div className="font-mono text-sm text-white">{slug}</div>
        <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-[#6f6f6f]">
          {message}
          <span className="ml-1 inline-block animate-pulse">●</span>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- result view

function ResultView({
  canvasRef,
  model,
  params,
  onShuffle,
  onEdit,
  onReset
}: {
  canvasRef: { current: HTMLCanvasElement | null };
  model: PosterModel;
  params: RenderParams;
  onShuffle: () => void;
  onEdit: () => void;
  onReset: () => void;
}) {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center px-6 py-8">
      <PosterFrame canvasRef={canvasRef} mode="result" />

      <div className="mt-7 flex flex-wrap items-center justify-center gap-2 font-mono text-[11px]">
        <Btn primary onClick={onShuffle}>shuffle</Btn>
        <Btn onClick={() => downloadPoster(model, params)}>download</Btn>
        <Btn onClick={() => copyLink(model, params)}>copy link</Btn>
        <Btn onClick={onEdit}>open editor</Btn>
        <Btn onClick={onReset}>new</Btn>
      </div>

      <p className="mt-5 text-center font-mono text-[11px] text-[#6f6f6f]">
        {model.owner}/{model.name} · {formatDateRange(model.firstT, model.lastT)} ·{" "}
        {model.palette[0]?.name ?? "?"}
      </p>
    </section>
  );
}

// ----------------------------------------------------------------- editor

function Editor({
  canvasRef,
  model,
  params,
  set,
  onShuffle,
  onClose,
  onReset
}: {
  canvasRef: { current: HTMLCanvasElement | null };
  model: PosterModel;
  params: RenderParams;
  set: <K extends keyof RenderParams>(key: K, value: RenderParams[K]) => void;
  onShuffle: () => void;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e1e1e] px-5 py-3 font-mono text-[11px]">
        <div className="flex items-center gap-3">
          <button className="text-[#9b9b9b] hover:text-white" onClick={onClose}>
            ← poster
          </button>
          <span className="text-[#5f5f5f]">|</span>
          <span className="text-white">
            {model.owner}/<span className="font-bold">{model.name}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Btn primary onClick={onShuffle}>shuffle</Btn>
          <Btn onClick={() => downloadPoster(model, params)}>download</Btn>
          <Btn onClick={() => copyLink(model, params)}>copy link</Btn>
          <Btn onClick={onReset}>new</Btn>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-px bg-[#1e1e1e] lg:grid-cols-[260px_1fr_300px]">
        <DataPanel model={model} />
        <div className="flex items-center justify-center bg-[#0a0a0a] p-6">
          <PosterFrame canvasRef={canvasRef} mode="editor" />
        </div>
        <Controls params={params} set={set} />
      </div>
    </div>
  );
}

function PosterFrame({
  canvasRef,
  mode
}: {
  canvasRef: { current: HTMLCanvasElement | null };
  mode?: "result" | "editor";
}) {
  // as tall as available, capped so width never overflows its container.
  // editor caps by the centre column width (viewport minus the two ~280px panels).
  const style: Record<string, string> =
    mode === "result"
      ? { height: "min(82vh, 116vw)", aspectRatio: "3 / 4" }
      : mode === "editor"
        ? { height: "max(260px, min(86vh, calc((100vw - 600px) * 1.333)))", aspectRatio: "3 / 4" }
        : { width: "100%", maxWidth: "460px", aspectRatio: "3 / 4" };
  return (
    <div
      className="bg-[#efece3] p-2 shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)] ring-1 ring-black/50"
      style={style}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

function DataPanel({ model }: { model: PosterModel }) {
  return (
    <aside className="bg-[#121212] p-5">
      <PanelTitle>data</PanelTitle>
      <div className="mt-4 space-y-3 text-xs">
        <Field label="repository" value={`${model.owner}/${model.name}`} strong />
        <Field label="span" value={formatDateRange(model.firstT, model.lastT)} />
        <Field label="weeks" value={String(model.totalWeeks)} />
        <Field label="additions" value={`+${compact(model.totalAdditions)}`} />
        <Field label="deletions" value={`−${compact(model.totalDeletions)}`} />
        <Field label="releases" value={String(model.wells.length)} />
        <Field label="volatility" value={model.volatility.toFixed(2)} />
      </div>

      <PanelTitle className="mt-7">languages</PanelTitle>
      <div className="mt-3 space-y-2">
        {model.palette.map((p) => (
          <div key={p.name} className="flex items-center gap-2 text-xs">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: p.color }} />
            <span className="min-w-0 flex-1 truncate text-[#bdbdbd]">{p.name}</span>
            <span className="text-[#6f6f6f]">{Math.round(p.weight * 100)}%</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Controls({
  params,
  set
}: {
  params: RenderParams;
  set: <K extends keyof RenderParams>(key: K, value: RenderParams[K]) => void;
}) {
  return (
    <aside className="bg-[#121212] p-5">
      <div className="flex items-center justify-between">
        <PanelTitle>controls</PanelTitle>
        <Toggle on={params.wireframe} onClick={() => set("wireframe", !params.wireframe)}>
          wireframe
        </Toggle>
      </div>

      <div className="mt-4 space-y-2">
        <Slider label="volatility" value={params.volatility} min={0} max={1} step={0.01} onChange={(v) => set("volatility", v)} />
        <Slider label="density" value={params.density} min={0.3} max={2} step={0.05} onChange={(v) => set("density", v)} />
        <Slider label="flow / reach" value={params.flow} min={0.3} max={1.8} step={0.05} onChange={(v) => set("flow", v)} />
        <Slider label="zoom" value={params.zoom} min={1} max={4} step={0.1} onChange={(v) => set("zoom", v)} />
        <Slider label="spread" value={params.spread} min={0} max={1} step={0.02} onChange={(v) => set("spread", v)} />
        <Slider label="release pull" value={params.releasePull} min={0} max={1} step={0.02} onChange={(v) => set("releasePull", v)} />
        <Slider label="grain" value={params.grain} min={0} max={1} step={0.02} onChange={(v) => set("grain", v)} />
        <Slider label="data blocks" value={params.blocks} min={0} max={1} step={0.02} onChange={(v) => set("blocks", v)} />
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-[#8f8f8f]">flow lines</span>
          <Toggle on={params.filaments} onClick={() => set("filaments", !params.filaments)}>
            {params.filaments ? "on" : "off"}
          </Toggle>
        </div>
      </div>

      <div className="mt-5 border-t border-[#1e1e1e] pt-4">
        <div className="mb-2 flex items-center justify-between">
          <PanelTitle>dither</PanelTitle>
          <Toggle on={params.dither} onClick={() => set("dither", !params.dither)}>
            {params.dither ? "on" : "off"}
          </Toggle>
        </div>
        <div className="space-y-2">
          {params.dither && (
            <>
              <div className="flex items-center justify-between pb-1">
                <span className="text-[11px] text-[#8f8f8f]">glyph</span>
                <Toggle
                  on={params.ditherStyle === "hex"}
                  onClick={() => set("ditherStyle", params.ditherStyle === "hex" ? "dots" : "hex")}
                >
                  {params.ditherStyle === "hex" ? "hex" : "dots"}
                </Toggle>
              </div>
              <Slider label="pixel size" value={params.pixelSize} min={2} max={14} step={1} onChange={(v) => set("pixelSize", v)} fmt={(v) => String(v)} />
              <Slider label="dither area" value={params.ditherCoverage} min={0} max={1} step={0.02} onChange={(v) => set("ditherCoverage", v)} />
            </>
          )}
          <Slider label="source text" value={params.sourceText} min={0} max={1} step={0.02} onChange={(v) => set("sourceText", v)} />
          <Slider label="tick marks" value={params.tickCount} min={0} max={200} step={1} onChange={(v) => set("tickCount", v)} fmt={(v) => String(v)} />
          <Slider label="tick opacity" value={params.tickOpacity} min={0} max={1} step={0.02} onChange={(v) => set("tickOpacity", v)} />
          <Slider label="grid" value={params.gridOpacity} min={0} max={0.6} step={0.02} onChange={(v) => set("gridOpacity", v)} />
        </div>
      </div>

      <p className="mt-5 font-mono text-[10px] text-[#5f5f5f]">seed {params.seed}</p>
    </aside>
  );
}

// Zeh-style slider: a dark rounded row with label + value and a white vertical
// position indicator; a transparent native range sits on top for dragging.
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="relative block select-none">
      <div className="relative flex h-9 items-center justify-between overflow-hidden rounded-md bg-[#1c1c1c] px-3">
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-[#2a2a2a]" style={{ width: `${pct}%` }} />
        <div className="pointer-events-none absolute inset-y-[3px] w-[2px] bg-white" style={{ left: `calc(${pct}% - 1px)` }} />
        <span className="relative z-10 font-mono text-[11px] text-[#b5b5b5]">{label}</span>
        <span className="relative z-10 font-mono text-[11px] tabular-nums text-white">
          {fmt ? fmt(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
        value={value}
        min={min}
        max={max}
        step={step}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: any }) {
  return (
    <button
      className={`rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
        on ? "bg-white text-black" : "border border-[#2a2a2a] text-[#8f8f8f] hover:border-white"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Btn({
  children,
  onClick,
  primary
}: {
  children: any;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition ${
        primary
          ? "bg-white text-black hover:bg-[#dcdcdc]"
          : "border border-[#2a2a2a] text-[#cfcfcf] hover:border-white hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Gallery({ rows, onPick }: { rows: PosterRow[]; onPick: (slug: string) => void }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="mx-auto max-w-3xl px-6 pb-20">
      <PanelTitle>recently painted</PanelTitle>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((row) => (
          <button
            key={row.id}
            onClick={() => onPick(row.slug)}
            className="flex items-center gap-2 rounded-md border border-[#222] bg-[#141414] px-3 py-2.5 text-left transition hover:border-white"
          >
            <span className="h-6 w-6 shrink-0 rounded-sm" style={{ backgroundColor: row.languageColor }} />
            <span className="min-w-0">
              <span className="block truncate font-mono text-[10px] text-[#6f6f6f]">{row.owner}/</span>
              <span className="block truncate font-mono text-xs text-white">{row.name}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PanelTitle({ children, className = "" }: { children: any; className?: string }) {
  return (
    <div className={`font-mono text-[11px] uppercase tracking-[0.3em] text-[#6f6f6f] ${className}`}>
      {children}
    </div>
  );
}

function Field({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 font-mono">
      <span className="text-[#6f6f6f]">{label}</span>
      <span className={`min-w-0 truncate text-right ${strong ? "text-white" : "text-[#bdbdbd]"}`}>
        {value}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------- helpers

function downloadPoster(model: PosterModel, params: RenderParams) {
  const a = document.createElement("a");
  a.href = renderToDataUrl(model, params, 3); // high-res print export
  a.download = `repostr-${model.owner}-${model.name}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// every tunable that defines a view; the URL encodes the slug plus any of these
// that differ from the repo's defaults, so a link reproduces exactly what's on
// screen (seed/shuffle + every slider edit).
const PARAM_KEYS: (keyof RenderParams)[] = [
  "seed",
  "volatility",
  "density",
  "flow",
  "spread",
  "releasePull",
  "grain",
  "gridOpacity",
  "zoom",
  "dither",
  "pixelSize",
  "ditherCoverage",
  "sourceText",
  "tickCount",
  "tickOpacity",
  "filaments",
  "blocks",
  "ditherStyle",
  "wireframe"
];

function paramsQuery(model: PosterModel, params: RenderParams): string {
  const d = defaultParams(model);
  const q = new URLSearchParams();
  q.set("repo", model.slug);
  for (const k of PARAM_KEYS) {
    const v = params[k];
    if (v === d[k]) continue; // only encode what differs from the default view
    if (typeof v === "boolean") q.set(k, v ? "1" : "0");
    else if (typeof v === "string") q.set(k, v);
    else q.set(k, String(Math.round((v as number) * 1e4) / 1e4));
  }
  return q.toString();
}

function paramsFromQuery(model: PosterModel, sp: URLSearchParams): RenderParams {
  const p = defaultParams(model);
  const out = p as Record<string, number | boolean | string>;
  for (const k of PARAM_KEYS) {
    const raw = sp.get(k);
    if (raw == null) continue;
    if (typeof p[k] === "boolean") {
      out[k] = raw === "1" || raw === "true";
    } else if (typeof p[k] === "string") {
      out[k] = raw;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return p;
}

function copyLink(model: PosterModel, params: RenderParams) {
  // the /share URL: it unfurls (OG/Twitter meta + cached poster image) when
  // pasted, and redirects humans to the exact current view (same params as the
  // address bar). The bare SPA URL can't unfurl, so this is the shareable link.
  const url = `${window.location.origin}/share?${paramsQuery(model, params)}`;
  void navigator.clipboard?.writeText(url);
}

function updateUrl(slug: string) {
  window.history.replaceState(null, "", `${window.location.pathname}?repo=${slug}`);
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
