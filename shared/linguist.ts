// GitHub Linguist language colors (curated subset of the most common languages).
// Source of truth: github-linguist/linguist languages.yml. We embed a curated map
// rather than the full ~600-entry file; unknown languages get a deterministic color.

export const LINGUIST_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Java: "#b07219",
  Go: "#00ADD8",
  Rust: "#dea584",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Scala: "#c22d40",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Less: "#1d365d",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Astro: "#ff5a03",
  Dart: "#00B4AB",
  Elixir: "#6e4a7e",
  Erlang: "#B83998",
  Haskell: "#5e5086",
  Clojure: "#db5855",
  Lua: "#000080",
  Perl: "#0298c3",
  R: "#198CE7",
  Julia: "#a270ba",
  "Objective-C": "#438eff",
  "Objective-C++": "#6866fb",
  Dockerfile: "#384d54",
  Makefile: "#427819",
  CMake: "#DA3434",
  MDX: "#fcb32c",
  Markdown: "#083fa1",
  "Jupyter Notebook": "#DA5B0B",
  PowerShell: "#012456",
  Assembly: "#6E4C13",
  Zig: "#ec915c",
  OCaml: "#3be133",
  "F#": "#b845fc",
  "Vim Script": "#199f4b",
  "Vim Snippet": "#199f4b",
  TeX: "#3D6117",
  Nix: "#7e7eff",
  Solidity: "#AA6746",
  GDScript: "#355570",
  Nim: "#ffc200",
  Crystal: "#000100",
  Groovy: "#4298b8",
  CoffeeScript: "#244776",
  Handlebars: "#f7931e",
  Pug: "#a86454",
  Stylus: "#ff6347",
  Twig: "#c1d026",
  Smarty: "#f0c040",
  Roff: "#ecdebe",
  "Emacs Lisp": "#c065db",
  "Common Lisp": "#3fb68b",
  Scheme: "#1e4aec",
  Fortran: "#4d41b1",
  COBOL: "#005ca5",
  Pascal: "#E3F171",
  Ada: "#02f88c",
  Haxe: "#df7900",
  PureScript: "#1D222D",
  ReScript: "#ed5051",
  Elm: "#60B5CC",
  WebAssembly: "#04133b",
  HCL: "#844FBA",
  "Terraform": "#5c4ee5",
  TOML: "#9c4221",
  YAML: "#cb171e",
  JSON: "#292929",
  SQL: "#e38c00",
  PLpgSQL: "#336790",
  GraphQL: "#e10098",
  Batchfile: "#C1F12E",
  AppleScript: "#101F1F",
  Verilog: "#b2b7f8",
  VHDL: "#adb2cb",
  Tcl: "#e4cc98",
  Prolog: "#74283c",
  Racket: "#3c5caa",
  Mojo: "#ff4c1f"
};

// Deterministic, pleasant color for languages not in the curated map.
// Maps the language name to a hue and returns a print-friendly muted color.
export function colorForLanguage(name: string): string {
  const known = LINGUIST_COLORS[name];
  if (known) {
    return known;
  }

  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  // mid saturation / mid lightness keeps it readable as paint, not neon.
  return hslToHex(hue, 55, 52);
}

export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}
