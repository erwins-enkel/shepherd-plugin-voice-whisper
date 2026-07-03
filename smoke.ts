// Standalone smoke test for the voice-whisper pipeline — no herdr, no auth, no browser.
// Exercises the SAME code the plugin route uses (detect + runTranscription) against your
// real ffmpeg + whisper.cpp + model, so you can confirm the engine works in isolation.
//
//   bun run examples/plugins/voice-whisper/smoke.ts <audio-file> [de|en]
//
// Overrides (else auto-detected like the plugin does):
//   WHISPER_BIN=/path/to/whisper-cli  WHISPER_MODEL=/path/to/ggml-small.bin  FFMPEG_BIN=/path/to/ffmpeg
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detect,
  runTranscription,
  extForMime,
  type CmdResult,
  type TranscribeIO,
} from "./index";

const run = (cmd: string[]): Promise<CmdResult> =>
  new Promise((resolve) => {
    const p = spawn(cmd[0]!, cmd.slice(1));
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

const io: TranscribeIO = {
  writeTemp: async (bytes, ext) => {
    const dir = await mkdtemp(join(tmpdir(), "voice-smoke-"));
    const path = join(dir, `clip.${ext}`);
    await writeFile(path, bytes);
    return path;
  },
  wavPathFor: (input) => input.replace(/\.[^./]+$/, "") + ".wav",
  remove: (p) => rm(join(p, ".."), { recursive: true, force: true }),
};

const file = process.argv[2];
if (!file) {
  console.error("usage: bun run smoke.ts <audio-file> [de|en]");
  process.exit(2);
}
const lang = process.argv[3] === "de" ? "de" : process.argv[3] === "en" ? "en" : null;

const cfg = {
  binaryPath: process.env.WHISPER_BIN ?? null,
  model: process.env.WHISPER_MODEL ?? null,
  modelSize: "small",
  ffmpegPath: process.env.FFMPEG_BIN ?? null,
  language: "auto" as const,
  preferLocal: false,
  maxBytes: 100 * 1024 * 1024,
};

const d = await detect(cfg, {
  which: (c) => Bun.which(c),
  exists: async (p) => {
    try {
      await readFile(p);
      return true;
    } catch {
      return false;
    }
  },
  listDir: async () => [],
  home: () => process.env.HOME ?? "",
});
console.log("detected:", JSON.stringify(d, null, 2));
if (!d.ffmpeg || !d.binary || !d.model) {
  console.error("\n✗ engine not ready — set WHISPER_BIN / WHISPER_MODEL (see hint above).");
  process.exit(1);
}

const bytes = new Uint8Array(await readFile(file));
const ext = extForMime(`audio/${file.split(".").pop()}`);
const t0 = performance.now();
const text = await runTranscription({
  bytes,
  ext,
  lang,
  ffmpeg: d.ffmpeg,
  binary: d.binary,
  model: d.model,
  run,
  io,
});
console.log(`\n✓ transcript (${Math.round(performance.now() - t0)} ms):\n${text}`);
