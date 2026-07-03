import { test, expect } from "bun:test";
import {
  extForMime,
  resolveFfmpegArgs,
  resolveWhisperArgs,
  parseTranscript,
  resolveLang,
  detect,
  readConfig,
  acceptHealth,
  DEFAULT_SERVER_CANDIDATES,
  runTranscription,
  runServerTranscription,
  transcribeClip,
  ServerUnavailable,
  type ResolvedConfig,
  type Detection,
  type DetectDeps,
  type CmdResult,
  type ServerPoster,
  type TranscribeIO,
} from "./index";

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    binaryPath: null,
    model: null,
    modelSize: "small",
    ffmpegPath: null,
    serverUrl: null,
    serverDiscovery: false,
    language: "auto",
    preferLocal: false,
    maxBytes: 25 * 1024 * 1024,
    ...over,
  };
}

test("extForMime maps MediaRecorder MIME types and strips codecs", () => {
  expect(extForMime("audio/webm;codecs=opus")).toBe("webm");
  expect(extForMime("audio/mp4")).toBe("mp4");
  expect(extForMime("audio/ogg")).toBe("ogg");
  expect(extForMime("audio/wav")).toBe("wav");
  expect(extForMime("")).toBe("webm"); // sensible fallback
});

test("resolveFfmpegArgs converts a seekable input FILE to 16kHz mono WAV (no pipe)", () => {
  const args = resolveFfmpegArgs("/usr/bin/ffmpeg", "/tmp/clip.mp4", "/tmp/clip.wav");
  expect(args[0]).toBe("/usr/bin/ffmpeg");
  expect(args).toContain("-i");
  expect(args).toContain("/tmp/clip.mp4");
  expect(args).toContain("/tmp/clip.wav");
  expect(args).toEqual(expect.arrayContaining(["-ar", "16000", "-ac", "1"]));
  // never reads from a non-seekable pipe (would break iOS mp4 moov-atom demux)
  expect(args).not.toContain("pipe:0");
});

test("resolveWhisperArgs reads a WAV FILE with -f/-m/-nt and pins -l only when known", () => {
  const withLang = resolveWhisperArgs(
    "/opt/whisper-cli",
    "/models/ggml-small.bin",
    "/tmp/c.wav",
    "de",
  );
  expect(withLang).toEqual([
    "/opt/whisper-cli",
    "-m",
    "/models/ggml-small.bin",
    "-f",
    "/tmp/c.wav",
    "-nt",
    "-l",
    "de",
  ]);
  const noLang = resolveWhisperArgs("/opt/whisper-cli", "/m.bin", "/tmp/c.wav", null);
  expect(noLang).not.toContain("-l");
});

test("parseTranscript collapses whisper stdout lines", () => {
  expect(parseTranscript("\n  Hallo Welt \n  wie geht es \n")).toBe("Hallo Welt wie geht es");
  expect(parseTranscript("")).toBe("");
});

test("resolveLang: config override wins, else request locale, else null", () => {
  expect(resolveLang(cfg({ language: "de" }), "en")).toBe("de");
  expect(resolveLang(cfg({ language: "auto" }), "en")).toBe("en");
  expect(resolveLang(cfg({ language: "auto" }), "fr")).toBe(null);
  expect(resolveLang(cfg({ language: "auto" }), null)).toBe(null);
});

function detectDeps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    which: () => null,
    exists: async () => false,
    listDir: async () => [],
    home: () => "/home/me",
    probeServer: async () => null,
    ...over,
  };
}

test("detect resolves ffmpeg + whisper.cpp on PATH and scans ~/.shepherd/whisper for a model", async () => {
  const d = await detect(
    cfg(),
    detectDeps({
      which: (c) =>
        c === "ffmpeg" ? "/usr/bin/ffmpeg" : c === "whisper-cli" ? "/usr/bin/whisper-cli" : null,
      listDir: async (dir) =>
        dir === "/home/me/.shepherd/whisper" ? ["ggml-base.bin", "ggml-small.bin"] : [],
    }),
  );
  expect(d.ffmpeg).toBe("/usr/bin/ffmpeg");
  expect(d.binary).toBe("/usr/bin/whisper-cli");
  expect(d.model).toBe("/home/me/.shepherd/whisper/ggml-small.bin"); // prefers the configured size
  expect(d.hint).toBe("");
});

test("detect prefers whisper-cli over whisper-cpp, honors binaryPath, and misses when absent", async () => {
  const both = await detect(
    cfg(),
    detectDeps({ which: (c) => (c === "whisper-cli" || c === "whisper-cpp" ? `/bin/${c}` : null) }),
  );
  expect(both.binary).toBe("/bin/whisper-cli");

  const configured = await detect(
    cfg({ binaryPath: "/custom/whisper" }),
    detectDeps({ exists: async (p) => p === "/custom/whisper" }),
  );
  expect(configured.binary).toBe("/custom/whisper");

  const configuredMissing = await detect(cfg({ binaryPath: "/gone/whisper" }), detectDeps());
  expect(configuredMissing.binary).toBe(null);
});

test("detect emits an actionable model-download hint pointing at ~/.shepherd/whisper", async () => {
  const d = await detect(
    cfg(),
    detectDeps({
      which: (c) => (c === "ffmpeg" ? "/usr/bin/ffmpeg" : c === "whisper-cli" ? "/w" : null),
    }),
  );
  expect(d.model).toBe(null);
  expect(d.hint).toContain("/home/me/.shepherd/whisper");
  expect(d.hint).toContain("ggml-small.bin");
});

// A mocked runner + IO so we assert the file-based argv AND the temp-file cleanup with no
// real ffmpeg/whisper/fs. Every run() call records its argv; io tracks writes and removes.
function harness(runImpl: (cmd: string[]) => CmdResult) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const run = async (cmd: string[]): Promise<CmdResult> => {
    calls.push(cmd);
    return runImpl(cmd);
  };
  const io: TranscribeIO = {
    writeTemp: async (_bytes, ext) => `/tmp/clip.${ext}`,
    wavPathFor: (input) => input.replace(/\.[^./]+$/, "") + ".wav",
    remove: async (p) => {
      removed.push(p);
    },
  };
  return { calls, removed, run, io };
}

test("runTranscription: ffmpeg then whisper over temp files, returns text, cleans up both", async () => {
  const h = harness((cmd) =>
    cmd[0] === "/ff"
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 0, stdout: "transcribed text\n", stderr: "" },
  );
  const text = await runTranscription({
    bytes: new Uint8Array([1, 2, 3]),
    ext: "mp4",
    lang: "de",
    ffmpeg: "/ff",
    binary: "/wc",
    model: "/m.bin",
    run: h.run,
    io: h.io,
  });

  expect(text).toBe("transcribed text");
  expect(h.calls.length).toBe(2);
  // stage 1 = ffmpeg reading the written temp input file → temp wav
  expect(h.calls[0]![0]).toBe("/ff");
  expect(h.calls[0]).toContain("/tmp/clip.mp4");
  expect(h.calls[0]).toContain("/tmp/clip.wav");
  // stage 2 = whisper reading the temp wav
  expect(h.calls[1]![0]).toBe("/wc");
  expect(h.calls[1]).toEqual(expect.arrayContaining(["-f", "/tmp/clip.wav", "-l", "de"]));
  // both temp files removed
  expect(h.removed).toContain("/tmp/clip.mp4");
  expect(h.removed).toContain("/tmp/clip.wav");
});

test("runTranscription: ffmpeg failure throws AND still cleans up temp files", async () => {
  const h = harness(() => ({ exitCode: 1, stdout: "", stderr: "boom" }));
  await expect(
    runTranscription({
      bytes: new Uint8Array([1]),
      ext: "webm",
      lang: null,
      ffmpeg: "/ff",
      binary: "/wc",
      model: "/m.bin",
      run: h.run,
      io: h.io,
    }),
  ).rejects.toThrow(/ffmpeg exited 1/);
  expect(h.calls.length).toBe(1); // whisper never ran
  expect(h.removed).toContain("/tmp/clip.webm");
  expect(h.removed).toContain("/tmp/clip.wav");
});

// ── faster-whisper server backend ────────────────────────────────────────────────────

test("readConfig serverUrl: non-empty sets explicit URL (trailing slash stripped); absent/empty → null", () => {
  expect(readConfig({}).serverUrl).toBe(null);
  expect(readConfig({ serverUrl: "" }).serverUrl).toBe(null);
  expect(readConfig({ serverUrl: "http://127.0.0.1:9876/" }).serverUrl).toBe("http://127.0.0.1:9876");
  expect(readConfig({ serverUrl: "http://127.0.0.1:9876" }).serverUrl).toBe("http://127.0.0.1:9876");
});

test("readConfig serverDiscovery defaults on, only false turns it off", () => {
  expect(readConfig({}).serverDiscovery).toBe(true);
  expect(readConfig({ serverDiscovery: true }).serverDiscovery).toBe(true);
  expect(readConfig({ serverDiscovery: false }).serverDiscovery).toBe(false);
});

test("acceptHealth trusts only ready:true + a plausible non-empty model", () => {
  expect(acceptHealth({ status: "ok", ready: true, model: "medium" })).toEqual({ model: "medium" });
  expect(acceptHealth({ status: "ok", ready: false, model: "medium" })).toBe(null); // not ready
  expect(acceptHealth({ status: "ok", ready: true, model: "" })).toBe(null); // blank model
  expect(acceptHealth({ status: "ok", ready: true })).toBe(null); // no model field
  expect(acceptHealth({ status: "ok" })).toBe(null); // some unrelated /health
  expect(acceptHealth(null)).toBe(null);
});

test("detect: an explicit serverUrl is the only URL probed and wins over a ready CLI", async () => {
  const probed: string[] = [];
  const readyCli = detectDeps({
    which: (c) => (c === "ffmpeg" ? "/ff" : c === "whisper-cli" ? "/wc" : null),
    listDir: async (dir) => (dir === "/home/me/.shepherd/whisper" ? ["ggml-small.bin"] : []),
    probeServer: async (url) => {
      probed.push(url);
      return { model: "medium" };
    },
  });
  const d = await detect(cfg({ serverUrl: "http://s:9876" }), readyCli);
  expect(probed).toEqual(["http://s:9876"]); // NOT the discovery candidates
  expect(d.engine).toBe("server");
  expect(d.server).toEqual({ url: "http://s:9876", model: "medium" });
  expect(d.hint).toBe("");
});

test("detect: discovery probes the localhost candidates and adopts a healthy one", async () => {
  const probed: string[] = [];
  const d = await detect(
    cfg({ serverDiscovery: true }), // no serverUrl → discover
    detectDeps({
      probeServer: async (url) => {
        probed.push(url);
        return { model: "medium" };
      },
    }),
  );
  expect(probed).toEqual(DEFAULT_SERVER_CANDIDATES);
  expect(d.engine).toBe("server");
  expect(d.server).toEqual({ url: DEFAULT_SERVER_CANDIDATES[0]!, model: "medium" });
});

test("detect: discovery disabled (and no serverUrl) never probes → CLI", async () => {
  const probed: string[] = [];
  const d = await detect(
    cfg({ serverDiscovery: false }),
    detectDeps({
      which: (c) => (c === "ffmpeg" ? "/ff" : c === "whisper-cli" ? "/wc" : null),
      listDir: async () => ["ggml-small.bin"],
      probeServer: async (url) => {
        probed.push(url);
        return { model: "medium" };
      },
    }),
  );
  expect(probed).toEqual([]);
  expect(d.engine).toBe("whisper.cpp");
});

test("detect falls back to the CLI when the server is unreachable/rejected", async () => {
  const d = await detect(
    cfg({ serverUrl: "http://s:9876" }),
    detectDeps({
      which: (c) => (c === "ffmpeg" ? "/ff" : c === "whisper-cli" ? "/wc" : null),
      listDir: async () => ["ggml-small.bin"],
      probeServer: async () => null, // not reachable / rejected by strict /health
    }),
  );
  expect(d.engine).toBe("whisper.cpp");
  expect(d.server).toBe(null);
});

test("detect: no server + no CLI → engine null with a hint that mentions serverUrl", async () => {
  const d = await detect(cfg(), detectDeps());
  expect(d.engine).toBe(null);
  expect(d.hint).toContain("serverUrl");
});

test("runServerTranscription returns trimmed text; throws on non-2xx and on missing text", async () => {
  const ok: ServerPoster = async () => ({ status: 200, body: { text: "  hallo welt \n" } });
  expect(
    await runServerTranscription({ url: "http://s", bytes: new Uint8Array([1]), ext: "webm", lang: "de", post: ok }),
  ).toBe("hallo welt");

  const err: ServerPoster = async () => ({ status: 500, body: { error: "boom" } });
  await expect(
    runServerTranscription({ url: "http://s", bytes: new Uint8Array([1]), ext: "webm", lang: null, post: err }),
  ).rejects.toThrow(/500/);

  const empty: ServerPoster = async () => ({ status: 200, body: {} });
  await expect(
    runServerTranscription({ url: "http://s", bytes: new Uint8Array([1]), ext: "webm", lang: null, post: empty }),
  ).rejects.toThrow(/no text/);
});

// The race the plan calls out: server chosen at detect() but gone at POST.
function serverDetection(over: Partial<Detection> = {}): Detection {
  return {
    engine: "server",
    server: { url: "http://s:9876", model: "medium" },
    ffmpeg: null,
    binary: null,
    model: null,
    hint: "",
    ...over,
  };
}

test("transcribeClip: server down at POST degrades to the CLI when it is ready", async () => {
  const h = harness((cmd) =>
    cmd[0] === "/ff"
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 0, stdout: "fallback text\n", stderr: "" },
  );
  const throwingPost: ServerPoster = async () => {
    throw new Error("ECONNREFUSED");
  };
  // server engine, but the CLI is also ready → fall back to it, not a 503/500.
  const text = await transcribeClip({
    detection: serverDetection({ ffmpeg: "/ff", binary: "/wc", model: "/m.bin" }),
    bytes: new Uint8Array([1, 2]),
    ext: "webm",
    lang: null,
    run: h.run,
    io: h.io,
    post: throwingPost,
  });
  expect(text).toBe("fallback text");
  expect(h.calls[0]![0]).toBe("/ff"); // CLI pipeline actually ran
});

test("transcribeClip: server down at POST with no CLI throws ServerUnavailable (→ 503, not 500)", async () => {
  const h = harness(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  const throwingPost: ServerPoster = async () => {
    throw new Error("ECONNREFUSED");
  };
  await expect(
    transcribeClip({
      detection: serverDetection(), // no ffmpeg/binary/model
      bytes: new Uint8Array([1]),
      ext: "webm",
      lang: null,
      run: h.run,
      io: h.io,
      post: throwingPost,
    }),
  ).rejects.toBeInstanceOf(ServerUnavailable);
  expect(h.calls.length).toBe(0); // never touched the CLI
});

test("transcribeClip: happy server path returns the server's text without touching the CLI", async () => {
  const h = harness(() => ({ exitCode: 0, stdout: "should not run", stderr: "" }));
  const post: ServerPoster = async () => ({ status: 200, body: { text: "server text" } });
  const text = await transcribeClip({
    detection: serverDetection({ ffmpeg: "/ff", binary: "/wc", model: "/m.bin" }),
    bytes: new Uint8Array([1]),
    ext: "webm",
    lang: "de",
    run: h.run,
    io: h.io,
    post,
  });
  expect(text).toBe("server text");
  expect(h.calls.length).toBe(0);
});
