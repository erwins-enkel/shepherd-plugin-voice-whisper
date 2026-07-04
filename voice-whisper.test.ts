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
  makeGate,
  runSelfTest,
  formatSelfTestResult,
  panelView,
  type ResolvedConfig,
  type Detection,
  type DetectDeps,
  type CmdResult,
  type ServerPoster,
  type TranscribeIO,
  type SelfTestResult,
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
    maxConcurrent: 3,
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

test("makeGate admits up to max concurrent holders, then sheds", () => {
  const gate = makeGate(2);
  expect(gate.tryEnter()).toBe(true);
  expect(gate.tryEnter()).toBe(true);
  expect(gate.inFlight).toBe(2);
  expect(gate.tryEnter()).toBe(false); // full → shed
  expect(gate.inFlight).toBe(2);
});

test("makeGate frees a slot on leave and never underflows", () => {
  const gate = makeGate(1);
  expect(gate.tryEnter()).toBe(true);
  expect(gate.tryEnter()).toBe(false);
  gate.leave();
  expect(gate.inFlight).toBe(0);
  gate.leave(); // extra leave is a no-op, not negative
  expect(gate.inFlight).toBe(0);
  expect(gate.tryEnter()).toBe(true); // slot reusable again
});

test("makeGate reserves slots so low-priority callers never starve a high-priority one", () => {
  const gate = makeGate(3);
  // disposable preview requests (reserved=1) fill only up to max-1…
  expect(gate.tryEnter(1)).toBe(true);
  expect(gate.tryEnter(1)).toBe(true);
  expect(gate.inFlight).toBe(2);
  expect(gate.tryEnter(1)).toBe(false); // last slot is held back for the final
  // …and the final (reserved=0) always gets that reserved slot.
  expect(gate.tryEnter(0)).toBe(true);
  expect(gate.inFlight).toBe(3);
});

// ── self-test (the operator "Test transcription" button) ─────────────────────────────

function cliDetection(over: Partial<Detection> = {}): Detection {
  return {
    engine: "whisper.cpp",
    server: null,
    ffmpeg: "/ff",
    binary: "/wc",
    model: "/m.bin",
    hint: "",
    ...over,
  };
}

test("runSelfTest: server path returns ok with the transcript, engine and timing", async () => {
  const post: ServerPoster = async () => ({
    status: 200,
    body: { text: "  And so, my fellow Americans. \n" },
  });
  const h = harness(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  const r = await runSelfTest({
    detection: serverDetection(),
    bytes: new Uint8Array([1, 2, 3]),
    run: h.run,
    io: h.io,
    post,
  });
  expect(r.ok).toBe(true);
  expect(r.engine).toBe("server");
  expect(r.text).toBe("And so, my fellow Americans."); // trimmed
  expect(r.error).toBeUndefined();
  expect(typeof r.ms).toBe("number");
  expect(r.ms).toBeGreaterThanOrEqual(0);
  expect(h.calls.length).toBe(0); // server path never touches the CLI
});

test("runSelfTest: CLI path transcribes the bundled clip as wav pinned to en", async () => {
  const h = harness((cmd) =>
    cmd[0] === "/ff"
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 0, stdout: "and so my fellow americans\n", stderr: "" },
  );
  const post: ServerPoster = async () => {
    throw new Error("server should not be called on the CLI path");
  };
  const r = await runSelfTest({
    detection: cliDetection(),
    bytes: new Uint8Array([1, 2, 3]),
    run: h.run,
    io: h.io,
    post,
  });
  expect(r.ok).toBe(true);
  expect(r.engine).toBe("whisper.cpp");
  expect(r.text).toBe("and so my fellow americans");
  // ffmpeg wrote a .wav and whisper was pinned to the clip's language (en)
  const whisperCall = h.calls.find((c) => c[0] === "/wc")!;
  expect(whisperCall).toContain("-l");
  expect(whisperCall[whisperCall.indexOf("-l") + 1]).toBe("en");
});

test("runSelfTest: empty transcript is a handled failure (ok:false, no error)", async () => {
  const post: ServerPoster = async () => ({ status: 200, body: { text: "   " } });
  const h = harness(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  const r = await runSelfTest({
    detection: serverDetection(),
    bytes: new Uint8Array([1]),
    run: h.run,
    io: h.io,
    post,
  });
  expect(r.ok).toBe(false);
  expect(r.text).toBe("");
  expect(r.error).toBeUndefined();
});

test("runSelfTest: engine failure is caught, never throws (ok:false with error)", async () => {
  // server chosen but unreachable at POST, and no CLI fallback → transcribeClip throws → caught here
  const post: ServerPoster = async () => {
    throw new Error("connection refused");
  };
  const h = harness(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  const r = await runSelfTest({
    detection: serverDetection(), // no ffmpeg/binary/model → no fallback
    bytes: new Uint8Array([1]),
    run: h.run,
    io: h.io,
    post,
  });
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
  expect(r.engine).toBe("server");
});

test("formatSelfTestResult: success, empty, and error each render distinctly", () => {
  const base: SelfTestResult = { ok: true, engine: "server", text: "hello there", ms: 840 };
  expect(formatSelfTestResult(base)).toBe(
    '✓ Test OK · faster-whisper server (whisper-stt) — "hello there" (840 ms)',
  );
  expect(formatSelfTestResult({ ...base, ok: false, text: "" })).toMatch(
    /^✗ Test failed .*no text \(840 ms\)$/,
  );
  expect(formatSelfTestResult({ ...base, ok: false, text: "", error: "boom" })).toMatch(
    /^✗ Test failed .*boom \(840 ms\)$/,
  );
});

function findNode(view: ReturnType<typeof panelView>, type: string) {
  return (view.root.children ?? []).find((n) => n.type === type);
}

test("panelView: offers the Test button only when an engine is ready and the clip loaded", () => {
  const ready = panelView(cfg(), serverDetection(), null, true);
  const btn = findNode(ready, "action-button");
  expect(btn).toBeDefined();
  expect(btn!.props?.route).toEqual({ method: "POST", path: "selftest" });
  expect(btn!.props?.label).toBe("Test transcription");

  // not ready → no button (the missing-piece callout is shown instead)
  const notReady = panelView(cfg(), serverDetection({ engine: null, server: null }), null, true);
  expect(findNode(notReady, "action-button")).toBeUndefined();
  expect(findNode(notReady, "callout")).toBeDefined();

  // ready but clip failed to load → no button
  const noClip = panelView(cfg(), serverDetection(), null, false);
  expect(findNode(noClip, "action-button")).toBeUndefined();
});

test("panelView: 'last test' row reflects the most recent result", () => {
  const never = panelView(cfg(), serverDetection(), null, true);
  const pairs0 = findNode(never, "key-value")!.props!.pairs as { key: string; value: string }[];
  expect(pairs0.find((p) => p.key === "last test")!.value).toBe("never run");

  const done = panelView(
    cfg(),
    serverDetection(),
    { ok: true, engine: "server", text: "hello", ms: 12 },
    true,
  );
  const pairs1 = findNode(done, "key-value")!.props!.pairs as { key: string; value: string }[];
  expect(pairs1.find((p) => p.key === "last test")!.value).toContain('"hello"');
});
