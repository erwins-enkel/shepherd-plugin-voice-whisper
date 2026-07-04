// voice-whisper — the server-side transcription backend for Shepherd's local-Whisper
// voice input (Shepherd issue #76). Install by cloning this repo into ~/.shepherd/plugins/
// (the only dir Shepherd's loader scans) and restarting Shepherd.
//
// What it does: exposes operator-auth'd HTTP routes under /api/plugins/voice-whisper/
//   • POST transcribe — accepts a recorded audio clip (multipart `file`, optional `lang`) and
//     returns { text }. Two backends: an opt-in faster-whisper HTTP server (config `serverUrl`,
//     preferred when reachable), else the local whisper.cpp CLI (ffmpeg → 16 kHz mono WAV → CLI).
//     Shepherd's core compose-bar mic calls this.
//   • GET  status    — detection result { available, engine, model, ffmpeg, … } the core UI
//     reads (memoized) to decide whether to offer/prefer the local mic.
//   • POST selftest  — runs a bundled per-language test clip ({ lang: "de" | "en" }) through the
//     live engine; backs the panel's and the test page's Test buttons.
//   • GET  test      — a self-contained operator test page: live mic recorder + the canned
//     self-tests + engine status. The gear-menu item opens it.
// It also publishes the detection state to the Settings → Plugins panel.
//
// Why the feature is split across two repos: Shepherd's plugin system is server-side and
// in-process — a plugin cannot run browser JS (getUserMedia / MediaRecorder) or add a
// button to the compose bar. So audio CAPTURE lives in Shepherd's core UI (ComposeBar.svelte,
// which POSTs to this route) and this repo is only the transcription engine.
//
// Types: `types.ts` is vendored from Shepherd's src/plugins/types.ts (the public plugin
// contract, apiVersion 1) so this repo type-checks standalone. The `import type` line is
// erased at runtime, so loading never depends on it.
import type { PluginContext, PluginUIView } from "./types";
import { mkdtemp, writeFile, rm, access, readdir, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ── config (config.json) ─────────────────────────────────────────────────────────────

/** Shape of this plugin's own config.json (all fields optional — sensible defaults). */
interface VoiceWhisperConfig {
  /** Absolute path to the whisper.cpp CLI. Default: auto-detect whisper-cli / whisper-cpp on PATH. */
  binaryPath?: string;
  /** Absolute path to a GGML model file. Default: scan ~/.shepherd/whisper/ for ggml-<size>.bin. */
  model?: string;
  /** Preferred model size when scanning ~/.shepherd/whisper/ (e.g. "small", "base"). Default "small". */
  modelSize?: string;
  /** Absolute path to ffmpeg. Default: auto-detect on PATH. */
  ffmpegPath?: string;
  /** Explicit base URL of a faster-whisper HTTP server (the `whisper-stt` server.py contract:
   *  GET /health + POST /transcribe). When set it is the ONLY URL probed and, if reachable, is
   *  preferred over the local CLI (no ffmpeg / local model needed). This is the one way to point at
   *  an OFF-HOST server — which sends recorded audio to it. Not the OpenAI-compatible
   *  `/v1/audio/transcriptions` nor whisper.cpp's `/inference`. Unset ⇒ localhost auto-discovery below. */
  serverUrl?: string;
  /** When `serverUrl` is unset, auto-discover a faster-whisper server on the LOCALHOST default
   *  candidate(s) — trusting one only if it passes the strict /health contract. Default `true`; set
   *  `false` to disable all probing. Discovery is localhost-only and never sends audio off-host. */
  serverDiscovery?: boolean;
  /** Pin transcription language. "de"/"en" force it; "auto" defers to the request's UI locale. Default "auto". */
  language?: "auto" | "de" | "en";
  /** When true, the core mic prefers local whisper even where the browser's Web Speech API works. Default false. */
  preferLocal?: boolean;
  /** Reject clips larger than this many bytes (413). Default 25 MiB. */
  maxBytes?: number;
  /** Max concurrent transcriptions before shedding with 429. Bounds host load when the compose bar
   *  fires rapid live-preview requests (or several clients dictate at once). Default 3. */
  maxConcurrent?: number;
}

export interface ResolvedConfig {
  binaryPath: string | null;
  model: string | null;
  modelSize: string;
  ffmpegPath: string | null;
  /** Explicit faster-whisper server URL (normalized), or null to use localhost discovery. */
  serverUrl: string | null;
  /** Auto-discover a localhost faster-whisper server when `serverUrl` is null. */
  serverDiscovery: boolean;
  language: "auto" | "de" | "en";
  preferLocal: boolean;
  maxBytes: number;
  maxConcurrent: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 3;
/** Slots the load gate keeps free for a final transcription, so disposable `mode=partial` preview
 *  requests can never 429-starve the one clip the user actually wants. */
const RESERVED_FOR_FINAL = 1;
const RUN_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 1_500;

/** Localhost URLs auto-probed when `serverUrl` is unset and discovery is on. Localhost-only by
 *  design so discovery never sends audio off-host; `9876` is the `whisper-stt` server.py default. */
export const DEFAULT_SERVER_CANDIDATES = ["http://127.0.0.1:9876"];

export function readConfig(raw: Record<string, unknown>): ResolvedConfig {
  const c = raw as VoiceWhisperConfig;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const lang = c.language === "de" || c.language === "en" ? c.language : "auto";
  const serverUrl = str(c.serverUrl);
  return {
    binaryPath: str(c.binaryPath),
    model: str(c.model),
    modelSize: str(c.modelSize) ?? "small",
    ffmpegPath: str(c.ffmpegPath),
    // Strip any trailing slash so `${serverUrl}/health` is well-formed. Empty/absent → discovery.
    serverUrl: serverUrl ? serverUrl.replace(/\/+$/, "") : null,
    serverDiscovery: c.serverDiscovery !== false,
    language: lang,
    preferLocal: c.preferLocal === true,
    maxBytes: typeof c.maxBytes === "number" && c.maxBytes > 0 ? c.maxBytes : DEFAULT_MAX_BYTES,
    maxConcurrent:
      typeof c.maxConcurrent === "number" && c.maxConcurrent >= 1
        ? Math.floor(c.maxConcurrent)
        : DEFAULT_MAX_CONCURRENT,
  };
}

// ── concurrency gate (bounds host load; exported for unit tests) ──────────────────────

/** A tiny counting gate: at most `max` holders at once. `tryEnter(reserved)` admits only while
 *  `inFlight < max - reserved`, so a low-priority caller can pass `reserved > 0` to leave that many
 *  slots free for higher-priority work. Every successful enter must be paired with a `leave()`.
 *
 *  This is how a disposable live-preview (`mode=partial`) request never starves the irreplaceable
 *  final transcription: previews reserve a slot for the final, the final reserves none. */
export function makeGate(max: number) {
  let inFlight = 0;
  return {
    tryEnter(reserved = 0): boolean {
      if (inFlight >= max - reserved) return false;
      inFlight += 1;
      return true;
    },
    leave(): void {
      if (inFlight > 0) inFlight -= 1;
    },
    get inFlight(): number {
      return inFlight;
    },
  };
}

// ── pure helpers (exported for unit tests) ───────────────────────────────────────────

/** Map a MediaRecorder MIME type to a file extension. Strips the `;codecs=…` suffix. */
export function extForMime(mime: string): string {
  const base = (mime || "").split(";")[0]?.trim().toLowerCase();
  switch (base) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
    case "audio/x-m4a":
      return "mp4";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

/** ffmpeg argv: decode a seekable input FILE → 16 kHz mono 16-bit PCM WAV FILE. We buffer the
 *  upload to a temp file first (never `-i pipe:0`) because iOS MediaRecorder mp4 carries a
 *  trailing `moov` atom that commonly fails to demux from a non-seekable pipe. */
export function resolveFfmpegArgs(ffmpeg: string, input: string, wav: string): string[] {
  // prettier-ignore
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    "-f", "wav", "-y", wav,
  ];
}

/** whisper.cpp CLI argv. Reads audio from a FILE path (`-f`), not stdin. `-nt` drops
 *  timestamps so stdout is plain text; `-l <lang>` pins the language when known. */
export function resolveWhisperArgs(
  binary: string,
  model: string,
  wav: string,
  lang: string | null,
): string[] {
  const args = [binary, "-m", model, "-f", wav, "-nt"];
  if (lang) args.push("-l", lang);
  return args;
}

/** Collapse whisper.cpp stdout (one text line per segment under `-nt`) into a single string. */
export function parseTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Resolve the effective language to pin: config override wins; else the request's UI locale
 *  when it is a supported code; else null (let whisper autodetect). */
export function resolveLang(cfg: ResolvedConfig, requested: string | null): string | null {
  if (cfg.language === "de" || cfg.language === "en") return cfg.language;
  return requested === "de" || requested === "en" ? requested : null;
}

// ── detection ─────────────────────────────────────────────────────────────────────────

export type Engine = "server" | "whisper.cpp";

export interface DetectDeps {
  which: (cmd: string) => string | null;
  exists: (path: string) => Promise<boolean>;
  /** Basenames in `dir`, or [] when the dir is missing. */
  listDir: (dir: string) => Promise<string[]>;
  home: () => string;
  /** GET <url>/health. Resolves the server's model ONLY when it reports `ready:true` with a
   *  plausible non-empty model name; null on unreachable / wrong shape / not ready. */
  probeServer: (url: string) => Promise<{ model: string } | null>;
}

export interface Detection {
  /** The backend that will actually be used (null when none is ready). */
  engine: Engine | null;
  /** A reachable, ready faster-whisper server, if `serverUrl` was set and it answered. */
  server: { url: string; model: string } | null;
  ffmpeg: string | null;
  binary: string | null;
  model: string | null;
  /** Actionable, copy-paste guidance for whatever is missing (empty when ready). */
  hint: string;
}

/** Strict `/health` acceptance: trust a server ONLY when it reports `ready:true` with a plausible
 *  non-empty model name. Guards against POSTing audio to an unrelated service on the configured URL. */
export function acceptHealth(body: unknown): { model: string } | null {
  const b = (body ?? {}) as { ready?: unknown; model?: unknown };
  if (b.ready === true && typeof b.model === "string" && b.model.trim()) return { model: b.model };
  return null;
}

async function resolveBinary(cfg: ResolvedConfig, d: DetectDeps): Promise<string | null> {
  if (cfg.binaryPath) return (await d.exists(cfg.binaryPath)) ? cfg.binaryPath : null;
  return d.which("whisper-cli") ?? d.which("whisper-cpp");
}

async function resolveModel(cfg: ResolvedConfig, d: DetectDeps): Promise<string | null> {
  if (cfg.model) return (await d.exists(cfg.model)) ? cfg.model : null;
  const dir = join(d.home(), ".shepherd", "whisper");
  const files = (await d.listDir(dir)).filter((f) => f.endsWith(".bin"));
  if (files.length === 0) return null;
  const preferred = `ggml-${cfg.modelSize}.bin`;
  const pick =
    files.find((f) => f === preferred) ?? files.find((f) => f.startsWith("ggml-")) ?? files[0]!;
  return join(dir, pick);
}

export async function detect(cfg: ResolvedConfig, d: DetectDeps): Promise<Detection> {
  // Which URLs to probe: an explicit serverUrl is the ONLY candidate (and may be off-host); else
  // auto-discover on the localhost defaults when discovery is on. First one that passes the strict
  // /health contract wins — so we never POST audio to a service that isn't a whisper server.
  const candidates = cfg.serverUrl
    ? [cfg.serverUrl]
    : cfg.serverDiscovery
      ? DEFAULT_SERVER_CANDIDATES
      : [];
  let server: { url: string; model: string } | null = null;
  for (const url of candidates) {
    const probed = await d.probeServer(url);
    if (probed) {
      server = { url, model: probed.model };
      break;
    }
  }

  const ffmpeg =
    cfg.ffmpegPath && (await d.exists(cfg.ffmpegPath)) ? cfg.ffmpegPath : d.which("ffmpeg");
  const binary = await resolveBinary(cfg, d);
  const model = await resolveModel(cfg, d);
  const cliReady = !!(ffmpeg && binary && model);

  // Server first (warm model, no local ffmpeg/model), then the whisper.cpp CLI.
  const engine: Engine | null = server ? "server" : cliReady ? "whisper.cpp" : null;

  let hint = "";
  if (!engine) {
    const missing: string[] = [];
    if (!ffmpeg)
      missing.push("Install ffmpeg (e.g. `brew install ffmpeg` or `apt install ffmpeg`).");
    if (!binary)
      missing.push(
        "Install whisper.cpp (e.g. `brew install whisper-cpp`) or set `binaryPath` in config.json.",
      );
    if (!model) {
      const home = join(d.home(), ".shepherd", "whisper");
      missing.push(
        `Download a GGML model into ${home}/, e.g.: mkdir -p ${home} && curl -L -o ${home}/ggml-${cfg.modelSize}.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${cfg.modelSize}.bin`,
      );
    }
    if (cfg.serverUrl)
      missing.push(`Or start the faster-whisper server at ${cfg.serverUrl} (config \`serverUrl\`).`);
    else if (cfg.serverDiscovery)
      missing.push(
        `Or run a faster-whisper server on ${DEFAULT_SERVER_CANDIDATES.join(", ")} (auto-discovered), or set \`serverUrl\` in config.json.`,
      );
    else
      missing.push(
        "Or enable the server backend: set `serverUrl` (or `serverDiscovery: true`) in config.json.",
      );
    hint = missing.join(" · ");
  }
  return { engine, server, ffmpeg: ffmpeg ?? null, binary, model, hint };
}

// ── transcription (injectable runner + IO for tests) ─────────────────────────────────

export interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CmdRunner = (cmd: string[], timeoutMs: number) => Promise<CmdResult>;

export interface TranscribeIO {
  /** Write bytes to a fresh seekable temp file with the given extension; return its path. */
  writeTemp: (bytes: Uint8Array, ext: string) => Promise<string>;
  /** Sibling `.wav` path for a written input file. */
  wavPathFor: (input: string) => string;
  /** Best-effort delete. */
  remove: (path: string) => Promise<void>;
}

/** ffmpeg → whisper.cpp over temp files, always cleaning both up. Throws on a non-zero exit. */
export async function runTranscription(opts: {
  bytes: Uint8Array;
  ext: string;
  lang: string | null;
  ffmpeg: string;
  binary: string;
  model: string;
  run: CmdRunner;
  io: TranscribeIO;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const input = await opts.io.writeTemp(opts.bytes, opts.ext);
  const wav = opts.io.wavPathFor(input);
  try {
    const ff = await opts.run(resolveFfmpegArgs(opts.ffmpeg, input, wav), timeoutMs);
    if (ff.exitCode !== 0)
      throw new Error(`ffmpeg exited ${ff.exitCode}: ${ff.stderr.slice(0, 400)}`);
    const wr = await opts.run(
      resolveWhisperArgs(opts.binary, opts.model, wav, opts.lang),
      timeoutMs,
    );
    if (wr.exitCode !== 0)
      throw new Error(`whisper exited ${wr.exitCode}: ${wr.stderr.slice(0, 400)}`);
    return parseTranscript(wr.stdout);
  } finally {
    await opts.io.remove(input).catch(() => {});
    await opts.io.remove(wav).catch(() => {});
  }
}

// ── faster-whisper server backend (injectable poster for tests) ──────────────────────

/** Thrown when the chosen server engine is unreachable AND no CLI fallback is available. The
 *  route maps this to 503 (engine not ready) rather than a generic 500 (transcription failed). */
export class ServerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerUnavailable";
  }
}

/** POST the clip to `<url>/transcribe` (multipart `file` + optional `language`) and return the
 *  raw JSON. Kept as a seam so tests drive the server path without a live server. */
export type ServerPoster = (opts: {
  url: string;
  bytes: Uint8Array;
  ext: string;
  lang: string | null;
  timeoutMs: number;
}) => Promise<{ status: number; body: { text?: string; error?: string } }>;

/** Send a clip to the faster-whisper server and return its text. Throws on non-2xx or missing text
 *  (faster-whisper decodes webm/ogg/mp4 itself, so no ffmpeg/local model is involved here). */
export async function runServerTranscription(opts: {
  url: string;
  bytes: Uint8Array;
  ext: string;
  lang: string | null;
  post: ServerPoster;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const res = await opts.post({
    url: opts.url,
    bytes: opts.bytes,
    ext: opts.ext,
    lang: opts.lang,
    timeoutMs,
  });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`server /transcribe returned ${res.status}: ${res.body?.error ?? ""}`.trim());
  const text = res.body?.text;
  if (typeof text !== "string") throw new Error("server /transcribe returned no text");
  return text.trim();
}

/** Run the clip through whatever engine `detect()` selected, with a post-time safety net: if the
 *  server was ready at detect() but has since gone away, fall back to the whisper.cpp CLI when it is
 *  ready; otherwise throw {@link ServerUnavailable} (→ 503), never an unhandled 500.
 *
 *  `onBackend` (optional) fires with the backend that ACTUALLY produced the text — which is not
 *  necessarily `detection.engine`, since a dead server degrades to the CLI. The self-test uses this so
 *  it never claims "via server" when whisper.cpp did the work. */
export async function transcribeClip(opts: {
  detection: Detection;
  bytes: Uint8Array;
  ext: string;
  lang: string | null;
  run: CmdRunner;
  io: TranscribeIO;
  post: ServerPoster;
  timeoutMs?: number;
  onBackend?: (engine: Engine) => void;
}): Promise<string> {
  const d = opts.detection;
  const cliReady = !!(d.ffmpeg && d.binary && d.model);

  if (d.engine === "server" && d.server) {
    try {
      const text = await runServerTranscription({
        url: d.server.url,
        bytes: opts.bytes,
        ext: opts.ext,
        lang: opts.lang,
        post: opts.post,
        timeoutMs: opts.timeoutMs,
      });
      opts.onBackend?.("server");
      return text;
    } catch (e) {
      if (!cliReady)
        throw new ServerUnavailable(
          `whisper server unreachable: ${e instanceof Error ? e.message : String(e)}`,
        );
      // server vanished between detect() and POST but a local CLI is ready — degrade to it.
    }
  }

  if (!cliReady) throw new ServerUnavailable("no transcription engine available");
  opts.onBackend?.("whisper.cpp");
  return runTranscription({
    bytes: opts.bytes,
    ext: opts.ext,
    lang: opts.lang,
    ffmpeg: d.ffmpeg!,
    binary: d.binary!,
    model: d.model!,
    run: opts.run,
    io: opts.io,
    timeoutMs: opts.timeoutMs,
  });
}

// ── self-test (operator "Test transcription" button) ────────────────────────────────

/** Language of a bundled self-test clip (and the `lang` the selftest route accepts). */
export type SelfTestLang = "de" | "en";

/** The bundled self-test clips, one per language — short synthetic sentences generated with
 *  Piper TTS (github.com/OHF-Voice/piper1-gpl; voices: `de_DE-thorsten-medium` with
 *  noise-scale 0.2 / length-scale 1.25, `en_US-lessac-medium`), 16 kHz mono 16-bit WAV:
 *    de: "Schafe. Schafe. Ich sehe nur noch Schafe."
 *    en: "Sheep. Sheep. All I see is sheep."
 *  The Settings-panel Test buttons run them through the SAME `transcribeClip` path the
 *  compose-bar mic uses, so a green result proves real end-to-end speech-to-text. Each clip's
 *  language is pinned regardless of `config.language` — forcing another language would garble a
 *  perfectly healthy engine and mis-report it as broken. */
export const SELFTEST_CLIPS: Record<SelfTestLang, string> = {
  de: "assets/selftest-de.wav",
  en: "assets/selftest-en.wav",
};

/** Resolve a selftest request body to a clip language, TOLERANTLY: `{ lang: "de" }` picks the
 *  German clip; anything else — missing/invalid/non-JSON body (passed here as null) or a `lang`
 *  outside de/en — falls back to "en" instead of erroring, so the route never fails on body shape.
 *  (The panel's action-buttons and the test page send `{ lang: "de" | "en" }` verbatim.) */
export function resolveSelfTestLang(body: unknown): SelfTestLang {
  return (body as { lang?: unknown } | null)?.lang === "de" ? "de" : "en";
}

export interface SelfTestResult {
  /** True only when the engine returned a non-empty transcript. */
  ok: boolean;
  /** Which bundled clip ran (pinned as the transcription language). */
  lang: SelfTestLang;
  /** The backend that ACTUALLY produced the text — not necessarily the one `detect()` selected, since
   *  a server that died since detection degrades to the CLI. null when the run errored before any ran. */
  engine: Engine | null;
  /** The transcript (trimmed; "" when the engine returned nothing or the run errored). */
  text: string;
  /** Wall-clock duration of the round-trip, milliseconds. */
  ms: number;
  /** Set when the run threw (engine unavailable / transcription failure); absent on a clean run. */
  error?: string;
}

/** Run the bundled clip through whatever engine `detect()` chose — the exact `transcribeClip` path the
 *  mic uses — and report the outcome. PASS = a non-empty transcript. A handled failure (engine gone,
 *  transcription error) resolves to `{ ok:false, error }`; it never throws, so the route can always
 *  answer 200 with a crafted message. */
export async function runSelfTest(opts: {
  detection: Detection;
  bytes: Uint8Array;
  /** Which bundled clip is running — pinned as the transcription language. */
  lang: SelfTestLang;
  run: CmdRunner;
  io: TranscribeIO;
  post: ServerPoster;
  timeoutMs?: number;
}): Promise<SelfTestResult> {
  // Report the backend that actually ran, not the one detect() picked — transcribeClip may degrade a
  // dead server to the CLI, and claiming "via server" then would be a lie.
  let engine = opts.detection.engine;
  const t0 = performance.now();
  try {
    const text = (
      await transcribeClip({
        detection: opts.detection,
        bytes: opts.bytes,
        ext: "wav",
        lang: opts.lang,
        run: opts.run,
        io: opts.io,
        post: opts.post,
        timeoutMs: opts.timeoutMs,
        onBackend: (e) => {
          engine = e;
        },
      })
    ).trim();
    return {
      ok: text.length > 0,
      lang: opts.lang,
      engine,
      text,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return {
      ok: false,
      lang: opts.lang,
      engine,
      text: "",
      ms: Math.round(performance.now() - t0),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** One short line for the action-button toast AND the panel's "last test" row. The ✓/✗ glyph carries
 *  the outcome — core renders pass and fail as the same neutral toast (truncated ~200 chars), so the
 *  untruncated panel row is the durable signal. */
export function formatSelfTestResult(r: SelfTestResult): string {
  const eng = engineLabel(r.engine) ?? "engine";
  if (r.error) return `✗ Test failed (${r.lang}) via ${eng}: ${r.error} (${r.ms} ms)`;
  if (!r.ok) return `✗ Test failed (${r.lang}) via ${eng}: engine returned no text (${r.ms} ms)`;
  return `✓ Test OK · ${r.lang} · ${eng} — "${r.text}" (${r.ms} ms)`;
}

// ── real runtime adapters ────────────────────────────────────────────────────────────

const realDetectDeps: DetectDeps = {
  which: (cmd) => Bun.which(cmd),
  exists: async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
  listDir: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  home: () => homedir(),
  probeServer: async (url) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${url}/health`, { signal: ctrl.signal });
        if (!res.ok) return null;
        return acceptHealth(await res.json());
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  },
};

const realServerPost: ServerPoster = async ({ url, bytes, ext, lang, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.append("file", new Blob([buf]), `clip.${ext}`);
    if (lang) form.append("language", lang);
    const res = await fetch(`${url}/transcribe`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    let body: { text?: string; error?: string } = {};
    try {
      body = (await res.json()) as { text?: string; error?: string };
    } catch {
      /* non-JSON error body — leave body empty, status carries the failure */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
};

const realRun: CmdRunner = async (cmd, timeoutMs) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode: exitCode ?? 1, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

const realIO: TranscribeIO = {
  writeTemp: async (bytes, ext) => {
    const dir = await mkdtemp(join(tmpdir(), "shepherd-voice-"));
    const p = join(dir, `clip.${ext}`);
    await writeFile(p, bytes);
    return p;
  },
  wavPathFor: (input) => input.replace(/\.[^./]+$/, "") + ".wav",
  remove: async (p) => {
    // remove the file's parent temp dir (created per-clip by writeTemp) so nothing lingers
    await rm(join(p, ".."), { recursive: true, force: true });
  },
};

// ── plugin entry ─────────────────────────────────────────────────────────────────────

/** Human-readable label for the selected engine (display-only; core gates on `available`). */
function engineLabel(engine: Engine | null): string | null {
  return engine === "server"
    ? "faster-whisper server (whisper-stt)"
    : engine === "whisper.cpp"
      ? "whisper.cpp"
      : null;
}

function statusBody(cfg: ResolvedConfig, d: Detection) {
  return {
    available: d.engine !== null,
    engine: engineLabel(d.engine),
    server: d.server,
    binary: d.binary,
    model: d.engine === "server" ? (d.server?.model ?? null) : d.model,
    ffmpeg: !!d.ffmpeg,
    language: cfg.language,
    preferLocal: cfg.preferLocal,
    hint: d.hint,
  };
}

/** Absolute path of the plugin-served test page (mic recorder + canned self-tests). Kept in one
 *  place because it appears in the gear item, the panel row, and the README. */
export const TEST_PAGE_PATH = "/api/plugins/voice-whisper/test";

export function panelView(
  cfg: ResolvedConfig,
  d: Detection,
  lastTest: SelfTestResult | null,
  /** Which bundled self-test clips loaded — each Test button is only offered when its clip did. */
  testable: Record<SelfTestLang, boolean>,
): PluginUIView {
  const available = d.engine !== null;
  const serverRow = d.server
    ? `✓ ${d.server.url} (model ${d.server.model})`
    : cfg.serverUrl
      ? `✗ not reachable (${cfg.serverUrl})`
      : cfg.serverDiscovery
        ? `✗ none found (probed ${DEFAULT_SERVER_CANDIDATES.join(", ")})`
        : "— disabled";
  const root: PluginUIView["root"] = {
    type: "stack",
    children: [
      {
        type: "key-value",
        props: {
          pairs: [
            { key: "server", value: serverRow },
            { key: "whisper.cpp", value: d.binary ? `✓ ${d.binary}` : "✗ not found" },
            { key: "ffmpeg", value: d.ffmpeg ? `✓ ${d.ffmpeg}` : "✗ not found" },
            { key: "model", value: d.model ? `✓ ${d.model}` : "✗ not found" },
            { key: "engine", value: engineLabel(d.engine) ?? "none" },
            { key: "language", value: cfg.language },
            { key: "prefer local", value: cfg.preferLocal ? "yes" : "no (browser first)" },
            { key: "status", value: available ? "ready" : "not ready" },
            // The mic test page (the panel can't render clickable links; the gear item opens it).
            { key: "test page", value: TEST_PAGE_PATH },
            // The durable, untruncated test signal (the button's toast is neutral + truncated).
            ...(available
              ? [{ key: "last test", value: lastTest ? formatSelfTestResult(lastTest) : "never run" }]
              : []),
          ],
        },
      },
      // Only offer a Test button when an engine is ready AND that language's bundled clip loaded —
      // otherwise a click would only ever report failure. When not ready the callout below explains
      // what's missing.
      ...(available
        ? ([
            ["de", "Test (Deutsch)"],
            ["en", "Test (English)"],
          ] as const)
            .filter(([lang]) => testable[lang])
            .map(
              ([lang, label]) =>
                ({
                  type: "action-button",
                  props: {
                    label,
                    tone: "info",
                    route: { method: "POST", path: "selftest" },
                    body: { lang },
                  },
                }) as const,
            )
        : []),
      ...(available ? [] : [{ type: "callout", props: { tone: "warn", text: d.hint } } as const]),
    ],
  };
  return { schemaVersion: 1, slot: "settings-panel", title: "Local Whisper voice input", root };
}

/** The operator test page served by `GET test` — one page reaching EVERY test: a live mic
 *  recorder (getUserMedia + MediaRecorder → POST `transcribe`, the exact route the compose-bar
 *  mic uses), the two canned self-test buttons (POST `selftest` with `{lang}`), and the engine
 *  status (GET `status`). Fully self-contained (inline CSS/JS, no external resources) because
 *  core sets no CSP but the page must never depend on third-party hosts. All fetches use
 *  RELATIVE paths so they resolve inside this plugin's own `/api/plugins/voice-whisper/`
 *  namespace and ride the operator's same-origin session cookie. getUserMedia additionally
 *  needs a secure context (HTTPS/localhost) — the page explains that instead of failing mute;
 *  the canned buttons work regardless of mic permission. */
export function testPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local Whisper — Test</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  button { font: inherit; padding: .5rem 1rem; border-radius: .5rem; border: 1px solid #8884; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  select { font: inherit; padding: .4rem; border-radius: .5rem; }
  #rec.recording { background: #c0392b; color: #fff; }
  .row { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin: .75rem 0; }
  .out { border: 1px solid #8884; border-radius: .5rem; padding: .75rem; min-height: 2.5rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { opacity: .7; font-size: .9rem; }
  .err { color: #c0392b; }
</style>
</head>
<body>
<h1>🎙️ Local Whisper — Test</h1>
<p class="muted" id="status">Checking engine …</p>

<h2>Speak yourself</h2>
<div class="row">
  <button id="rec" disabled>🎙️ Start recording</button>
  <label>Language
    <select id="lang">
      <option value="">auto</option>
      <option value="de">de</option>
      <option value="en">en</option>
    </select>
  </label>
</div>
<p class="muted" id="mic-state"></p>
<div class="out" id="transcript"></div>
<p class="muted" id="timing"></p>

<h2>Canned self-tests</h2>
<p class="muted">The bundled clips, through the same engine the mic uses.</p>
<div class="row">
  <button data-selftest="de">Test (Deutsch)</button>
  <button data-selftest="en">Test (English)</button>
</div>
<div class="out" id="selftest-out"></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);

  // ── engine status ────────────────────────────────────────────────────────
  fetch("status").then((r) => r.json()).then((s) => {
    $("status").textContent = s.available
      ? "Engine ready: " + s.engine + (s.model ? " (model " + s.model + ")" : "")
      : "Engine not ready — " + (s.hint || "see the plugin panel");
    if (!s.available) $("status").classList.add("err");
  }).catch(() => { $("status").textContent = "Engine status unavailable."; });

  // ── canned self-tests (same POST selftest route as the panel buttons) ───
  for (const btn of document.querySelectorAll("[data-selftest]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      $("selftest-out").textContent = "⏳ running …";
      try {
        const res = await fetch("selftest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang: btn.dataset.selftest }),
        });
        $("selftest-out").textContent = await res.text();
      } catch (e) {
        $("selftest-out").textContent = "✗ request failed: " + e;
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── live mic recorder → POST transcribe (the compose-bar mic's route) ───
  const rec = $("rec");
  const canRecord =
    window.isSecureContext &&
    typeof MediaRecorder !== "undefined" &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!canRecord) {
    $("mic-state").textContent = window.isSecureContext
      ? "Recording unavailable: this browser lacks MediaRecorder/getUserMedia."
      : "Recording needs a secure context — open this page via HTTPS (or localhost).";
    $("mic-state").classList.add("err");
  } else {
    rec.disabled = false;
  }

  // Same container candidates as Shepherd's compose bar (webm first, mp4 for iOS).
  function pickMimeType() {
    for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"])
      if (MediaRecorder.isTypeSupported(c)) return c;
    return undefined;
  }

  let recorder = null;
  let chunks = [];

  async function transcribe(blob) {
    $("mic-state").textContent = "Transcribing …";
    $("transcript").textContent = "";
    $("timing").textContent = "";
    const form = new FormData();
    form.append("file", blob, "clip");
    const lang = $("lang").value;
    if (lang) form.append("lang", lang);
    const t0 = performance.now();
    try {
      const res = await fetch("transcribe", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) {
        $("mic-state").textContent = "";
        $("transcript").textContent =
          "✗ " + (body.error || "HTTP " + res.status) + (body.hint ? " — " + body.hint : "");
        $("transcript").classList.add("err");
        return;
      }
      $("mic-state").textContent = "";
      $("transcript").classList.remove("err");
      $("transcript").textContent = body.text || "(empty transcript)";
      $("timing").textContent = ms + " ms round-trip";
    } catch (e) {
      $("mic-state").textContent = "";
      $("transcript").textContent = "✗ request failed: " + e;
      $("transcript").classList.add("err");
    }
  }

  rec.addEventListener("click", async () => {
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $("mic-state").textContent = "✗ microphone permission denied: " + e;
      $("mic-state").classList.add("err");
      return;
    }
    chunks = [];
    const mime = pickMimeType();
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((t) => t.stop());
      rec.textContent = "🎙️ Start recording";
      rec.classList.remove("recording");
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size) transcribe(blob);
      else $("mic-state").textContent = "Nothing recorded.";
    });
    recorder.start();
    rec.textContent = "⏹ Stop";
    rec.classList.add("recording");
    $("mic-state").textContent = "Recording … speak now, then press Stop.";
    $("mic-state").classList.remove("err");
  });
})();
</script>
</body>
</html>
`;
}

export async function register(ctx: PluginContext): Promise<() => void> {
  const cfg = readConfig(ctx.config);
  ctx.log.log(
    `registering — language=${cfg.language} preferLocal=${cfg.preferLocal} modelSize=${cfg.modelSize} maxConcurrent=${cfg.maxConcurrent}`,
  );

  // Bound concurrent whisper/ffmpeg subprocesses: the compose-bar live preview fires a fresh
  // transcription every couple of seconds while dictating, so several tabs/sessions could otherwise
  // stack unbounded whole-clip transcriptions on the host. A shed request gets 429 — the browser's
  // interim loop silently skips that tick and retries on the next one.
  const gate = makeGate(cfg.maxConcurrent);

  // Load the bundled self-test clips once at boot. A broken install (asset missing) must not crash
  // load — we just log and withhold that language's Test button (panelView's `testable` record).
  const selfTestClips: Record<SelfTestLang, Uint8Array | null> = { de: null, en: null };
  for (const lang of ["de", "en"] as const) {
    try {
      selfTestClips[lang] = new Uint8Array(
        await readFile(join(import.meta.dir, SELFTEST_CLIPS[lang])),
      );
    } catch (e) {
      ctx.log.warn(
        `self-test clip missing (${SELFTEST_CLIPS[lang]}) — Test (${lang}) button disabled: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const testable = (): Record<SelfTestLang, boolean> => ({
    de: selfTestClips.de !== null,
    en: selfTestClips.en !== null,
  });

  // Most recent self-test outcome, surfaced in the panel's "last test" row. In-memory only: resets to
  // "never run" on restart (deliberately simple — the operator just re-runs the test).
  let lastTest: SelfTestResult | null = null;

  const refreshPanel = async (): Promise<Detection> => {
    const d = await detect(cfg, realDetectDeps);
    ctx.publishStatus(statusBody(cfg, d));
    if (typeof ctx.publishUI === "function")
      ctx.publishUI(panelView(cfg, d, lastTest, testable()));
    return d;
  };

  // GET status — the core UI memoizes this to decide whether to show/prefer the local mic.
  ctx.route("GET", "status", async () => {
    const d = await detect(cfg, realDetectDeps);
    return Response.json(statusBody(cfg, d));
  });

  // POST transcribe — multipart `file` (+ optional `lang`) → { text }. Re-detects each call so
  // dropping a model in after boot works without a restart.
  ctx.route("POST", "transcribe", async (req) => {
    // Reject oversized clips BEFORE ingesting the body: check Content-Length first so a huge
    // upload is refused without buffering it (Bun.serve's default body limit won't protect us).
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > cfg.maxBytes)
      return Response.json({ error: "clip too large" }, { status: 413 });

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File))
      return Response.json({ error: "missing file field" }, { status: 400 });
    // Authoritative cap on the actual received bytes (Content-Length may be absent/wrong).
    if (file.size > cfg.maxBytes)
      return Response.json({ error: "clip too large" }, { status: 413 });

    const d = await detect(cfg, realDetectDeps);
    if (!d.engine)
      return Response.json({ error: "voice engine not ready", hint: d.hint }, { status: 503 });

    const langField = form?.get("lang");
    const lang = resolveLang(cfg, typeof langField === "string" ? langField : null);
    // Shed rather than pile on when the host is already at capacity. A disposable `mode=partial`
    // live-preview request leaves a slot reserved for the final clip, so previews can never
    // 429-starve the transcription the user actually keeps; absent/other `mode` ⇒ treated as final.
    const reserved = form?.get("mode") === "partial" ? RESERVED_FOR_FINAL : 0;
    if (!gate.tryEnter(reserved)) return Response.json({ error: "busy" }, { status: 429 });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await transcribeClip({
        detection: d,
        bytes,
        ext: extForMime(file.type),
        lang,
        run: realRun,
        io: realIO,
        post: realServerPost,
      });
      return Response.json({ text });
    } catch (e) {
      // Server chosen at detect() but gone at POST, with no CLI fallback → 503 (not ready), not 500.
      if (e instanceof ServerUnavailable)
        return Response.json({ error: "voice engine not ready", hint: d.hint }, { status: 503 });
      ctx.log.warn(`transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
      return Response.json({ error: "transcription failed" }, { status: 500 });
    } finally {
      gate.leave();
    }
  });

  // POST selftest — the panel's / test page's "Test (Deutsch)/(English)" buttons. Runs the bundled
  // clip for the requested language through the live engine to prove real end-to-end STT. The JSON
  // body `{ lang: "de" | "en" }` is parsed TOLERANTLY: a missing/invalid/non-JSON body (or a lang
  // outside de/en) falls back to "en" instead of erroring, so the route never fails on body shape.
  // EVERY handled outcome returns HTTP 200 with a plain-text ✓/✗/⏳ body: core's action-button
  // throws on any non-2xx and then shows a FIXED generic "failed" toast, discarding our crafted
  // message — so we must answer 200 even for failures.
  ctx.route("POST", "selftest", async (req) => {
    const lang = resolveSelfTestLang(await req.json().catch(() => null));
    const d = await detect(cfg, realDetectDeps);
    if (!d.engine) {
      if (typeof ctx.publishUI === "function")
        ctx.publishUI(panelView(cfg, d, lastTest, testable()));
      return new Response(`✗ engine not ready — ${d.hint}`, { status: 200 });
    }
    const clip = selfTestClips[lang];
    if (!clip)
      return new Response(
        `✗ Test unavailable — the bundled ${lang} test clip is missing from this install.`,
        { status: 200 },
      );
    // Share the transcribe gate so a test never exceeds maxConcurrent alongside live dictation.
    if (!gate.tryEnter(0))
      return new Response("⏳ busy — an engine is transcribing, try again in a moment.", {
        status: 200,
      });
    try {
      lastTest = await runSelfTest({
        detection: d,
        bytes: clip,
        lang,
        run: realRun,
        io: realIO,
        post: realServerPost,
      });
      if (typeof ctx.publishUI === "function")
        ctx.publishUI(panelView(cfg, d, lastTest, testable()));
      return new Response(formatSelfTestResult(lastTest), { status: 200 });
    } finally {
      gate.leave();
    }
  });

  // GET test — the operator test page: a self-contained HTML page (inline CSS/JS, no external
  // resources) bundling EVERY test in one place: a live mic recorder posting to `transcribe`
  // (the exact path the compose-bar mic uses), the two canned self-test buttons, and the engine
  // status. Served under the plugin's operator-auth'd namespace, so an already-logged-in browser
  // opens it directly; the explicit Content-Type makes it render inline (core passes plugin
  // response headers through verbatim).
  ctx.route("GET", "test", async () => {
    return new Response(testPageHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  await refreshPanel();

  // One click reaches EVERY test: the page hosts the mic recorder AND the canned self-test
  // buttons AND the engine status. The settings panel keeps its own buttons and stays reachable
  // via Settings → Plugins (a plugin gets at most ONE gear item).
  if (typeof ctx.publishGearItem === "function") {
    ctx.publishGearItem({
      label: "Voice input (Whisper) — test",
      icon: "🎙️",
      action: { kind: "url", href: TEST_PAGE_PATH },
    });
  }

  return () => ctx.log.log("torn down");
}
