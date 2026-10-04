# Gibt es etwas Besseres als unser aktuelles STT-Modell?

Stand: **2026-10-04**. Frage des Operators: *„Gibt es etwas, das noch besser ist als unser aktuelles
Modell? Wir nutzen es inzwischen auch in der iOS-App."* Gemeint ist Speech-to-Text: gesprochene
Prompts werden zu Text, im Web und in der nativen iOS-App.

Vorgängerbericht: [`whistle-evaluation.md`](./whistle-evaluation.md). Ergebnis dort: Cactus Whistle ist
auf Deutsch nur auf Whisper-base-Niveau.

Legende: **[M]** = selbst auf diesem Host gemessen · **[LB]** = Hugging Face Open ASR Leaderboard ·
**[V]** = Vendor-Angabe · **[3P]** = Messung Dritter · **[I]** = eigene Schlussfolgerung.

---

## TL;DR

- **Der größte Hebel ist die Hardware, nicht das Modell.** Dieselben turbo-Gewichte laufen in
  whisper.cpp über **Vulkan auf der eingebauten Radeon 8050S** bei gleicher Genauigkeit **5–7× schneller**
  als unser CPU-Server. Ein 2-s-Clip braucht **0,27 s statt 1,86 s**, ein 30-s-Clip 0,55 s statt 2,38 s [M].
  Davon profitieren die Live-Vorschau im Web und das Finalisieren in der iOS-App direkt.
- **Genauer als turbo und praktisch ein Drop-in:** `TheStageAI/thewhisper-large-v3-turbo` (CC-BY-4.0), ein
  nachtrainiertes turbo. In unserer Messung war es **auf jedem Testsatz besser**: kurze deutsche Clips
  (Common Voice) 3,83 statt 5,26 % WER, Opus 3,79 statt 4,78, Englisch 1,85 statt 2,87. Die Latenz ist
  gleich [M]. Zwei Haken: Es **schreibt Zahlen als Wörter** („Port fünftausendeinhundertvierundsiebzig“),
  und es braucht `without_timestamps=True`, sonst verschluckt es das erste Wort.
- **Nicht besser auf diesem Host:** Parakeet v3 (Deutsch schwächer, int8 kaputt), Canary-1B-v2 (zu
  langsam auf der CPU), Qwen3-ASR (Zahlwörter, gibt bei Stille seinen eigenen Prompt aus), primeline
  German turbo (schreibt durchgehend „ss“ statt „ß“), Voxtral (transkribiert unter llama.cpp nicht,
  antwortet wie ein Chatbot) und Whistle [M].
- **iOS:** Apples On-Device-Erkennung (SpeechAnalyzer) liegt nach allen verfügbaren Daten unter turbo.
  Unabhängige Zahlen für Deutsch gibt es nicht [3P]. Das **Server-Finale bleibt sinnvoll**. Mit Vulkan wäre es
  deutlich schneller fertig.
- **Empfehlung:** (1) turbo auf whisper.cpp + Vulkan umstellen. (2) Danach die TheStage-Gewichte *auf
  demselben Vulkan-Pfad* gegen echte Diktate testen, inklusive Zahlenformat. (3) Einen kleinen
  Testsatz aus echten Shepherd-Prompts aufbauen, denn öffentliche Testsätze messen unseren Fall
  (Deutsch mit englischen Dev-Begriffen) nicht.

---

## 1. Ausgangslage

| | Heute |
|---|---|
| Server-Engine | `whisper-stt` `server.py` auf `127.0.0.1:9876`: faster-whisper 1.2.1 / CTranslate2 4.8.1, `mobiuslabsgmbh/faster-whisper-large-v3-turbo`, int8, **CPU**, 12 Threads, `beam_size=5`, `vad_filter=True` |
| Host | AMD Ryzen AI MAX 385 „Strix Halo“ (Zen 5), iGPU **Radeon 8050S** (RDNA 3.5), **XDNA-2-NPU**, 30 GiB RAM, Arch Linux, keine NVIDIA-GPU |
| Web | Live-Vorschau: der wachsende Clip geht alle `INTERIM_MS` als 16-kHz-WAV mit `mode=partial` raus, also latenzkritisch. Finaler Clip (≤60 s): MediaRecorder webm/mp4 |
| iOS-App | Vorschau über Apple **SpeechAnalyzer** (iOS 26) auf dem Gerät. Beim Loslassen geht jedes Clip-Segment als 16-kHz-WAV an den Server (`WhisperFinalizer.swift`, 25 s Timeout pro Clip, sonst Apples Text) |

Quellen: `server.py`-Startzeile des laufenden Prozesses; Shepherd core `ui/src/lib/dictation.svelte.ts`,
`ui/src/lib/wav.ts`, `native/Sources/ShepherdAppCore/Compose/Voice/WhisperFinalizer.swift`,
`native/Sources/ShepherdKit/Client/ShepherdClient+Voice.swift` (origin/main `26a51234`).

---

## 2. Messung auf diesem Host

### 2.1 Testsätze

| Satz | Inhalt | Umfang | Bemerkung |
|---|---|---|---|
| DE MLS | 22 Äußerungen aus Multilingual LibriSpeech German (Test-Split), wie im Whistle-Bericht | 318,5 s, 712 Wörter | Hörbücher. Die Referenz ist klein geschrieben, ohne Satzzeichen und in **alter Rechtschreibung** („daß“). Wahrscheinlich in den Trainingsdaten |
| DE MLS-Opus | dieselben Clips über Opus 24 kbit/s und zurück | 22 | simuliert Browser-Audio |
| DE CV17 | 20 Clips aus Common Voice 17 German (Test-Split) | 130 s, 209 Wörter | **kurze Clips (3–10 s)**, also das Regime der Vorschau. 1 Fehler entspricht 0,48 Prozentpunkten |
| EN Libri | 20 Clips aus LibriSpeech test-clean | 182 s, 487 Wörter | |
| Code-Switch | 13 deutsche Dev-Sätze mit englischen Begriffen × 2 Piper-TTS-Stimmen | 26 Clips, 82 englische Begriffe | **schwacher Proxy**: Die TTS spricht englische Wörter deutsch aus („Rehbase“) |
| Latenz | ein deutscher Clip, gekürzt auf 2/5/10/20/29,9 s | – | warmes Modell, Median aus 3 Läufen |

WER: NFC, Kleinschreibung, Satzzeichen entfernt, Zahlen nicht normalisiert. Die Spalte „ß→ss“
gleicht zusätzlich die Rechtschreibreform aus.

### 2.2 Ergebnisse (Auszug)

WER in %, Latenz in ms. Fett: die beiden Empfehlungen [M].

| Engine | DE MLS | DE MLS ß→ss | DE Opus | **DE CV17 (kurz)** | EN | Code-Switch WER / Begriffe | 2 s | 10 s | 29,9 s | Stille ok |
|---|---|---|---|---|---|---|---|---|---|---|
| Server turbo (heute, CPU) | 3,37 | 2,67 | 4,78 | 5,26 | 2,87 | 23,2 / 40 | 1860 | 2063 | 2380 | ja |
| **whisper.cpp turbo f16, Vulkan, beam 5** | 3,93 | 3,37 | 4,21 | 4,31 | 2,87 | 22,5 / 45 | **272** | **333** | **545** | ja |
| whisper.cpp turbo q5_0, Vulkan | 4,35 | 3,93 | 4,63 | 4,31 | 3,08 | 23,9 / 45 | 289 | 340 | 497 | ja |
| whisper.cpp turbo q5_0, CPU | 4,63 | 4,21 | – | – | – | – | 5212 | 5142 | 5829 | – |
| **TheStage turbo, CT2 int8, `without_timestamps`** | 3,51 | 2,67 | **3,79** | **3,83** | **1,85** | **20,4 / 45** | 1331 | 1477 | 1887 | ja |
| TheStage turbo, mit Timestamps | 5,48 | 4,78 | 5,90 | 7,18 | 4,52 | 23,6 / 45 | 1471 | 1686 | 2136 | ja |
| primeline turbo-german | 4,21 | 2,53 | 5,20 | 7,18 | 2,67 | 26,4 / 40 | 2153 | 2313 | 4688 | ja |
| Parakeet TDT 0.6B v3 fp32 (CPU) | 5,20 | 5,06 | 5,34 | 4,31 | 1,85 | 27,5 / 41 | 220 | 446 | 1179 | ja |
| Parakeet v3 int8 (CPU) | 9,13 | 8,85 | 8,85 | – | 2,26 | 29,6 / 38 | 156 | 319 | 658 | ja |
| Canary-1B-v2 fp32 (CPU) | 3,37 | 2,53 | **2,81** | 5,26 | 2,46 | 25,4 / 45 | 512 | 1587 | 5438 | ja |
| Qwen3-ASR-1.7B Q8, llama.cpp Vulkan | 5,90 | 5,34 | 6,32 | 4,78 | 1,85 | 20,4 / **52** | **150** | 379 | 1097 | **nein** |
| Whistle (aus dem Vorgängerbericht) | 22,33 | – | – | – | – | – | ~50 | ~870 | ~2020 | ja |

Umgebung: whisper.cpp v1.9.4 (`927cfce`) und llama.cpp `8330e96`, beide mit `-DGGML_VULKAN=ON`
gebaut. RADV aus `vulkan-radeon 1:26.1.1-2`, passend zu Mesa 26.1.1, aber **nur im Scratchpad
entpackt**, weil auf dem System kein Vulkan-Treiber installiert ist. onnx-asr 0.12.0, sherpa-onnx
1.13.8, faster-whisper 1.2.1. Alle eigenen Engines liefen mit 8 Threads, der Server mit 12. Der Host war
geteilt (Load Average 6–35). Gemessen wurde jeweils eine Engine allein, Load pro Messung protokolliert.
Absolute Zeiten schwanken, die Verhältnisse blieben über zwei Messfenster stabil.

### 2.3 Was die Zahlen sagen

- **MLS schmeichelt unserem Server.** Turbo liefert auf allen 22 MLS-Clips Kleinschreibung ohne
  Satzzeichen in alter Rechtschreibung, also genau den Stil der Referenz. Modelle, die korrekt „dass“
  schreiben und Satzzeichen setzen, verlieren dadurch. **Fairer ist CV17** (kurze Clips, moderne
  Rechtschreibung). Dort liegt der Server mit 5,26 % hinten. Das passt zum Leaderboard: turbo hat auf
  CoVoST-2-de (kurze Common-Voice-Clips) **8,58** gegenüber 4,79 bei large-v3 [LB]. **Kurze Clips sind
  turbos Schwachstelle**, und die Live-Vorschau besteht genau aus kurzen Clips.
- **Vulkan ändert nichts an der Genauigkeit**, nur an der Zeit. q8_0 ist genauso genau wie f16. q5_0
  kostet ~0,4 Prozentpunkte und ist auf der GPU nicht schneller. Greedy spart nur ~10 % gegenüber beam 5.
  whisper.cpp auf der **CPU** ist keine Alternative: ~5 s pro Clip.
- **TheStage ist überall vorne**, aber jede einzelne Differenz liegt im Rauschen dieser kleinen Sätze.
  Überzeugend ist, dass alle Differenzen in dieselbe Richtung zeigen und zur Leaderboard-Angabe passen
  (CoVoST-de 3,17 vs. 8,58 [LB]). Vorsicht: Der PR, der das Modell ins Leaderboard brachte, änderte
  zugleich den Normalizer, und der PR-Text selbst nennt 4,37 / 4,33
  ([open_asr_leaderboard#118](https://github.com/huggingface/open_asr_leaderboard/pull/118)).
- **Code-Switch:** Die meisten Fehler sind TTS-Artefakte („Kache“ für Cache). Qwen3-ASR erkennt die
  meisten englischen Begriffe (52/82), TheStage und whisper.cpp folgen mit 45. Echte Sprecher fehlen.
  Das ist die größte Lücke dieser Messung.

### 2.4 Auffälligkeiten einzelner Kandidaten [M]

- **TheStage**: Zahlen kommen als Wörter heraus („Port fünftausendeinhundertvierundsiebzig“, „Eighteen
  Fifty Five“). Das Modell wurde offenbar auf ausgeschriebene Referenzen trainiert. Für Dev-Diktate
  (Ports, Versionen) ist das ein Rückschritt. Abhilfe vermutlich über ITN (Rückwandlung in Ziffern) oder
  einen `initial_prompt` mit Ziffern, **nicht getestet**. Ohne `without_timestamps=True` fehlt bei vielen
  kurzen Clips das erste Wort; mit dem Flag ist das komplett behoben. Beim Standard-turbo bringt das
  Flag nichts (CV17 5,74).
- **Parakeet v3**: Die int8-Varianten (onnx-asr und sherpa-onnx) driften mitten im Satz ins Englische
  („ich say your Leben“), weil es keine Sprachvorgabe gibt. fp32 ist stabil, aber auf MLS schwächer als
  turbo.
- **Qwen3-ASR (llama.cpp)**: gibt bei Stille oder Rauschen den Prompt des Servers aus („Transkribe Audio
  zu Text (Sprache: de).“). Schreibt Zahlwörter.
- **primeline turbo-german**: Schweizer Rechtschreibung („weiss“, „Ausserdem“).
- **Voxtral Mini 3B (llama.cpp, Q4_K_M)**: geht nicht in den Transkriptionsmodus und antwortet als
  Chatbot. Lauf abgebrochen.
- **Stille / Rauschen**: Alle anderen Engines liefern bei 5 s Stille und bei Rosa Rauschen leeren Text.
  Alle Whisper-Pfade laufen hinter einem VAD (Sprachaktivitätserkennung).

---

## 3. Marktlage (Primärquellen)

Hauptreferenz für Deutsch ist der Open ASR Leaderboard, Version `02-10-2026`, mit FLEURS-de und
CoVoST-2-de. MLS-de enthält er nicht
([multilingual_de.csv](https://huggingface.co/datasets/hf-audio/multilingual_evals/resolve/54d262667d97d24108560c3b6858713b7eb01ecc/multilingual_de.csv)).
Zahlen verschiedener Quellen nicht mischen, weil Normalizer und Testsatz-Versionen abweichen.

| Modell | Größe | Lizenz | FLEURS-de | CoVoST-de | EN-Mittel | Lauffähig ohne CUDA |
|---|---|---|---|---|---|---|
| whisper-large-v3-turbo (**heute**) | 0,8B | MIT | 3,67 | 8,58 | 6,36 | CT2 CPU, whisper.cpp Vulkan/ROCm, CT2 ≥ 4.7 ROCm, NPU (FastFlowLM) |
| whisper-large-v3 | 1,55B | Apache-2.0 | 3,20 | 4,79 | 5,78 | wie turbo, ~2× langsamer |
| TheStage thewhisper-large-v3-turbo | 0,8B | CC-BY-4.0 | 2,91 | 3,17 | 4,54 | nach Konvertierung CT2/ggml [M: CT2] |
| Parakeet TDT 0.6B v3 | 0,6B | CC-BY-4.0 | 4,16 | 4,07 | 4,86 | onnx-asr / sherpa-onnx (CPU) |
| Canary-1B-v2 | 1B | CC-BY-4.0 | 3,43 | 4,69 | 5,71 | onnx-asr (CPU) |
| Qwen3-ASR-1.7B | 2B | Apache-2.0 | 3,35 | 4,60 | 4,31 | llama.cpp GGUF (CPU/Vulkan) |
| Cohere Transcribe 03-2026 | 2B | Apache-2.0 | 3,33 | **2,87** | 4,67 | sherpa-onnx int8, ~3–4× Echtzeit auf CPU |
| Granite Speech 4.1 2B | 2B | Apache-2.0 | – | ≈3,9 (CV, Diagramm) [V] | 4,62 | llama.cpp GGUF |
| Voxtral Small 24B | 24B | Apache-2.0 | **2,61** | 3,19 | 4,99 | für uns zu groß |
| Voxtral Mini 4B Realtime | 4B | Apache-2.0 | 4,87 | 7,81 | 6,46 | vLLM, natives Streaming |

Alle Werte [LB] außer Granite. Quellen und weitere Kandidaten (Phi-4-multimodal, Meta omniASR, Moonshine
streaming-de, Kyutai ohne Deutsch):
[Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard), Model Cards
[TheStage](https://huggingface.co/TheStageAI/thewhisper-large-v3-turbo),
[Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
[Canary](https://huggingface.co/nvidia/canary-1b-v2),
[Qwen3-ASR-Report](https://arxiv.org/html/2601.21337v1),
[Cohere](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026),
[Granite](https://huggingface.co/ibm-granite/granite-speech-4.1-2b),
[Voxtral Realtime](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602).

Nicht gemessen, aber interessant:

- **Cohere Transcribe** hat den besten CoVoST-de-Wert unter den offenen Modellen. Die eigene Model Card
  warnt aber vor „inconsistent performance on code-switched audio“, und das Modell transkribiert auch
  Geräusche. Auf der CPU ist es nicht schneller als turbo.
- **Granite Speech 4.1** ist das einzige offene Modell mit **Keyword-Biasing über den Prompt** (z. B.
  „Keywords: Rebase, force-with-lease, Worktree“). Das zielt genau auf unser Jargon-Problem. Es läuft
  über llama.cpp, also auch auf Vulkan. **Das ist der nächste Kandidat für eine Messung.**

**Code-Switching Deutsch/Englisch:** AssemblyAI (ein Wettbewerber) misst auf englisch-deutschen
Clips offene Modelle bei 24–27 % WER (Qwen3-ASR 24,9, Voxtral Mini 27,1, Cohere 27,4), die besten
Cloud-Dienste bei 6–13 % [3P] ([assemblyai.com/benchmarks](https://www.assemblyai.com/benchmarks)).
Whisper und Parakeet sind dort nicht dabei. Die Clips wechseln ganze Sätze, unser Fall (englische
Lehnwörter im deutschen Satz) ist milder.

**Cloud zum Vergleich** (nur als Maßstab, wir bleiben lokal): Azure 1,83 / 2,01, AssemblyAI 2,17 / 2,69,
ElevenLabs Scribe v2 2,30 / 2,19 (FLEURS-de / CoVoST-de) [LB].

---

## 4. Hardware-Pfade auf Strix Halo

| Pfad | Status | Befund |
|---|---|---|
| **Vulkan (whisper.cpp, llama.cpp)** | funktioniert, **gemessen** | turbo 0,27–0,55 s pro Clip [M]. Voraussetzung: Systempaket `vulkan-radeon`, das heute nicht installiert ist. whisper.cpp veröffentlicht **keine fertige Linux-Vulkan-Binary** (Release b5130 hat nur ubuntu-x64 für die CPU), also selbst bauen mit `-DGGML_VULKAN=ON`. Ein AUR-Paket `whisper.cpp-vulkan` gibt es nicht |
| ROCm | offiziell für gfx1151, aber nur Ubuntu | AMD listet den Ryzen AI Max 385 / Radeon 8050S (gfx1151) in ROCm als unterstützt, für Ubuntu 24.04/26.04 ([Kompatibilitätsmatrix](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html)). CTranslate2 ≥ 4.7 kann ROCm/HIP ([v4.7.0](https://github.com/OpenNMT/CTranslate2/releases/tag/v4.7.0)), damit könnte theoretisch unser faster-whisper-Server auf die iGPU. Auf Arch nicht unterstützt und nicht gemessen [I] |
| XDNA-2-NPU | auf Linux möglich (FastFlowLM) | turbo auf der NPU: 0,78 s für einen 7,6-s-Clip [3P] ([sleepingrobots](https://sleepingrobots.com/dreams/lemonade-server-npu-strix-halo/)). Das ist nicht schneller als unser Vulkan-Wert (0,33 s für 10 s), und es laufen nur Modelle aus dem FLM-Katalog, keine Fine-Tunes. Vorteil wäre nur der Stromverbrauch [I] |
| ONNX auf der iGPU | nicht möglich | onnxruntime hat keinen Vulkan-EP. Parakeet und Canary laufen hier nur auf der CPU [M] |

---

## 5. iOS-App

- Die App nutzt Apples **SpeechAnalyzer** (iOS 26) für die Vorschau und den Server für den finalen Text,
  mit Apples Text als Fallback pro Clip (siehe Abschnitt 1).
- **Unabhängige Werte für Deutsch gibt es nicht.** Auf Englisch liegt SpeechAnalyzer etwa auf Höhe von
  Whisper small/medium und unter turbo, z. B. Argmax OpenBench earnings22: SpeechAnalyzer 17 vs. turbo
  15,4 [3P] ([OpenBench](https://github.com/argmaxinc/OpenBench/blob/main/BENCHMARKS.md)). Eigenes
  Vokabular unterstützt es laut derselben Quelle nicht. Ein App-Anbieter nennt 6,7 % auf deutscher
  Vorlesesprache, Methodik unklar
  ([Dictato](https://dicta.to/blog/speech-to-text-engine-comparison-mac-2026/)).
- **Folgerung [I]:** Das Server-Finale bleibt für Deutsch die bessere Wahl. Mit Vulkan wäre es nach dem
  Loslassen in ~0,3–0,6 s statt ~2 s fertig, weit unter dem 25-s-Timeout. Die App hat pro Clip schon
  beide Transkripte (Apple und Server). Wer die Lücke an echten Diktaten messen will, kann diese Paare
  protokollieren. Das wäre Core-Arbeit, und dabei ist der Datenschutz zu beachten.
- On-Device-Alternativen, falls jemals ein Finale ohne Server nötig wird:
  [WhisperKit](https://github.com/argmaxinc/WhisperKit) (MIT) und
  [FluidAudio](https://github.com/FluidInference/FluidAudio) (Parakeet v3 auf der Neural Engine,
  Apache-2.0). Heute nicht nötig.

---

## 6. Optionen

Konvention im Repo (`CLAUDE.md`): Alles, was UI oder Core-Hooks braucht, wird ein Core-Issue. Der
Server selbst (`whisper-stt`) liegt außerhalb dieses Repos, er ist Betrieb auf dem Host.

| | Option | Wo | Nutzen | Aufwand / Risiko |
|---|---|---|---|---|
| **1** | **turbo auf whisper.cpp + Vulkan** | Host-Betrieb + Plugin | 5–7× schneller, gleiche Genauigkeit. Vorschau in ~0,3 s statt ~2 s | `vulkan-radeon` installieren (sudo), whisper.cpp mit Vulkan bauen, `whisper-server` als Dienst. **Contract-Lücke:** `whisper-server` beantwortet `/transcribe` über `--inference-path`, aber sein `/health` hat kein `ready`/`model`. Entweder ein kleiner Shim davor oder das Plugin lernt den whisper.cpp-Contract (bisher ausdrücklich ausgeschlossen, offen in #1 Teil b). `--convert` nimmt webm/mp4 über ffmpeg an. Die iGPU wird mit dem Desktop geteilt |
| **2** | **TheStage-Gewichte im bestehenden `server.py`** | nur Host-Betrieb | genauer, besonders bei kurzen Clips und Englisch | einmal nach CT2 konvertieren, `--model` umstellen, `without_timestamps=True` setzen. **Zahlen als Wörter** müssen vorher gelöst oder akzeptiert werden. CC-BY-4.0 verlangt Namensnennung |
| **3** | **1 + 2 kombiniert**: TheStage-Gewichte als ggml auf Vulkan | Host-Betrieb | beides: schnell und genau | **nicht gemessen**. Konvertierung über whisper.cpp `models/convert-h5-to-ggml.py`, Verhalten ohne Timestamps dort prüfen |
| 4 | OpenAI-kompatibler Client-Modus im Plugin (`/v1/audio/transcriptions`) | Plugin (#1 Teil b) | eine Änderung öffnet speaches, llama-server (Qwen3-ASR, Granite), FastFlowLM (NPU) und vLLM, ohne Code pro Engine | mittel. Passt zur Richtung von erwins-enkel/shepherd#1453 |
| 5 | Granite Speech 4.1 mit Keyword-Liste messen | Recherche | könnte genau das Jargon-Problem lösen | ungemessen. Braucht Option 4 oder einen Shim |
| 6 | Eigener Testsatz aus echten Shepherd-Prompts (50–100 Clips) | Recherche/Betrieb | einziger belastbarer Vergleich für unseren Fall | Aufnahmen nötig. Die iOS-App könnte Paare liefern (siehe Abschnitt 5) |
| – | Parakeet, Canary, Qwen3-ASR, primeline, Voxtral, Whistle | – | auf diesem Host nicht besser | siehe Abschnitt 2.4 |

**Empfohlene Reihenfolge:** 1 → 3 (gegen echte Diktate, mit Fokus auf Zahlen) → 6, parallel 4 als
Grundlage für 5.

**Bezug zu bestehenden Issues:** #14 (One-Click-Install whisper.cpp, CPU) bleibt richtig mit
`ggml-small`. turbo-q5 auf der CPU braucht ~5 s pro Clip und ist als optionales Modell dort fragwürdig.
Eine Vulkan-Variante lässt sich nicht als fertige Binary laden. #15 (WAV ohne ffmpeg) und
erwins-enkel/shepherd#2724 (Web-Finale als WAV) sind unabhängig vom Modell.

---

## 7. Grenzen dieser Untersuchung

- **Kleine Testsätze** (CV17: 209 Wörter, also 1 Fehler = 0,48 Prozentpunkte). Einzelne Differenzen
  unter ~1 Punkt sind Rauschen.
- **Kein echtes Diktat:** Vorlesesprache aus Hörbüchern und Common Voice, Code-Switch nur über
  TTS. Das Format von Pfaden und Flags (`origin/main`, `--force-with-lease`) misst WER gar nicht.
- **Geteilter Host** mit stark schwankender Last. Latenzen sind Mediane aus Phasen, in denen jeweils nur
  eine Engine lief.
- **Nicht gemessen:** Kombination aus Option 1 und 2, Granite, Cohere, Voxtral Realtime, NPU, ROCm,
  FLEURS-de (über den HF-Datasets-Server nicht abrufbar), Kaltstart des laufenden Servers (der wurde
  bewusst nicht neu gestartet).
- Die Rohdaten (alle Transkripte, Zeiten pro Clip, Load) und das Mess-Harness lagen im
  Session-Scratchpad und sind nicht Teil des Repos. Die Befehle unten reichen zum Nachstellen.

## 8. Nachstellen (Kurzform)

```sh
# whisper.cpp mit Vulkan (Vulkan-Headers ggf. lokal klonen; Systempaket vulkan-radeon nötig)
cmake -B build -DGGML_VULKAN=ON -DGGML_NATIVE=ON && cmake --build build -j
build/bin/whisper-server -m ggml-large-v3-turbo.bin -l de -bs 5 -t 8 -nt \
  --vad -vm ggml-silero-v5.1.2.bin --convert --inference-path /transcribe --host 127.0.0.1 --port 9890

# TheStage-Gewichte für faster-whisper
ct2-transformers-converter --model TheStageAI/thewhisper-large-v3-turbo \
  --revision 5ce95e7a5890cb2191c5c783d8f818f799930705 --output_dir thestage-turbo-ct2 --quantization int8
# tokenizer.json + preprocessor_config.json aus dem turbo-Snapshot daneben kopieren
# in server.py: model.transcribe(..., beam_size=5, vad_filter=True, without_timestamps=True)
```

Modelle: `ggerganov/whisper.cpp` `ggml-large-v3-turbo.bin` (SHA256 `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`),
`ggml-org/whisper-vad` `ggml-silero-v5.1.2.bin`, `TheStageAI/thewhisper-large-v3-turbo` @ `5ce95e7a`,
`istupakov/parakeet-tdt-0.6b-v3-onnx` @ `8f23f0c0`, `istupakov/canary-1b-v2-onnx` @ `5ebc1520`,
`ggml-org/Qwen3-ASR-1.7B-GGUF` (Q8_0).
