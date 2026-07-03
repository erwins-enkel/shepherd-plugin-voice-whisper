import { test, expect } from "bun:test";
import {
  extForMime,
  resolveFfmpegArgs,
  resolveWhisperArgs,
  parseTranscript,
  resolveLang,
  detect,
  runTranscription,
  type ResolvedConfig,
  type DetectDeps,
  type CmdResult,
  type TranscribeIO,
} from "./index";

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    binaryPath: null,
    model: null,
    modelSize: "small",
    ffmpegPath: null,
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
