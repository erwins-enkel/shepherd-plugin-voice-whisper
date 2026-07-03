# shepherd-plugin-voice-whisper

The **local Whisper transcription backend** for [Shepherd](https://github.com/erwins-enkel/shepherd)'s
compose-bar voice input (Shepherd issue #76). It records nothing itself — Shepherd's compose bar
captures the audio in the browser and POSTs it here. Two backends, picked automatically:

1. **faster-whisper HTTP server** — **auto-discovered on `localhost`** (probes
   `http://127.0.0.1:9876`, the `whisper-stt` server.py default). When one is found the clip is
   forwarded to it (it decodes the audio and keeps the model warm, so **no local ffmpeg or model
   file is needed**). Preferred over the CLI. Point `serverUrl` at a specific/remote server to skip
   discovery, or set `serverDiscovery: false` to turn probing off.
2. **whisper.cpp CLI** (fallback) — the clip is converted with **ffmpeg** and transcribed by the
   whisper.cpp CLI on the host.

**Privacy:** the CLI backend and localhost discovery keep everything on your machine — discovery only
ever probes `localhost` and only trusts a service that passes the strict `/health` contract, so audio
is never sent to an unrelated service. ⚠️ The **only** way audio leaves the box is an explicit
`serverUrl` pointing at a **non-localhost** host — do that only if you trust that server.

> **Server backend scope.** The `serverUrl` backend speaks one specific contract — `GET /health`
> (`{"ready":true,"model":"…"}`) and `POST /transcribe` (multipart `file`, returns `{ "text": … }`),
> as served by the `whisper-stt` `server.py`. It is **not** the OpenAI-compatible
> `faster-whisper-server`/speaches `POST /v1/audio/transcriptions`, nor whisper.cpp's `whisper-server`
> `POST /inference`. Point `serverUrl` at a server that speaks the `/health` + `/transcribe` contract.

> **Why the feature spans two repos.** Shepherd's plugin system is server-side and in-process — a
> plugin can't run browser JS (`getUserMedia` / `MediaRecorder`) or add a button to the compose bar.
> So audio **capture** lives in Shepherd's core UI (which calls `/api/plugins/voice-whisper/transcribe`),
> and this repo is the **transcription engine**. On an iOS home-screen PWA — where the browser's Web
> Speech API is unavailable — this is the **only** way to get a mic at all.
>
> Requires a Shepherd build that includes the compose-bar voice hook (Shepherd #76). Without it the
> routes still work, but nothing calls them.

## Prerequisites

**Server backend:** just a running faster-whisper server on the herdr host — it is
**auto-discovered on `localhost:9876`** (or point `serverUrl` at another one). No ffmpeg, model, or
CLI needed on the herdr host. Skip the three items below if you use it.

**CLI backend** — three things on the host that runs herdr:

1. **ffmpeg** on `PATH` — `brew install ffmpeg` / `apt install ffmpeg` / `pacman -S ffmpeg`.
2. **whisper.cpp CLI** on `PATH` — `brew install whisper-cpp` (Homebrew names the binary
   `whisper-cpp`), or build from source (the binary is `whisper-cli` since v1.7.4). You can also
   point `binaryPath` at it in `config.json`.
3. **A GGML model** — Homebrew installs the binary but **no model**, so this is the step people
   miss. Drop one into **`~/.shepherd/whisper/`**:

   ```sh
   mkdir -p ~/.shepherd/whisper
   curl -L -o ~/.shepherd/whisper/ggml-small.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
   ```

   `small` (~466 MB) is a good default; `base` (~142 MB) is faster/rougher, `large-v3-turbo`
   (~1.6 GB) is best on Apple Silicon. Use the **multilingual** models (no `.en` suffix). Or set
   `model` in `config.json` to a model you already have.

The **Settings → Plugins** panel shows the server row plus which of the three CLI pieces are
detected and which engine is selected, and the status row / `GET status` route carry a copy-paste
hint for whatever is missing.

> **whisper.cpp built from source but not on `PATH`?** Point `binaryPath` at it, e.g.
> `"binaryPath": "/home/you/whisper.cpp/build/bin/whisper-cli"` — otherwise the CLI backend reports
> `not found` even though the binary exists.

## Install

Shepherd loads plugins from `~/.shepherd/plugins/` **at boot only** — clone here, then restart:

```sh
git clone https://github.com/erwins-enkel/shepherd-plugin-voice-whisper \
  ~/.shepherd/plugins/voice-whisper
# edit ~/.shepherd/plugins/voice-whisper/config.json if whisper-cli isn't on PATH
systemctl --user restart shepherd
```

`git pull` in that folder + a restart updates it. When the plugin reports `available`, Shepherd's
compose-bar mic uses it (see `preferLocal` for the browser-vs-local choice).

## Config (`config.json`, all optional)

| Field         | Default   | Meaning                                                                                     |
| ------------- | --------- | ------------------------------------------------------------------------------------------- |
| `serverDiscovery` | `true` | Auto-discover a faster-whisper server on `localhost` (`127.0.0.1:9876`) when `serverUrl` is unset. `false` disables all probing. Localhost-only — never sends audio off-host. |
| `serverUrl`   | `""` (discover) | Explicit base URL of a faster-whisper server (`/health` + `/transcribe` contract). Set it to probe **only** that URL and skip discovery; this is the only way to use a **non-localhost** server (which sends audio off-host). |
| `binaryPath`  | auto      | Absolute path to the whisper.cpp CLI. Auto-detects `whisper-cli` → `whisper-cpp` on `PATH`. |
| `model`       | auto      | Absolute path to a GGML model. Auto-scans `~/.shepherd/whisper/` for `ggml-<size>.bin`.     |
| `modelSize`   | `"small"` | Which size to prefer when scanning + which the missing-model hint suggests.                 |
| `ffmpegPath`  | auto      | Absolute path to ffmpeg. Auto-detects on `PATH`.                                            |
| `language`    | `"auto"`  | `"de"`/`"en"` pin the language; `"auto"` defers to the request's UI locale.                 |
| `preferLocal` | `false`   | `true` → use local whisper even where the browser's Web Speech API works; `false` keeps the browser engine as the default and only uses local where the browser has none (iOS PWA). |
| `maxBytes`    | 25 MiB    | Reject larger clips with `413`.                                                             |

## Routes (behind Shepherd's operator auth)

- `POST /api/plugins/voice-whisper/transcribe` — multipart `file` (audio blob) + optional
  `lang` form field → `{ text }`. `413` over `maxBytes`; `503` `{ error, hint }` when no engine is
  ready (also when the server was chosen but is unreachable at send time and no CLI fallback exists).
- `GET /api/plugins/voice-whisper/status` → `{ available, engine, server, model, ffmpeg, language,
  preferLocal, hint }`. `engine` is `"faster-whisper server (whisper-stt)"` / `"whisper.cpp"` / `null`;
  `server` is `{ url, model }` when a server is reachable, else `null`.

## Pipeline

**Server backend:** `clip → POST <serverUrl>/transcribe (multipart file + language) → { text }`.
faster-whisper decodes the browser's webm/ogg/mp4 itself, so there is no ffmpeg step and no local
model. If the server is unreachable at send time, the request degrades to the CLI backend when it is
ready, otherwise returns `503`.

**CLI backend:** `clip → temp file → ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le → temp WAV → whisper-cli
-m <model> -f <wav> -l <lang> -nt → text`. The clip is buffered to a **seekable temp file** before ffmpeg
(never `-i pipe:0`) because iOS `MediaRecorder` mp4 carries a trailing `moov` atom that fails to
demux from a non-seekable pipe. Both temp files are always cleaned up.

## Develop / test

```sh
bun test                        # unit tests (mocked runner/IO; no real binaries)
bun run typecheck               # tsc against the vendored contract

# end-to-end smoke test against your real ffmpeg + whisper.cpp + model (no herdr, no browser):
WHISPER_BIN=~/whisper.cpp/build/bin/whisper-cli \
WHISPER_MODEL=~/whisper.cpp/models/ggml-small.bin \
bun run smoke.ts /path/to/clip.wav de

# or against a running faster-whisper server (preferred when set):
WHISPER_SERVER_URL=http://127.0.0.1:9876 bun run smoke.ts /path/to/clip.wav de
```

`types.ts` is vendored from Shepherd's `src/plugins/types.ts` (plugin API v1). If Shepherd bumps
the plugin API, refresh it and bump `apiVersion` in `plugin.json`.

## License

This plugin is distributed as part of Shepherd and is licensed under the
[Business Source License 1.1](./LICENSE) © 2026 Erwins Enkel GmbH, on the same terms as
Shepherd itself. It is **source-available**, not open source: you may read, modify, and make
non-production use freely, and production use is permitted **except** offering it to third parties
as a competing hosted or embedded commercial service (see the Additional Use Grant in
[`LICENSE`](./LICENSE)). Each version converts to the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) four years after it is published
(its Change Date). For other arrangements, contact Erwins Enkel GmbH.
