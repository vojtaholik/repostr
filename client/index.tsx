import {
  Route,
  Router,
  Routes,
  navigate,
  useLocation,
  useMutation,
  useParams,
  useQuery
} from "lakebed/client";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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

    /* motion */
    @keyframes rpr-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes rpr-rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
    @keyframes rpr-pop { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: none } }
    @keyframes rpr-toast { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
    .rpr-fade { animation: rpr-fade .45s ease both }
    .rpr-rise { animation: rpr-rise .55s cubic-bezier(.2,.7,.2,1) both }
    .rpr-pop  { animation: rpr-pop .28s cubic-bezier(.2,.8,.2,1) both }
    .rpr-toast { animation: rpr-toast .28s cubic-bezier(.2,.8,.2,1) both }
    .rpr-d1 { animation-delay: .06s } .rpr-d2 { animation-delay: .12s }
    .rpr-d3 { animation-delay: .18s } .rpr-d4 { animation-delay: .24s }

    /* skeleton shimmer */
    @keyframes rpr-shimmer { 100% { transform: translateX(100%) } }
    .rpr-skel {
      position: relative;
      overflow: hidden;
      background: #1b1b1b;
    }
    .rpr-skel::after {
      content: "";
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,.05) 50%, transparent 100%);
      animation: rpr-shimmer 1.4s ease-in-out infinite;
    }

    /* keyboard focus ring (accessibility) */
    :focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; border-radius: 4px; }
    button:focus:not(:focus-visible) { outline: none; }

    @media (prefers-reduced-motion: reduce) {
      .rpr-fade, .rpr-rise, .rpr-pop, .rpr-toast { animation: none !important; }
      .rpr-skel::after { animation: none !important; }
    }
  `;
  document.head.appendChild(style);

  // SVG favicon: a poster-frame silhouette with topo lines. The media query
  // lives INSIDE the svg, so it flips for light vs dark browser chrome.
  if (!document.getElementById("repostr-favicon")) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#17150f" stroke-width="2"><style>@media (prefers-color-scheme:dark){*{stroke:#ecece4}}</style><rect x="6" y="2.5" width="12" height="19"/></svg>`;
    const icon = document.createElement("link");
    icon.id = "repostr-favicon";
    icon.rel = "icon";
    icon.type = "image/svg+xml";
    icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    document.head.appendChild(icon);
  }
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
  return (
    <main className="min-h-screen bg-[#0c0c0c] font-mono text-[#cfcfcf]">
      <Router>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/:owner/:repo" element={<RepoView />} />
          <Route path="/:owner/:repo/edit" element={<RepoView edit />} />
          <Route path="*" element={<Landing />} />
        </Routes>
      </Router>
    </main>
  );
}

// landing: hero + gallery. picking a repo pushes a real /owner/repo route.
function Landing() {
  const gallery = useQuery<PosterRow[]>("recentPosters");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | undefined>();

  const go = (raw: string) => {
    const parsed = parseRepoInput(raw);
    if (!parsed) {
      setError("Paste a GitHub repo URL — e.g. github.com/facebook/react.");
      return;
    }
    navigate(`/${parsed.owner}/${parsed.name}`);
  };

  return (
    <>
      <Hero input={input} setInput={setInput} onPaint={() => go(input)} onPick={go} error={error} />
      <Gallery rows={gallery} onPick={go} />
    </>
  );
}

// one repo, at /:owner/:repo (and /:owner/:repo/edit). Render params live in the
// query string so copy-link + reload reproduce the exact view; the PATH drives
// real history entries, so the browser back button works between pages.
function RepoView({ edit }: { edit?: boolean }) {
  const routeParams = useParams<{ owner?: string; repo?: string }>();
  const loc = useLocation();
  const owner = routeParams.owner ?? "";
  const name = routeParams.repo ?? "";
  const slug = slugFor(owner, name);

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

  const [model, setModel] = useState<PosterModel | null>(null);
  const [params, setParams] = useState<RenderParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runToken = useRef(0);
  const rafRef = useRef(0);
  const toastTimer = useRef(0);

  function flash(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }
  function copy(m: PosterModel, p: RenderParams) {
    copyLink(m, p);
    flash("link copied");
  }
  function set<K extends keyof RenderParams>(key: K, value: RenderParams[K]) {
    setParams((p) => (p ? { ...p, [key]: value } : p));
  }
  function shuffle() {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    setParams((p) =>
      p
        ? {
            ...p,
            seed: (Math.random() * 4294967296) >>> 0,
            zoom: r2(1 + Math.random() * 2),
            contourGap: r3(0.06 + Math.random() * 0.14),
            lineWeight: r2(0.8 + Math.random() * 1.0),
            dotScale: r2(0.6 + Math.random() * 1.1),
            negativeSpace: r2(0.2 + Math.random() * 0.4),
            grain: r2(0.18 + Math.random() * 0.22)
          }
        : p
    );
  }

  // fetch whenever the repo (slug) changes
  useEffect(() => {
    if (!owner || !name) return;
    const token = ++runToken.current;
    setModel(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/repo?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`
        );
        const data = await res.json();
        if (runToken.current !== token) return;
        if (!res.ok || data.error) {
          // viral / rate-limit: show a friendly, user-facing message (the raw
          // server message is owner-oriented — "add a GITHUB_TOKEN").
          const msg =
            data.kind === "rate_limit" || res.status === 429
              ? "Repostr is under heavy load right now — GitHub's rate limit is maxed. Give it a few minutes and try again."
              : (data.error ?? `Couldn't load this repo (${res.status}).`);
          setError(msg);
          return;
        }
        const m = analyze(data.repo as RawRepo);
        const sp = new URLSearchParams(window.location.search);
        setModel(m);
        setParams([...sp.keys()].length ? paramsFromQuery(m, sp) : defaultParams(m));
        const top = m.palette[0];
        void recordPoster({
          slug: m.slug,
          owner: m.owner,
          name: m.name,
          language: top?.name ?? "",
          languageColor: top?.color ?? "#8a8a8a",
          volatility: m.volatility
        });
      } catch {
        if (runToken.current === token) setError("Network error reaching the server.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // warm the OG share image for the CURRENT view (keyed by its full param-set),
  // debounced so dragging sliders doesn't spam renders. Each distinct variant
  // gets its own cached image, so different shuffles unfurl differently.
  useEffect(() => {
    if (!model || !params) return;
    const key = paramsQuery(model, params); // repo=slug[&param=…]
    if (ogDone.current.has(key)) return;
    const id = window.setTimeout(() => {
      ogDone.current.add(key);
      try {
        const b64 = renderOgDataUrl(model, params).split(",")[1] ?? "";
        if (b64) void fetch(`/og?${key}`, { method: "POST", body: b64 });
      } catch {
        /* OG is best-effort */
      }
    }, 1100);
    return () => window.clearTimeout(id);
  }, [model, params]);

  // live render, coalesced to one paint per frame
  useEffect(() => {
    if (!model || !params || !canvasRef.current) return;
    const canvas = canvasRef.current;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => renderPoster(canvas, model, params));
    return () => cancelAnimationFrame(rafRef.current);
  }, [model, params, edit]);

  // mirror the render params into the query string (the path stays /owner/repo)
  useEffect(() => {
    if (!model || !params) return;
    const sp = new URLSearchParams(paramsQuery(model, params));
    sp.delete("repo");
    const qs = sp.toString();
    const path = `/${owner}/${name}${edit ? "/edit" : ""}`;
    window.history.replaceState(null, "", qs ? `${path}?${qs}` : path);
  }, [model, params, edit, owner, name]);

  if (error) {
    return (
      <section className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="font-mono text-sm text-white">{slug}</div>
        <p className="max-w-sm font-mono text-xs text-[#e06b5a]">{error}</p>
        <Btn variant="accent" icon="back" onClick={() => navigate("/")}>
          back
        </Btn>
      </section>
    );
  }
  if (!model || !params) return <Loading slug={slug} />;

  const search = loc.search || "";
  return (
    <>
      {!edit && (
        <ResultView
          canvasRef={canvasRef}
          model={model}
          params={params}
          onShuffle={shuffle}
          onEdit={() => navigate(`/${owner}/${name}/edit${search}`)}
          onReset={() => navigate("/")}
          onShare={() => setShareOpen(true)}
        />
      )}
      {edit && (
        <Editor
          canvasRef={canvasRef}
          model={model}
          params={params}
          set={set}
          onShuffle={shuffle}
          onClose={() => navigate(`/${owner}/${name}${search}`)}
          onReset={() => navigate("/")}
          onShare={() => setShareOpen(true)}
        />
      )}
      {shareOpen && (
        <ShareModal
          model={model}
          params={params}
          onCopy={() => copy(model, params)}
          onClose={() => setShareOpen(false)}
        />
      )}
      {toast && <Toast>{toast}</Toast>}
    </>
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
    <section className="mx-auto flex max-w-2xl flex-col items-center px-6 pb-16 pt-[clamp(2rem,10vw,8rem)] text-center">
      <h1 className="font-sans text-6xl font-bold tracking-tight text-white sm:text-7xl">Repostr</h1>
      <h2 className="mt-3 font-mono text-[13px] text-[#8f8f8f]">Git history as print</h2>
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
          className="group inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-white px-7 py-3.5 text-sm font-semibold text-black shadow-[0_2px_16px_rgba(255,255,255,0.14)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_26px_rgba(255,255,255,0.26)] active:translate-y-0"
        >
          <Icon name="wand" className="h-4 w-4" />
          create poster
        </button>
      </form>

      {error && <p className="mt-3 font-mono text-xs text-[#e06b5a]">{error}</p>}

      <div className="mt-12 w-full">
        <div className="mb-3 font-mono text-[12px] font-medium text-[#6f6f6f]">or try one</div>
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

// on-brand rotating status lines (cartography / git / print themed)
const LOADING_PHRASES = [
  "reading the commit history",
  "surveying the terrain",
  "tracing the contours",
  "measuring the churn",
  "plotting the releases",
  "charting the timeline",
  "finding the dead zones",
  "counting the rewrites",
  "triangulating the flow",
  "mixing the inks",
  "warming up the press",
  "developing the print"
];

function Loading({ slug }: { slug: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [phrase, setPhrase] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setPhrase((p) => (p + 1) % LOADING_PHRASES.length),
      1500
    );
    return () => clearInterval(id);
  }, []);

  // a living mini-poster: animated topographic iso-contours, same language as
  // the finished print, so the wait previews the result.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = 360;
    const H = 480;
    canvas.width = W;
    canvas.height = H;
    const cell = 9;
    const cols = Math.ceil(W / cell);
    const rows = Math.ceil(H / cell);
    const field = (x: number, y: number, t: number) => {
      const nx = x / W;
      const ny = y / H;
      return (
        Math.sin(nx * 6.0 + t) * 0.6 +
        Math.cos(ny * 5.0 - t * 0.8) * 0.5 +
        Math.sin((nx + ny) * 4.2 + t * 0.55) * 0.42 +
        Math.cos((nx - ny) * 7.5 - t * 0.4) * 0.3
      );
    };
    const levels: number[] = [];
    for (let l = -1.5; l <= 1.5; l += 0.18) levels.push(l);
    const seg: Record<number, number[]> = {
      1: [3, 2], 2: [2, 1], 3: [3, 1], 4: [0, 1], 6: [0, 2], 7: [0, 3],
      8: [0, 3], 9: [0, 2], 11: [0, 1], 12: [3, 1], 13: [2, 1], 14: [3, 2]
    };
    const pt = (e: number, x: number, y: number, tl: number, tr: number, br: number, bl: number, lv: number): [number, number] => {
      const f = (a: number, b: number) => {
        const d = b - a;
        return Math.abs(d) < 1e-9 ? 0.5 : (lv - a) / d;
      };
      if (e === 0) return [x + cell * f(tl, tr), y];
      if (e === 1) return [x + cell, y + cell * f(tr, br)];
      if (e === 2) return [x + cell * f(bl, br), y + cell];
      return [x, y + cell * f(tl, bl)];
    };
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = ((now - t0) / 1000) * 0.55;
      ctx.fillStyle = "#efece3";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(26,24,20,0.5)";
      ctx.lineWidth = 1;
      const vals: number[][] = [];
      for (let j = 0; j <= rows; j++) {
        vals[j] = [];
        for (let i = 0; i <= cols; i++) vals[j][i] = field(i * cell, j * cell, t);
      }
      for (const lv of levels) {
        ctx.beginPath();
        for (let j = 0; j < rows; j++)
          for (let i = 0; i < cols; i++) {
            const x = i * cell, y = j * cell;
            const tl = vals[j][i], tr = vals[j][i + 1], br = vals[j + 1][i + 1], bl = vals[j + 1][i];
            let idx = 0;
            if (tl > lv) idx |= 8;
            if (tr > lv) idx |= 4;
            if (br > lv) idx |= 2;
            if (bl > lv) idx |= 1;
            const dr = (a: number, b: number) => {
              const p0 = pt(a, x, y, tl, tr, br, bl, lv);
              const p1 = pt(b, x, y, tl, tr, br, bl, lv);
              ctx.moveTo(p0[0], p0[1]);
              ctx.lineTo(p1[0], p1[1]);
            };
            if (idx === 5) { dr(0, 3); dr(2, 1); }
            else if (idx === 10) { dr(0, 1); dr(3, 2); }
            else if (seg[idx]) dr(seg[idx][0], seg[idx][1]);
          }
        ctx.stroke();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <div
        className="rpr-pop w-[min(300px,72vw)] bg-[#efece3] p-2 shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)] ring-1 ring-black/50"
        style={{ aspectRatio: "3 / 4" }}
      >
        <canvas ref={ref} className="block h-full w-full" />
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div className="font-mono text-sm text-white">{slug}</div>
        <div className="font-mono text-[12px] text-[#7f7f7f]">
          <span key={phrase} className="rpr-fade inline-block">{LOADING_PHRASES[phrase]}…</span>
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
  onReset,
  onShare
}: {
  canvasRef: { current: HTMLCanvasElement | null };
  model: PosterModel;
  params: RenderParams;
  onShuffle: () => void;
  onEdit: () => void;
  onReset: () => void;
  onShare: () => void;
}) {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center px-2 py-8 sm:px-6 sm:py-10">
      <div className="rpr-pop">
        <PosterFrame canvasRef={canvasRef} mode="result" />
      </div>

      <div className="rpr-rise rpr-d1 mt-8 flex flex-wrap items-center justify-center gap-2">
        <Btn variant="primary" icon="shuffle" onClick={onShuffle}>shuffle</Btn>
        <Btn icon="edit" onClick={onEdit}>edit</Btn>
        <Btn icon="download" onClick={() => downloadPoster(model, params)}>download</Btn>
        <Btn icon="share" onClick={onShare}>share</Btn>
        <span className="mx-1 h-5 w-px bg-[#262626]" aria-hidden />
        <Btn variant="accent" icon="plus" onClick={onReset}>new poster</Btn>
      </div>

      <p className="rpr-rise rpr-d2 mt-5 text-center font-mono text-[11px] text-[#6f6f6f]">
        {model.owner}/<span className="text-[#9a9a9a]">{model.name}</span>
        <span className="mx-2 text-[#3a3a3a]">·</span>
        {formatDateRange(model.firstT, model.lastT)}
        <span className="mx-2 text-[#3a3a3a]">·</span>
        <span className="text-[#9a9a9a]">{model.palette[0]?.name ?? "?"}</span>
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
  onReset,
  onShare
}: {
  canvasRef: { current: HTMLCanvasElement | null };
  model: PosterModel;
  params: RenderParams;
  set: <K extends keyof RenderParams>(key: K, value: RenderParams[K]) => void;
  onShuffle: () => void;
  onClose: () => void;
  onReset: () => void;
  onShare: () => void;
}) {
  return (
    <div className="rpr-fade flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[#1e1e1e] bg-[#0c0c0c]/90 px-4 py-3 font-mono text-[11px] backdrop-blur sm:px-5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            className="group flex shrink-0 items-center gap-1.5 text-[#9b9b9b] transition hover:text-white"
            onClick={onClose}
          >
            <Icon
              name="back"
              className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5"
            />
            poster
          </button>
          <span className="text-[#3a3a3a]">/</span>
          <span className="min-w-0 truncate text-white">
            {model.owner}/<span className="font-bold">{model.name}</span>
          </span>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Btn variant="primary" icon="shuffle" onClick={onShuffle}>shuffle</Btn>
          <Btn icon="download" onClick={() => downloadPoster(model, params)}>download</Btn>
          <Btn icon="share" onClick={onShare}>share</Btn>
          <span className="mx-0.5 hidden h-5 w-px bg-[#262626] sm:block" aria-hidden />
          <Btn variant="accent" icon="plus" onClick={onReset}>new poster</Btn>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-px bg-[#1e1e1e] lg:grid-cols-[260px_1fr_300px]">
        {/* metadata drops to the bottom on mobile; sits left on desktop */}
        <DataPanel model={model} className="order-last lg:order-none" />
        <div className="flex items-center justify-center bg-[#0a0a0a] p-4 sm:p-6">
          <PosterFrame canvasRef={canvasRef} mode="editor" />
        </div>
        <Controls params={params} set={set} />
      </div>
    </div>
  );
}

function ShareModal({
  model,
  params,
  onCopy,
  onClose
}: {
  model: PosterModel;
  params: RenderParams;
  onCopy: () => void;
  onClose: () => void;
}) {
  const url = `${window.location.origin}/share?${paramsQuery(model, params)}`;
  // preview the EXACT current view (not the cached default), at a light scale
  const preview = useMemo(() => renderToDataUrl(model, params, 0.7), [model, params]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="rpr-fade fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Share poster"
    >
      <div
        className="rpr-pop w-full max-w-md overflow-hidden rounded-xl border border-[#262626] bg-[#121212] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#1e1e1e] px-5 py-3.5">
          <span className="font-mono text-[12px] font-medium text-[#bdbdbd]">share</span>
          <button
            className="rounded-md p-1 text-[#7a7a7a] transition hover:bg-white/5 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-4 p-5">
          <img
            src={preview}
            alt={`${model.owner}/${model.name} poster`}
            className="h-32 w-24 shrink-0 rounded-md bg-[#efece3] object-cover ring-1 ring-black/40"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-sans text-base font-semibold text-white">
              {model.owner}/{model.name}
            </div>
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-[#7f7f7f]">
              Anyone with the link opens this exact poster. Pasted into Slack, X or Discord it
              unfurls with a preview.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-5 pb-5">
          <input
            readOnly
            value={url}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            className="min-w-0 flex-1 truncate rounded-md border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5 font-mono text-[11px] text-[#bdbdbd] outline-none focus:border-[#444]"
          />
          <Btn variant="primary" icon="copy" onClick={onCopy}>copy</Btn>
        </div>
      </div>
    </div>
  );
}

function Toast({ children }: { children: any }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-[60] flex justify-center">
      <div className="rpr-toast flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-2 font-mono text-[11px] text-white shadow-lg">
        <Icon name="check" className="h-3.5 w-3.5 text-[#7fd18b]" />
        {children}
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
  // On mobile the poster goes near-full-width (just a sliver of padding); from
  // sm up it's height-driven and capped so width never overflows its container
  // (editor caps by the centre column = viewport minus the two ~280px panels).
  const sizing =
    mode === "result"
      ? "w-[94vw] sm:w-auto sm:h-[min(82vh,116vw)]"
      : mode === "editor"
        ? "w-[90vw] sm:w-auto sm:h-[max(260px,min(86vh,calc((100vw-600px)*1.333)))]"
        : "w-full max-w-[460px]";
  return (
    <div
      className={`${sizing} bg-[#efece3] p-2 shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)] ring-1 ring-black/50`}
      style={{ aspectRatio: "3 / 4" }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

function DataPanel({ model, className = "" }: { model: PosterModel; className?: string }) {
  return (
    <aside className={`bg-[#121212] p-5 ${className}`}>
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
  const variants: Array<RenderParams["dark"]> = ["auto", "light", "dark"];
  return (
    <aside className="bg-[#121212] p-5">
      <div className="flex items-center justify-between">
        <PanelTitle>controls</PanelTitle>
        <Toggle on={params.wireframe} onClick={() => set("wireframe", !params.wireframe)}>
          lines only
        </Toggle>
      </div>

      {/* shuffle re-rolls the seed (variant · ground colour · zoom · field).
          these controls fine-tune the current poster on top of that roll. */}
      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1.5 font-mono text-[11px] text-[#8f8f8f]">palette</div>
          <div className="flex gap-1.5">
            {variants.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => set("dark", m)}
                className={`flex-1 rounded px-2 py-1.5 font-mono text-[11px] transition ${
                  params.dark === m
                    ? "bg-white text-black"
                    : "border border-[#2a2a2a] text-[#8f8f8f] hover:border-white hover:text-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <Slider label="zoom" value={params.zoom} min={1} max={4} step={0.1} onChange={(v) => set("zoom", v)} />
        <Slider label="line spacing" value={params.contourGap} min={0.05} max={0.28} step={0.005} onChange={(v) => set("contourGap", v)} />
        <Slider label="line weight" value={params.lineWeight} min={0.5} max={2.5} step={0.05} onChange={(v) => set("lineWeight", v)} />
        <Slider label="churn dots" value={params.dotScale} min={0} max={3} step={0.05} onChange={(v) => set("dotScale", v)} />
        <Slider label="negative space" value={params.negativeSpace} min={0} max={0.85} step={0.02} onChange={(v) => set("negativeSpace", v)} />
        <Slider label="grain" value={params.grain} min={0} max={1} step={0.02} onChange={(v) => set("grain", v)} />
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
      className={`rounded px-2.5 py-1 font-mono text-[11px] transition ${
        on ? "bg-white text-black" : "border border-[#2a2a2a] text-[#8f8f8f] hover:border-white"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// --- icons -----------------------------------------------------------------
// Hugeicons-style stroke icons, inlined (Lakebed forbids npm packages). 24-grid,
// 1.8 stroke, round caps — the clean line aesthetic the brand uses.

type IconName =
  | "shuffle"
  | "sparkles"
  | "edit"
  | "download"
  | "share"
  | "copy"
  | "check"
  | "close"
  | "back"
  | "plus"
  | "wand";

// Authentic Hugeicons "stroke-rounded" path data (free set, v4.2.1).
const ICON_PATHS: Record<IconName, any> = {
  shuffle: (
    <>
      <path d="M19.5576 4L20.4551 4.97574C20.8561 5.41165 21.0566 5.62961 20.9861 5.81481C20.9155 6 20.632 6 20.0649 6C18.7956 6 17.2771 5.79493 16.1111 6.4733C15.3903 6.89272 14.8883 7.62517 14.0392 9M3 18H4.58082C6.50873 18 7.47269 18 8.2862 17.5267C9.00708 17.1073 9.50904 16.3748 10.3582 15" />
      <path d="M19.5576 20L20.4551 19.0243C20.8561 18.5883 21.0566 18.3704 20.9861 18.1852C20.9155 18 20.632 18 20.0649 18C18.7956 18 17.2771 18.2051 16.1111 17.5267C15.2976 17.0534 14.7629 16.1815 13.6935 14.4376L10.7038 9.5624C9.63441 7.81853 9.0997 6.9466 8.2862 6.4733C7.47269 6 6.50873 6 4.58082 6H3" />
    </>
  ),
  sparkles: (
    <>
      <path d="M15 2L15.5387 4.39157C15.9957 6.42015 17.5798 8.00431 19.6084 8.46127L22 9L19.6084 9.53873C17.5798 9.99569 15.9957 11.5798 15.5387 13.6084L15 16L14.4613 13.6084C14.0043 11.5798 12.4202 9.99569 10.3916 9.53873L8 9L10.3916 8.46127C12.4201 8.00431 14.0043 6.42015 14.4613 4.39158L15 2Z" />
      <path d="M7 12L7.38481 13.7083C7.71121 15.1572 8.84275 16.2888 10.2917 16.6152L12 17L10.2917 17.3848C8.84275 17.7112 7.71121 18.8427 7.38481 20.2917L7 22L6.61519 20.2917C6.28879 18.8427 5.15725 17.7112 3.70827 17.3848L2 17L3.70827 16.6152C5.15725 16.2888 6.28879 15.1573 6.61519 13.7083L7 12Z" />
    </>
  ),
  edit: (
    <>
      <path d="M16.4249 4.60509L17.4149 3.6151C18.2351 2.79497 19.5648 2.79497 20.3849 3.6151C21.205 4.43524 21.205 5.76493 20.3849 6.58507L19.3949 7.57506M16.4249 4.60509L9.76558 11.2644C9.25807 11.772 8.89804 12.4078 8.72397 13.1041L8 16L10.8959 15.276C11.5922 15.102 12.228 14.7419 12.7356 14.2344L19.3949 7.57506M16.4249 4.60509L19.3949 7.57506" />
      <path d="M18.9999 13.5C18.9999 16.7875 18.9999 18.4312 18.092 19.5376C17.9258 19.7401 17.7401 19.9258 17.5375 20.092C16.4312 21 14.7874 21 11.4999 21H11C7.22876 21 5.34316 21 4.17159 19.8284C3.00003 18.6569 3 16.7712 3 13V12.5C3 9.21252 3 7.56879 3.90794 6.46244C4.07417 6.2599 4.2599 6.07417 4.46244 5.90794C5.56879 5 7.21252 5 10.5 5" />
    </>
  ),
  download: (
    <>
      <path d="M16.9504 12.1817C17.1981 12.814 16.5076 13.5726 15.1267 15.0899C13.6702 16.6902 12.9201 17.4904 12 17.5C11.0799 17.4904 10.3298 16.6902 8.87331 15.0899C7.49239 13.5726 6.80193 12.814 7.04964 12.1817C7.05868 12.1586 7.06851 12.1359 7.0791 12.1135C7.34928 11.542 8.24477 11.5029 10 11.5002V4.99998C10 4.53501 10 4.30253 10.0511 4.11179C10.1898 3.59414 10.5941 3.1898 11.1118 3.05111C11.3025 3 11.535 3 12 3C12.4649 3 12.6974 3 12.8882 3.05111C13.4058 3.1898 13.8102 3.59414 13.9489 4.11179C14 4.30253 14 4.53501 14 4.99998V11.5002C15.7552 11.5029 16.6507 11.542 16.9209 12.1135C16.9315 12.1359 16.9413 12.1586 16.9504 12.1817Z" />
      <path d="M5.00006 21H19.0001" />
    </>
  ),
  share: (
    <>
      <path d="M21 6.5C21 8.15685 19.6569 9.5 18 9.5C16.3431 9.5 15 8.15685 15 6.5C15 4.84315 16.3431 3.5 18 3.5C19.6569 3.5 21 4.84315 21 6.5Z" />
      <path d="M9 12C9 13.6569 7.65685 15 6 15C4.34315 15 3 13.6569 3 12C3 10.3431 4.34315 9 6 9C7.65685 9 9 10.3431 9 12Z" />
      <path d="M21 17.5C21 19.1569 19.6569 20.5 18 20.5C16.3431 20.5 15 19.1569 15 17.5C15 15.8431 16.3431 14.5 18 14.5C19.6569 14.5 21 15.8431 21 17.5Z" />
      <path d="M8.72852 10.7495L15.2285 7.75M8.72852 13.25L15.2285 16.2495" />
    </>
  ),
  copy: (
    <>
      <path d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9L16 9C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16L9 15Z" />
      <path d="M16.9999 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 16.9999" />
    </>
  ),
  check: <path d="M5 14L8.5 17.5L19 6.5" />,
  close: <path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" />,
  back: <path d="M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18" />,
  plus: (
    <>
      <path d="M12 5V19" />
      <path d="M5 12H19" />
    </>
  ),
  wand: (
    <>
      <path d="M13.9258 12.7775L11.7775 10.6292C11.4847 10.3364 11.3383 10.19 11.1803 10.1117C10.8798 9.96277 10.527 9.96277 10.2264 10.1117C10.0685 10.19 9.92207 10.3364 9.62923 10.6292C9.33638 10.9221 9.18996 11.0685 9.11169 11.2264C8.96277 11.527 8.96277 11.8798 9.11169 12.1803C9.18996 12.3383 9.33638 12.4847 9.62923 12.7775L11.7775 14.9258M13.9258 12.7775L20.3708 19.2225C20.6636 19.5153 20.81 19.6617 20.8883 19.8197C21.0372 20.1202 21.0372 20.473 20.8883 20.7736C20.81 20.9315 20.6636 21.0779 20.3708 21.3708C20.0779 21.6636 19.9315 21.81 19.7736 21.8883C19.473 22.0372 19.1202 22.0372 18.8197 21.8883C18.6617 21.81 18.5153 21.6636 18.2225 21.3708L11.7775 14.9258" />
      <path d="M17 2L17.2948 2.7966C17.6813 3.84117 17.8746 4.36345 18.2556 4.74445C18.6366 5.12545 19.1588 5.31871 20.2034 5.70523L21 6L20.2034 6.29477C19.1588 6.68129 18.6366 6.87456 18.2556 7.25555C17.8746 7.63655 17.6813 8.15883 17.2948 9.2034L17 10L16.7052 9.2034C16.3187 8.15884 16.1254 7.63655 15.7444 7.25555C15.3634 6.87455 14.8412 6.68129 13.7966 6.29477L13 6L13.7966 5.70523C14.8412 5.31871 15.3634 5.12545 15.7444 4.74445C16.1254 4.36345 16.3187 3.84117 16.7052 2.7966L17 2Z" />
      <path d="M6 4L6.22108 4.59745C6.51097 5.38087 6.65592 5.77259 6.94167 6.05834C7.22741 6.34408 7.61913 6.48903 8.40255 6.77892L9 7L8.40255 7.22108C7.61913 7.51097 7.22741 7.65592 6.94166 7.94167C6.65592 8.22741 6.51097 8.61913 6.22108 9.40255L6 10L5.77892 9.40255C5.48903 8.61913 5.34408 8.22741 5.05833 7.94167C4.77259 7.65592 4.38087 7.51097 3.59745 7.22108L3 7L3.59745 6.77892C4.38087 6.48903 4.77259 6.34408 5.05833 6.05833C5.34408 5.77259 5.48903 5.38087 5.77892 4.59745L6 4Z" />
    </>
  )
};

function Icon({ name, className = "h-3.5 w-3.5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// --- buttons ----------------------------------------------------------------
// Three tiers of intent:
//   primary — the one action we most want pressed (shuffle). Solid, glowing,
//             lifts on hover. Visually dominant.
//   accent  — a distinct, inviting "fresh start" (new). Gradient-lit outline +
//             sparkle, clearly above the quiet utilities without stealing the
//             primary's weight.
//   ghost   — low-key utilities (edit/download/share). Icon-forward, near-silent
//             until hovered.

type BtnVariant = "primary" | "accent" | "ghost";

function Btn({
  children,
  onClick,
  variant = "ghost",
  icon
}: {
  children: any;
  onClick: () => void;
  variant?: BtnVariant;
  icon?: IconName;
}) {
  const base =
    "group inline-flex items-center justify-center gap-1.5 rounded-lg font-mono text-[12px] transition-all duration-200 ease-out select-none";
  // icon-only & square on mobile; icon + label with side padding from sm up.
  const styles: Record<BtnVariant, string> = {
    primary:
      "p-2.5 sm:px-5 sm:py-2.5 bg-white text-black font-semibold shadow-[0_2px_14px_rgba(255,255,255,0.16)] hover:-translate-y-0.5 hover:shadow-[0_6px_22px_rgba(255,255,255,0.28)] active:translate-y-0 active:shadow-[0_2px_10px_rgba(255,255,255,0.18)]",
    accent:
      "p-2.5 sm:px-4 sm:py-2.5 text-white rounded-lg border border-[#363636] bg-gradient-to-b from-white/[0.07] to-white/[0.01] hover:-translate-y-0.5 hover:border-[#5a5a5a] hover:from-white/[0.14] hover:to-white/[0.03] hover:shadow-[0_6px_18px_rgba(0,0,0,0.45)] active:translate-y-0",
    ghost:
      "p-2.5 sm:px-3.5 sm:py-2.5 text-[#8f8f8f] border border-transparent hover:text-white hover:bg-white/[0.05]"
  };
  const iconSize = variant === "ghost" ? "h-4 w-4 sm:h-3.5 sm:w-3.5" : "h-4 w-4";
  const label = typeof children === "string" ? children : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={icon ? label : undefined}
      className={`${base} ${styles[variant]}`}
    >
      {icon && <Icon name={icon} className={iconSize} />}
      <span className={icon ? "hidden sm:inline" : undefined}>{children}</span>
    </button>
  );
}

function Gallery({ rows, onPick }: { rows?: PosterRow[]; onPick: (slug: string) => void }) {
  const loading = rows === undefined;
  // loaded but nothing painted yet — hide the section entirely
  if (!loading && rows.length === 0) return null;
  return (
    <section className="rpr-fade mx-auto max-w-2xl px-6 pb-20">
      <PanelTitle>
        recently painted <span className="text-[#5f5f5f]">(public feed)</span>
      </PanelTitle>
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <GallerySkeleton key={i} />)
          : rows.map((row) => (
          <button
            key={row.id}
            onClick={() => onPick(row.slug)}
            className="group overflow-hidden rounded-lg border border-[#222] bg-[#141414] text-left transition duration-200 hover:-translate-y-0.5 hover:border-[#555] hover:shadow-[0_12px_30px_-14px_rgba(0,0,0,0.85)]"
          >
            {/* the actual poster, served from /og (warmed when it was painted);
                falls back to a branded card until warmed. */}
            <div
              className="relative aspect-[3/4] overflow-hidden"
              style={{ backgroundColor: `${row.languageColor}1f` }}
            >
              <img
                src={`/og?repo=${encodeURIComponent(row.slug)}`}
                alt={`${row.owner}/${row.name} poster`}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.opacity = "0";
                }}
              />
            </div>
            <div className="flex items-center gap-2 px-2.5 py-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.languageColor }}
              />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[10px] text-[#6f6f6f]">{row.owner}/</span>
                <span className="block truncate font-mono text-xs text-white">{row.name}</span>
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function GallerySkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-[#222] bg-[#141414]">
      <div className="rpr-skel aspect-[3/4]" />
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="rpr-skel h-2 w-2 shrink-0 rounded-full" />
        <span className="min-w-0 flex-1 space-y-1.5 py-0.5">
          <span className="rpr-skel block h-2 w-9 rounded" />
          <span className="rpr-skel block h-2.5 w-20 rounded" />
        </span>
      </div>
    </div>
  );
}

function PanelTitle({ children, className = "" }: { children: any; className?: string }) {
  return (
    <div className={`font-mono text-[12px] font-medium text-[#6f6f6f] ${className}`}>
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
  "zoom",
  "contourGap",
  "lineWeight",
  "dotScale",
  "negativeSpace",
  "grain",
  "dark",
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
