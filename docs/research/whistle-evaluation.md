# Whistle (Cactus Compute) — Evaluation für `shepherd-plugin-voice-whisper`

Stand: **2026-10-04**. Whistle wurde am 2026-10-02 veröffentlicht und ist zum Zeitpunkt dieser
Prüfung **zwei Tage alt**. Frage des Operators: *„Wäre Whistle als Integration besser für uns?
Oder sogar als Auto-Install? Welche Optionen haben wir?"*

Legende in den Tabellen: **[V]** = gegen Primärquelle verifiziert · **[C]** = Vendor-Claim, nicht
unabhängig geprüft · **[M]** = selbst gemessen (Abschnitt 3) · **[I]** = eigene Schlussfolgerung.

---

## TL;DR

- **Whistle ist kein Ersatz für unser Whisper.** Die deutsche Qualität liegt auf dem Niveau von
  Whisper **base**, nicht small: In einer Stichprobe aus MLS-de (22 Äußerungen, 712 Wörter) kam
  Whistle auf **22,3 % WER**, whisper.cpp base auf 18,0 %, **small auf 8,9 %**, und unser
  faster-whisper-Server (large-v3-turbo) auf **3,4 %** [M]. Cactus veröffentlicht **keine WER pro
  Sprache**. Ihren Vorsprung beim FLEURS-Mittel gegenüber Whisper base kann ich aus der Tabelle,
  die sie selbst zitieren, nicht nachrechnen (Abschnitt 2.1).
- **Bei kurzen Clips ist Whistle sehr schnell und sehr klein:** Ein 2–5-s-Clip braucht
  **50–125 ms** einschließlich Prozessstart und Laden des Modells, bei ~40 MB RSS und 18,4 MB
  Download insgesamt [M]. Auf diesem x86-Rechner springt die Zeit bis zum ersten Token aber ab
  ~6 s Audio von ~35 ms auf 300–500 ms. Ab ~10 s ist Whistle nicht schneller als whisper.cpp base
  [M]. Die beworbenen 11 ms sind auf einem Apple M4 Pro gemessen [C].
- **Das Setup-Problem löst Whistle nur zur Hälfte.** Die Engine liest nur RIFF-WAV, also bleibt
  **ffmpeg** für webm/opus und mp4/aac nötig [M]. Über 30 s bricht sie hart ab (`audio limit is
  30 s`, Exit 1), das Aufteilen längerer Clips wäre unsere Aufgabe [M]. Eine Streaming-API gibt es
  nur in einem **offenen PR (#168, von heute)**. Die veröffentlichte Engine 3.1.0 exportiert
  sie nicht [V].
- **Empfehlung:** Als Erstes **(E)**: ein Auto-Install für den *bestehenden* whisper.cpp-Pfad (ein
  Knopf lädt die fertige Linux-Binary und das Modell `ggml-small` mit gepinntem SHA256). Das
  beseitigt das „Modell vergessen"-Problem ohne Qualitätsverlust. Dazu ein **Core-Issue (F)**:
  Wenn der Browser 16-kHz-WAV schickt, braucht kein Engine mehr ffmpeg. Whistle selbst ist
  höchstens eine **spätere Opt-in-Engine** für schnelle `mode=partial`-Vorschauen **(G)** oder für
  sehr schwache Hardware, und erst, wenn die Engine gereift ist.
- **Die Lizenz blockiert nichts:** Gewichte und Engine-Binaries stehen unter **Apache-2.0** [V].
  Zwei Einschränkungen: Die Engine ist **nur als Binary** verfügbar (C++-Quellcode nicht
  öffentlich), und das **Python-Paket** schickt standardmäßig Telemetrie. Die native Binary
  importiert statisch weder `connect` noch `getenv` [V].

---

## 1. Was Whistle ist — Faktenlage

| Aspekt | Befund | Status | Quelle |
|---|---|---|---|
| Größe der Gewichte | `whistle.cact` = 16.919.407 B (16,9 MB), SHA256 `b6e02f04…1dffeb` | [V] | HF `Cactus-Compute/whistle` @ `b358ddad`, LFS-Metadaten |
| Sprachen | en, de, fr, es, it, nl, pl | [V] | HF `whistle/config.json` (`languages`) |
| Eingabe | 16 kHz mono, **max. 30 s pro Durchlauf** | [V][M] | `config.json` `max_audio_seconds: 30`; `needle.h` Z. 63–80; CLI-Fehler bei 53 s |
| Architektur | Encoder-Decoder, Log-Mel 80 Bins, 8 Encoder- und 8 Decoder-Blöcke, Beam ×5, Keyword-Biasing | [C] | Blog, Model Card |
| Ausgabe | JSON `{"text","language","ttft_ms","decode_tps"}`, optional `words[]` mit Zeitstempeln | [V][M] | `needle.h` Z. 63–71; CLI-Ausgabe |
| Stille | liefert `{"text":"","language":""}`, keine Halluzination | [V][M] | `needle.h` Z. 68; 5 s Stille → leer in 57 ms |
| Engine | „Needle 3“, C++, eine Binary pro Plattform; importiert nur libc/libm/libpthread/libdl | [V] | `ldd`/`nm -D` auf `linux-x86_64/needle` |
| Plattformen | 17 Ordner in HF `needle3`: macos-arm64, linux-{x86_64,arm64,armv7,riscv64,mipsel}, windows-{x86_64,arm64}, android-{arm64,armv7,riscv64}, ios/ios-sim/tvos/watchos-arm64, wasm, wasm-component. **Kein macos-x86_64-Ordner.** iOS/tvOS/watchOS liefern nur `libneedle.a` + Header | [V] | HF-API-Dateiliste `needle3` @ `c7c415a3`; `needle/agent/fetch.py` Z. 39–43 |
| C-API | `needle_load`, `needle_transcribe`, `needle_embed`, `needle_last_error`; „one process-global, **non-thread-safe** model per kind“ | [V] | `linux-x86_64/needle.h` Z. 15–18, 72–80 |
| Shared Library | `.so`/`.dylib`/`.dll` **nur in den Engine-Wheels** auf HF (`python/cactus_needle-3.1.0-py3-none-<tag>.whl` → `needle/libneedle3.so`, 1,56 MB) | [V] | HF-Dateiliste; `fetch.py` Z. 272–291 |
| HTTP-Server | `--serve` bietet nur `POST /complete` (Text für Needle-Tool-Calls) und `POST /reset`, **keinen Transkriptions-Endpoint** | [V] | `needle --help` |
| PyPI | `cactus-needle` 3.1.0, reines Python-Wheel (106 KB), Abhängigkeit `huggingface_hub`; die Engine wird zur Laufzeit von HF geladen | [V] | PyPI-JSON; `pyproject.toml` |
| Lizenz der Gewichte | Apache-2.0 (Metadaten der Model Card und `LICENSE`, identischer Text, SHA256 `cfc7749b…`) | [V] | HF `whistle/LICENSE`, README-Frontmatter |
| Lizenz der Engine und SDK | Apache-2.0 (GitHub `cactus-compute/needle/LICENSE`, HF `needle3/LICENSE`) | [V] | ebd. |
| Engine-Quellcode | **nicht öffentlich**. Das GitHub-Repo enthält nur Python, JAX-Training und Tests (68 Dateien, keine `.c/.cc/.cpp/.h`). Eine Codesuche nach `needle_transcribe` in der Org findet nur den ctypes-Wrapper | [V] | `git ls-files` @ `9571a58`; `gh search code` |
| Telemetrie | Python-Paket: an, sendet an Supabase-Endpoint, abschaltbar per `NEEDLE_TELEMETRY=0`/`DO_NOT_TRACK`. Laut README „turned on in the binary“, aber die Binary importiert kein `connect`/`getaddrinfo`/`getenv` und `libneedle3.so` gar keine Netzwerkfunktionen | [V] | `needle/_telemetry.py` Z. 17–37; README Z. 148; `nm -D` |
| WER | nur selbst berichtet, **keine Werte pro Sprache**, FLEURS und MLS nur als Mittel (21,4 / 24,9) | [C] | HF `assets/whistle-benchmarks.svg` (Textlabels), Model Card |
| Latenz | 11,1 ms TTFT und 1.319 tok/s bei 10 s Audio auf einem Apple M4 Pro | [C] | Blog, Model Card |

---

## 2. Passt Whistle zu unseren Anforderungen?

### 2.1 Deutsche Qualität (wichtigster Punkt)

| Modell | FLEURS-de (publ.) | MLS-de (publ.) | **MLS-de-Stichprobe [M]** | FLEURS-Mittel 7 Spr. |
|---|---|---|---|---|
| **Whistle** (16,9 MB) | **nicht veröffentlicht** | nicht veröffentlicht (nur Mittel 6 Spr.: 24,9) | **22,3 %** | 21,4 [C] |
| Whisper base (142 MiB ggml) | 17,9 | 17,7 | 18,0 % | **21,0** (aus Tab. 13 berechnet) |
| Whisper small (465 MiB, unser CLI-Default) | 10,2 | 10,5 | **8,9 %** | 11,1 |
| Whisper large-v2 | 4,5 | 5,5 | – | 5,2 |
| large-v3-turbo (faster-whisper int8, läuft auf diesem Host) | – | – | **3,4 %** | – |

Quellen: Whisper-Paper arXiv:2212.04356, Tabelle 13 (FLEURS) und Tabelle 10 (MLS). Die Mittelwerte
über en/de/fr/es/it/nl/pl habe ich selbst berechnet. Methodik der Stichprobe: Abschnitt 3.3.

- **Die Baselines im Blog sind bequem gewählt.** Verglichen wird nur mit Whisper **base** und mit
  Moonshine tiny, das laut Model Card nur Englisch kann. Wir nutzen **small** (whisper.cpp-Default)
  oder **large-v3-turbo** (Server). Gegen beide ist Whistle bei Deutsch etwa 2,5× bzw. 6× schlechter
  [M].
- **Der FLEURS-Vorsprung lässt sich nicht nachrechnen.** Aus den Balkenhöhen im SVG ergibt sich ein
  geplotteter Whisper-base-Wert von ~24,5 (Skala 6,87 px pro WER-Punkt; der Whistle-Balken stimmt
  mit dem Label 21,4 überein). Die zitierte Tabelle 13 ergibt für dieselben sieben Sprachen aber
  **21,0**. Nach der eigenen Quelle läge Whisper base also *knapp vor* Whistle. Beim MLS-Mittel
  passt ihr Balken (~23,1) zu Tabelle 10 (23,2), und dort geben sie selbst zu, dass base vorne liegt.
- **Die Stichprobe passt zur Literatur:** base mit 18,0 % (publ. 17,7) und small mit 8,9 %
  (publ. 10,5) zeigen, dass die 22 Äußerungen nicht ungewöhnlich leicht oder schwer sind.
- **Typische Whistle-Fehler sind kaputte Komposita und Lautschrift**, also genau die Fehler, die
  Prompts unbrauchbar machen: „Gesichtnahme ein Leiden den Ausdruck“, „Buschwimmelte“,
  „Englüstenarme Blutdüstig“, „Dünrenzeugstiefäche“ [M]. Siehe `bench-*.json` im Scratchpad.
- **Codec-Empfindlichkeit (nur ein Clip, also anekdotisch):** Nach einem Opus- oder AAC-Roundtrip
  wurde aus „Schafe“ bei Whistle „Schaffe“ bzw. „Schafel“. whisper.cpp base und small und der
  Server blieben korrekt [M]. Der Browser schickt genau solches Opus- oder AAC-Material.

### 2.2 Latenz, besonders für `mode=partial`

Median aus 3 Läufen in ms, Wall-Clock inklusive Prozessstart und Laden des Modells. Gleicher
deutscher Clip, auf die jeweilige Länge gekürzt [M]:

| Engine | 2 s | 5 s | 10 s | 20 s | 29,9 s |
|---|---|---|---|---|---|
| Whistle CLI (Default-Threads) | 61 | 125 | 866 | 1764 | 2019 |
| Whistle CLI `--threads 8` | **47** | **113** | 643 | 1214 | 1813 |
| whisper.cpp base `-t 4` | 630 | 613 | 763 | 1020 | 1289 |
| whisper.cpp small `-t 4` | 1890 | 1875 | 2142 | 2872 | 3412 |
| faster-whisper large-v3-turbo (Server, warm, 12 Threads) | 2218 | 2240 | 2664 | 4895* | 3028 |

\* Ausreißer, weil der Host geteilt ist (Load Average 5–12 auf 16 Threads während der Messungen).
Die absoluten Zahlen schwanken, die Reihenfolge blieb stabil.

- **Die Zeit bis zum ersten Token springt zwischen 5 und 6 s:** ≤5 s ≈ 31–39 ms, 6 s ≈ 310–360 ms,
  10 s ≈ 500 ms, 30 s ≈ 1,4 s (an zwei verschiedenen Clips reproduziert) [M]. Der Vendor gibt
  5,9 / 11,1 / 36,3 ms für 5 / 10 / 30 s an, gemessen auf M4 Pro [C]. Woran der Sprung liegt, lässt
  sich nicht prüfen, weil der Engine-Quellcode fehlt.
- Bei Whisper bleibt die Latenz fast konstant, weil das Modell auf 30 s auffüllt. Deshalb ist
  Whistle bei kurzen Clips **10–40× schneller** und ab ~10 s etwa gleichauf mit base.
- Für Live-Vorschauen heißt das: In den ersten ~5 s eines Diktats kämen Vorschauen in <150 ms,
  danach in 0,6–2 s. Mit dem Server heute dauert jede Vorschau ≥2,2 s [I].
- Vorschauen sind instabil: Beim Kürzen desselben Clips von 5 s auf 10 s wurde aus „Denken Sie“
  „Tegen Sie“ [M].

### 2.3 Formate und ffmpeg

- Die CLI akzeptiert **nur RIFF-WAV** („8/16/24/32-bit PCM or float, any channels and rate“, laut
  `--help`). Bei webm/opus und m4a/aac kommt `cannot read … (RIFF WAV)` mit Exit 1 [M]. **ffmpeg
  bleibt nötig.** Das gilt für whisper.cpp genauso: Die fertige Binary b5130 liest flac/mp3/ogg/wav
  über miniaudio, aber **weder webm noch ogg-opus noch m4a** [M].
- Andere Abtastraten resampelt die Engine selbst, das kostet aber ~250–300 ms zusätzlich bis zum
  ersten Token [M]. Wir sollten also wie bisher mit ffmpeg auf `-ar 16000 -ac 1` bringen.
- `--audio /dev/stdin` funktioniert, auch mit dem gestreamten WAV-Header von ffmpeg (`ffmpeg … -f
  wav -`) [M]. Die Eingabe für ffmpeg muss trotzdem eine seekbare Temp-Datei bleiben, wegen des
  `moov`-Atoms in iOS-mp4 (siehe README „Pipeline").

### 2.4 Clips über 30 s

Die Engine bricht hart ab (`needle: audio limit is 30 s`, Exit 1) [M]. Laut Header und Python-Wrapper
gilt „at most 30 s“; der Playground schneidet auf die ersten 30 s ab (`whistle.py` Z. 174, 211–214)
[V]. **Das Aufteilen wäre unsere Aufgabe**, möglichst an Pausen, damit keine Wörter zerschnitten
werden. Die Streaming-API (`needle_stream_transcribe_process/_stop`, „no limit on length“) gibt es
nur im Branch `whistle-streaming` und im offenen **PR #168** (2026-10-04). Die veröffentlichte
`libneedle3.so` 3.1.0 exportiert diese Symbole nicht (`nm -D`) [V]. Außerdem ist sie zustandsbehaftet
(Chunks von etwa 1 s). Das passt nicht direkt zu unserem Partial-Modell, bei dem pro HTTP-Request
der ganze gewachsene Clip neu geschickt wird [I].

### 2.5 Plattformen

- linux-x86_64 und macos-arm64 haben je eine fertige Binary (1,52 MB bzw. 1,07 MB) [V]. Die
  Linux-Binary braucht **glibc ≥ 2.29** (höchstes Symbol `exp@GLIBC_2.29`) und hat keine
  libstdc++-Abhängigkeit [V].
- **Intel-Mac:** keine Binary, nur die `.dylib` im Python-Wheel `macosx_11_0_x86_64` [V].
- musl/Alpine: nur als Wheel (`musllinux_1_2_*`), kein Plattform-Ordner [V].

### 2.6 Lizenz, Privatsphäre und Weitergabe

- **Apache-2.0** für Gewichte, Engine-Binaries (HF `needle3`) und SDK [V]. Das erlaubt Nutzung,
  Weitergabe und kommerzielle Verwendung ohne Klausel „nur nicht-kommerziell“. Es ist mit einem
  BUSL-1.1-Plugin vereinbar. Ein Download zur Laufzeit von HF ist ohnehin keine Weitergabe durch
  uns. Bündeln wäre ebenfalls zulässig, solange die LICENSE beiliegt (eine NOTICE-Datei gibt es
  nicht) [V][I].
- **Achtung, Verwechslungsgefahr:** Das *ältere* Engine-Repo der Firma, `cactus-compute/cactus`,
  steht unter einer **eigenen, einschränkenden Lizenz**. Sie erlaubt die Nutzung nur für
  Privatpersonen, nicht-kommerzielle Zwecke oder Organisationen mit <2 Mio. USD Funding *und*
  Umsatz [V]. Needle und Whistle sind ausdrücklich Apache-2.0. Weil die Needle-Engine nur als
  Binary vorliegt, lässt sich nicht prüfen, ob darin Code aus `cactus` steckt. Das ist ein
  Restrisiko, kein Blocker [I].
- **Binary-only** heißt: nicht auditierbar, nicht selbst baubar, kein Patchen bei Fehlern [V][I].
- **Telemetrie:** Das Python-Paket meldet jeden `transcribe`-Aufruf an Supabase (Event,
  Versionen, OS, zufällige Install-ID) [V]. Für uns spricht das dagegen, den Weg über `pip` zu
  gehen. Die native Binary und die `.so` kommen statisch ohne Netzwerkfunktionen zum Verbindungsaufbau
  und ohne `getenv` aus [V]. Ein Laufzeit-Check mit `strace` war nicht möglich, weil `strace` auf dem
  Host fehlt.

### 2.7 Reife

- GitHub `cactus-compute/needle`: angelegt 2026-02-24 (für das Textmodell Needle), 13.165 Stars,
  889 Forks, 330 Commits, davon **252 von einer Person**, 32 offene Issues [V]. Whistle wurde am
  **2026-10-01** gemergt (PR #163, `bb665fc`), das HF-Repo `whistle` am **2026-09-30** angelegt
  (zur Prüfzeit 70 Downloads, 44 Likes) [V].
- Release-Takt: **täglicher automatischer Release-Train** (`.github/workflows/release.yaml`, Cron um
  09:00 PT) mit **24 PyPI-Versionen in ~8 Wochen** [V]. Es gibt **keine GitHub Releases** (nur Tags)
  und **keine HF-Tags** (`refs.tags = []`). Die Dateien in den Plattform-Ordnern werden ohne
  Version im Pfad überschrieben. Pinnen geht nur über den HF-Commit-SHA [V].
- Die API ist noch nicht stabil: Die WASI-Komponente (`needle.wit`, `cactus:needle@3.0.0`) kennt
  noch kein `transcribe`. Streaming kam zwei Tage nach dem Launch als PR. Die README behauptet
  Telemetrie „in the binary“, die Model Card sagt „the engine reads no environment variables“ [V].
- **Fazit: zwei Tage alt, keine unabhängigen Benchmarks, schnelle Änderungen, ein
  Hauptentwickler.**

---

## 3. Praxistest

Host: AMD Ryzen AI MAX 385 (Zen 5, 8 Kerne / 16 Threads, bis 5,06 GHz), 30 GiB RAM, **keine
NVIDIA-GPU** (`nvidia-smi` fehlt), Arch Linux, Kernel 7.0.10. Der Host ist geteilt, die Load
Average lag während der Messungen bei 5–12. Alle Artefakte liegen im Session-Scratchpad (`$S`),
nichts wurde systemweit installiert. Audio ging nur an localhost.

### 3.1 Bezug der Artefakte, gepinnt und mit SHA256-Prüfung

```sh
N=c7c415a3d1b3d929014bc6e866d51ebb971f7089   # HF Cactus-Compute/needle3 main
W=b358ddadd89b7a713b5aa131f23032d3cca1b251   # HF Cactus-Compute/whistle main
curl -sSL -o linux-x86_64/needle https://huggingface.co/Cactus-Compute/needle3/resolve/$N/linux-x86_64/needle
curl -sSL -o whistle.cact        https://huggingface.co/Cactus-Compute/whistle/resolve/$W/whistle.cact
sha256sum linux-x86_64/needle whistle.cact
# b197ceaef3b300a0b14c3a4fde92305527e43f9256c53d2a53d2a2fe8fe69678  needle        (= HF LFS oid)
# b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb  whistle.cact  (= HF LFS oid)
```

Gesamtdauer etwa 4,4 s für binary, header, `.a`, Wheel und Gewichte. Den Weg über `pip` habe ich
bewusst nicht genommen (Telemetrie, HF-Hub-Abhängigkeit). Die Engine-Bibliothek habe ich direkt
aus dem Wheel `cactus_needle-3.1.0-py3-none-manylinux2014_x86_64.whl` entpackt (SHA256 `a0fc2f68…`).

### 3.2 Self-Test-Clips des Repos (16 kHz mono, 16 Bit)

```sh
./linux-x86_64/needle --model whistle.cact --audio assets/selftest-de.wav --audio-language de
# {"text":"Schafe. Schafe. Ich sehe nur noch Schafe.","language":"de","ttft_ms":16.2,"decode_tps":1053.9}
./linux-x86_64/needle --model whistle.cact --audio assets/selftest-en.wav --audio-language en
# {"text":"Cheap, cheap, all I see is cheap.","language":"en","ttft_ms":7.9,"decode_tps":1076.6}
```

| Engine | de (4,06 s) | en (2,06 s) | Wall | max. RSS |
|---|---|---|---|---|
| Whistle CLI | „Schafe. Schafe. Ich sehe nur noch Schafe.“ ✓ | „Cheap, cheap, all I see is cheap.“ ✗ | 50–88 ms (de), 34–38 ms (en) | ~40 MB |
| Whistle, Sprache automatisch erkannt | identisch, `de` erkannt | identisch, `en` erkannt | 40–50 ms | ~40 MB |
| whisper.cpp base (Binary b5130) | „Schafe. Schafe. Ich sehe nur noch Schafe.“ ✓ | „cheap, cheap, all I see is cheap.“ ✗ | ~470–490 ms | ~284 MB |
| whisper.cpp small | „Schafe, schafe, ich sehe nur noch schafe.“ ✓ | „Cheap, cheap, all I see is cheap.“ ✗ | ~1,55 s | ~750 MB |
| faster-whisper large-v3-turbo (`/health`: `{"model":"large-v3-turbo","ready":true}`) | „Schafe, Schafe, ich sehe nur noch Schafe.“ ✓ | „Sheep. Sheep. All I see is sheep.“ ✓ | 1,53–1,94 s | (Server) |

Den englischen Piper-Clip hören alle kleinen Modelle als „cheap“. Das ist kein spezifischer
Whistle-Fehler. Einen echten Kaltstart mit geleertem Page-Cache konnte ich ohne `sudo` nicht
messen. Das Laden der 16,9 MB dauert im Warmzustand ~20 ms (gemessen über `bun:ffi`).

### 3.3 Deutsche Stichprobe aus MLS-de-Test (Vorlesesprache)

22 Äußerungen von 21 Sprechern, 318,5 s, 712 Referenzwörter, verteilt über den Test-Split
(Offsets 0…3150), geladen über den HF-Datasets-Server. Opus wurde lokal mit ffmpeg nach
16-kHz-WAV konvertiert. Alle Engines bekamen `language=de`. WER nach Kleinschreibung und
Entfernen der Interpunktion, ohne Normalisierung von Zahlen (das trifft alle Engines gleich,
z. B. „30“ statt „dreißig“). Skripte: `$S/bench.py`, Rohdaten: `$S/bench-*.json`.

| Engine | WER | Fehler/Wörter | Wall gesamt | RTF |
|---|---|---|---|---|
| Whistle CLI | **22,33 %** | 159/712 | 16,1 s | 0,050 |
| whisper.cpp base | 17,98 % | 128/712 | 18,4 s | 0,058 |
| whisper.cpp small | **8,85 %** | 63/712 | 53,2 s | 0,167 |
| faster-whisper large-v3-turbo (Server) | **3,37 %** | 24/712 | 57,5 s | 0,180 |

Grenzen: kleine Stichprobe, Vorlesesprache aus Hörbüchern, kein echtes Diktat, keine eigene
Stimme, kein Mikrofon-Opus. Die gute Übereinstimmung von base und small mit den publizierten
MLS-de-Werten spricht aber für eine brauchbare Stichprobe.

### 3.4 Formate, Länge, Stille

```text
--audio de.webm                  → "cannot read de.webm (RIFF WAV)", exit 1
--audio de.m4a                   → "cannot read de.m4a (RIFF WAV)", exit 1
--audio de-48k-stereo-f32.wav    → korrekt, ttft 238 ms (internes Resampling)
--audio /dev/stdin  (ffmpeg -f wav - | …)  → korrekt
--audio long.wav (53,5 s)        → "needle: audio limit is 30 s", exit 1
--audio silence.wav (5 s)        → {"text":"","language":"",...} in 57 ms
```

Skalierung mit Threads bei einem 18,8-s-Clip (Host unter Last): 1 Thread 4,8 s · 2 Threads 4,7 s ·
4 Threads 2,1 s · 8 Threads 1,25 s [M].

### 3.5 In-Process: `bun:ffi` und WASM (Bun 1.3.10)

- **`bun:ffi` mit `libneedle3.so` funktioniert** (`$S/ffi/test.ts`): `dlopen` + `needle_load`
  19 ms. Ein 5-s-Clip braucht 54–88 ms, ein 10-s-Clip 628–683 ms. Die CLI braucht im direkten
  Vergleich 79–109 ms bzw. 625–853 ms. **In-Process spart also nur ~20–40 ms** [M]. Der Bun-Prozess
  hat dabei 113–123 MB RSS.
- **Der Emscripten-WASM-Build läuft unter Bun** (`wasm/needle.js` 62 KB + `needle.wasm` 904 KB,
  exportiert `_needle_transcribe`). Er ist single-threaded: ein 4-s-Clip braucht 385–415 ms, ein
  18,8-s-Clip ~2,4 s, also 4–8× langsamer als nativ, bei identischem Text [M]. Der
  `wasm-component`-Build (WIT `cactus:needle@3.0.0`) hat **kein** `transcribe` [V].

---

## 4. Optionsraum

Konvention im Repo (`CLAUDE.md`): Alles, was Browser, UI oder Core-Hooks braucht, wird ein
**Core-Issue in `erwins-enkel/shepherd`** und wird plugin-agnostisch entworfen. Der passende Rahmen
ist erwins-enkel/shepherd#1453 (Contract für eine Transkriptions-Capability).

| | Option | Wo | Aufwand | Nutzen | Risiken |
|---|---|---|---|---|---|
| **A** | Status quo (Server, sonst whisper.cpp CLI) | – | 0 | Beste Qualität, wenn der Server läuft (turbo 3,4 %) | Setup-Reibung bleibt: ffmpeg + whisper-cli + manuelles Modell, oder separater Python-Server |
| **B** | Whistle als dritte Engine, als CLI-Subprozess | Plugin | S–M (~1–2 Tage inkl. Tests) | 18 MB statt ~0,5 GB, RSS ~40 MB, Kurzclips <150 ms; die Pipeline gleicht dem whisper.cpp-Pfad (ffmpeg → WAV → `needle --audio … --audio-language …` → JSON) | **Deutsche Qualität ≈ base**. Nur als Opt-in einreihen (`engine: "whistle"`) oder unterhalb von whisper.cpp small, niemals vor dem Server. Aufteilen >30 s muss gebaut werden. CLI-Flags können sich ändern (täglicher Release-Train). Latenzsprung ab 6 s auf x86 |
| **C** | Whistle in-process über `bun:ffi` oder WASM | Plugin | M–L | gemessen nur ~20–40 ms Ersparnis | Globales, **nicht threadsicheres** Modell pro Prozess, d. h. alle Aufrufe (auch Partials) müssen serialisiert werden. Synchrones FFI blockiert den Event-Loop von Shepherd für 0,05–2 s, sofern es nicht in einem Worker läuft. Ein nativer Absturz reißt **ganz Shepherd** mit, weil das Plugin in-process läuft. `.so` gibt es nur im Wheel. WASM ist 4–8× langsamer. **Nicht empfohlen** |
| **D** | Auto-Install für Whistle (Action-Button im Settings-Panel) | Plugin | S (~1 Tag zusätzlich zu B) | Ein Klick lädt 18,4 MB in Sekunden, keine Python-Abhängigkeit | Hilft nur zusammen mit B. Löst **ffmpeg nicht**. Kein Intel-Mac. Keine Signaturen, Vertrauen in HF und den Cactus-Account; Pin auf Commit plus fest eincodierter SHA256 mildert das ab. Nicht über `pip` (Telemetrie) |
| **E** | **Auto-Install für den bestehenden whisper.cpp-Pfad** | Plugin | S–M | Beseitigt den in der README genannten Hauptstolperstein („Homebrew installs … no model“) **ohne Qualitätsverlust** (small 8,9 %) | 466 MiB Download (~22 s hier) muss asynchron laufen, mit Fortschritt per `publishUI`. Die Binary gibt es nur für Linux x64 (glibc ≥ 2.34, `GLIBCXX_3.4.29`), unter macOS bleibt `brew`. ffmpeg bleibt nötig |
| **F** | Browser schickt 16-kHz-PCM-WAV, wenn das Plugin es anfordert | **Core-Issue** | M (Core) | Kein ffmpeg mehr für *jede* CLI-Engine (whisper.cpp und Whistle lesen WAV). Damit wird ein Auto-Install wirklich „1 Klick“ | iOS-PWA und AudioWorklet ungeprüft. 32 KB/s, also 60 s ≈ 1,9 MB (unter `maxBytes` 25 MiB). Muss generisch sein, etwa ein deklariertes `accepts: ["audio/wav;rate=16000"]` im Rahmen von #1453 |
| **G** | Hybrid: Whistle nur für `mode=partial`, das finale Transkript über Server oder whisper.cpp | Plugin (setzt B und D voraus) | S zusätzlich zu B | Schnelle Vorschauen (<150 ms in den ersten 5 s, statt ≥2,2 s mit turbo). Das Finale behält Whisper-Qualität. Der Unterschied zwischen `partial` und finalem Clip existiert in der Route schon | Vorschau-Text ist sichtbar schlechter und springt beim Finale. Lohnt nur, wenn die Latenz der Vorschau wirklich stört. Opt-in |
| **H** | Sonstiges (kurz) | – | – | **Parakeet TDT 0.6B v3** (NVIDIA, CC-BY-4.0, 25 Sprachen, FLEURS-de **5,04** laut Model Card [C]). whisper.cpp 1.9.4 liefert `parakeet-cli` bereits im selben Linux-Tarball mit [V], aber es gibt kein offizielles ggml-Modell zum Download (nur `models/convert-parakeet-to-ggml.py`) [V]. Das wäre die interessantere „kleine, aber gute“ Alternative und verdient eine eigene Prüfung. **Moonshine:** laut Whistle-Card nur Englisch, für uns irrelevant. **WASM im Browser (Core):** technisch möglich (siehe Whistle-Demo im Blog), gleiche Qualitätsgrenze, Core-Arbeit. **`whisper-server`** (ebenfalls im Tarball) spricht `/inference`, nicht unseren `/health`+`/transcribe`-Contract | |

**Konkret, was ein Auto-Install laden würde:**

| | Artefakt | Bezugsquelle (gepinnt) | Größe | Integrität |
|---|---|---|---|---|
| D | Whistle-Engine linux-x86_64 | `huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3…/linux-x86_64/needle` | 1.517.200 B | SHA256 `b197ceae…69678` (HF LFS oid) |
| D | Whistle-Engine macos-arm64 | `…/needle3/resolve/c7c415a3…/macos-arm64/needle` | 1.073.160 B | SHA256 `f52c9ce7…77dc` |
| D | Gewichte | `huggingface.co/Cactus-Compute/whistle/resolve/b358ddad…/whistle.cact` | 16.919.407 B | SHA256 `b6e02f04…dffeb` |
| E | whisper.cpp CLI linux-x64 | `github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-ubuntu-x64.tar.gz` (der Tag `v1.9.4` selbst hat keine Assets) | 9.793.438 B (25 MB entpackt, `RUNPATH $ORIGIN`) | GitHub-Asset-Digest `sha256:53e7fd8b…36c32` |
| E | `ggml-small.bin` | `huggingface.co/ggerganov/whisper.cpp/resolve/5359861c…/ggml-small.bin` | 487.601.967 B | SHA256 `1be3a9b2…a987b` |
| E | Alternative `ggml-small-q5_1.bin` | dito | 190.085.487 B | SHA256 `ae85e4a9…411bb` (Qualität auf Deutsch ungeprüft) |

Beide Pfade sind **nicht signiert**, nur über Hashes prüfbar. ffmpeg deckt keiner ab. Es gibt
statische Builds von Dritten (GPL). Sauberer wäre Option F.

Technisch ist das alles plugin-intern machbar: `action-button` mit `confirm`-Text („18 MB von
huggingface.co laden?“), eine `POST /install`-Route startet den Download im Hintergrund,
`publishUI` aktualisiert eine Fortschrittszeile. `detect()` läuft bei jedem Request
(`index.ts` Z. 983–1057), also wird die neue Engine **ohne Neustart** erkannt, sofern ihr Code
schon im Plugin ist [V].

**Empfohlene Reihenfolge:**

1. **E** jetzt.
2. **F** als Core-Issue.
3. **B, D, G** erneut prüfen, wenn (a) die Streaming-API in einer veröffentlichten Engine angekommen
   ist, (b) Cactus WER pro Sprache veröffentlicht oder wir einen eigenen FLEURS-de-Lauf haben,
   (c) der x86-Latenzsprung geklärt ist und (d) die CLI- und C-API einige Wochen stabil war.
4. Parallel lohnt ein kurzer Blick auf Parakeet über whisper.cpp (H).

---

## 5. Offene Fragen: vor dem Bauen klären

1. **Woher kommt der Latenzsprung zwischen 5 und 6 s auf x86?** Der Engine-Code ist geschlossen,
   also beim Vendor nachfragen oder ein Issue anlegen. Ohne Klärung schrumpft der Nutzen für
   Vorschauen auf die ersten ~5 s.
2. **Wie gut ist Whistle auf Deutsch, offiziell?** Cactus nach FLEURS-de und MLS-de fragen, oder
   selbst einen vollständigen FLEURS-de-Lauf über alle Engines machen.
3. **Woher stammt der Whisper-base-FLEURS-Wert von ~24,5 im Diagramm?** Aus der zitierten
   Tabelle 13 ergibt sich 21,0.
4. **Wie verhält sich Whistle bei echtem Diktat?** Eigene Stimme, Laptop- oder iPhone-Mikro, Opus
   48 kHz bzw. AAC. Die Codec-Empfindlichkeit war auffällig, beruht aber auf nur einem Clip.
5. **Wann und wie kommt die Streaming-API (PR #168) in eine veröffentlichte Engine?** Und wie ließe
   sich ein zustandsbehafteter Stream mit unseren zustandslosen Partial-Requests verbinden? Das
   bräuchte wohl eine Session-ID pro Diktat, also ein Thema für #1453.
6. **Lizenz der Engine:** Kann Cactus bestätigen, dass die Needle-Engine-Binary vollständig unter
   Apache-2.0 steht, ohne Code aus dem einschränkend lizenzierten `cactus`-Repo? Wird der Quellcode
   veröffentlicht?
7. **glibc auf den Ziel-Hosts:** Whistle braucht ≥ 2.29, whisper-cli aus b5130 braucht ≥ 2.34 und
   GCC-11-libstdc++.
8. **macOS:** Startet eine per `fetch` geladene, unsignierte Binary ohne Gatekeeper-Eingriff
   (kein Quarantäne-xattr)? Für Intel-Macs gibt es bei Whistle keinen Weg.
9. **Host-Verhalten bei langen Aktionen:** Hat der Action-Button ein Timeout? Aktualisiert das Panel
   `publishUI`-Updates live, oder erst beim erneuten Öffnen? Das ist relevant für 466 MiB in E.
10. **Wie gut ist `ggml-small-q5_1` (190 MB) auf Deutsch im Vergleich zu small in voller Präzision?**
    Das wäre ein günstigerer Default für E.

---

## 6. Quellen

- Blog: <https://cactuscompute.com/blog/whistle> (2026-10-02, abgerufen 2026-10-04)
- Model Card und Dateien: <https://huggingface.co/Cactus-Compute/whistle> @ `b358ddadd89b7a713b5aa131f23032d3cca1b251`
  (`README.md`, `config.json`, `LICENSE`, `assets/whistle-benchmarks.svg`; HF-API `?blobs=true` für Größen und SHA256)
- Engine-Ordner: <https://huggingface.co/Cactus-Compute/needle3> @ `c7c415a3d1b3d929014bc6e866d51ebb971f7089`
  (`linux-x86_64/{needle,needle.h,libneedle.a}`, `python/cactus_needle-3.1.0-*.whl`, `wasm/`, `wasm-component/needle.wit`, `LICENSE`)
- SDK-Quellcode: <https://github.com/cactus-compute/needle> @ `9571a58` (main, 2026-10-02):
  `LICENSE`, `pyproject.toml`, `README.md` Z. 51, 143, 148, `needle/agent/fetch.py` Z. 9–43, 272–291,
  `needle/agent/whistle.py` Z. 45–66, 84–89, 148–160, 174, 211–214, `needle/_telemetry.py` Z. 17–37,
  `.github/workflows/release.yaml`. PR #163 (Whistle, `bb665fc`), PR #168 und Branch `whistle-streaming` (`19a37ab`)
- Paket: <https://pypi.org/pypi/cactus-needle/json> (3.1.0, 24 Releases seit 2026-08-10)
- Älteres Engine-Repo und Lizenz: <https://github.com/cactus-compute/cactus> (`LICENSE`)
- Whisper-Paper: Radford et al., arXiv:2212.04356, Tabelle 10 (MLS) und Tabelle 13 (FLEURS)
- whisper.cpp: <https://github.com/ggml-org/whisper.cpp/releases/tag/b5130> (Assets und Digests über die GitHub-API),
  `models/download-ggml-model.sh`, `models/convert-parakeet-to-ggml.py`. Modelle:
  <https://huggingface.co/ggerganov/whisper.cpp> @ `5359861c739e955e79d9a303bcbc70fb988958b1` (MIT)
- Parakeet: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3> (Model Card, `model-index` FLEURS de_de)
- Testdaten: MLS German Test über <https://datasets-server.huggingface.co> (`facebook/multilingual_librispeech`, config `german`)
- Eigene Messungen: Session-Scratchpad `…/827bcf62-…/scratchpad/` (`bench.py`, `bench-*.json`, `latency.py`,
  `latency.json`, `ffi/test.ts`, `dl/wasm/t.cjs`, `timeit.py`)
- Dieses Repo: `README.md`, `CLAUDE.md`, `index.ts` (`detect()` Z. 256 ff., Aufrufe Z. 983–1057), `types.ts`
  (`action-button`, `publishUI`)
- Lokaler whisper-stt-Server auf diesem Host (nicht Teil des Repos): `~/.openclaw/skills-repo/whisper-stt/scripts/server.py`,
  gestartet mit `--model large-v3-turbo --threads 12` (faster-whisper, `device="cpu"`, `compute_type="int8"`, `beam_size=5`, `vad_filter=True`)
