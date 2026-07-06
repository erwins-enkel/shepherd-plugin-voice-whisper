# CLAUDE.md — shepherd-plugin-voice-whisper

## Repo split

This plugin is the server-side transcription ENGINE only (routes `transcribe`/`status`).
Plugins render declarative views into host-defined slots only — this repo itself renders
key-value rows and an action-button into the `settings-panel` slot — and cannot run browser
JS (`getUserMedia`/`MediaRecorder`). There is no slot at arbitrary text fields, so mic
buttons, audio capture, and live preview live in Shepherd core (`erwins-enkel/shepherd`,
e.g. `ui/src/lib/components/ComposeBar.svelte`). Concretely: the mic button for the
New Task prompt field shipped as core work via erwins-enkel/shepherd#1433 (merged as core
PR #1454) — it could never appear as a diff in this repo, whose `transcribe`/`status`
routes serve it unchanged.

## Convention: core gaps become core issues

When a feature needs something this plugin cannot provide (a UI surface, a new core hook,
a capability contract), do NOT work around it here. Instead file a GitHub issue in
`erwins-enkel/shepherd` carrying the full technical plan, and design the ask
plugin-agnostically: core should gain a generic capability (e.g. "a transcription plugin"),
not a `voice-whisper` special case — other users may build different or richer voice plugins.

Tracked exception: the New-Task MicButton MVP (core issue erwins-enkel/shepherd#1433,
shipped via core PR #1454) deliberately extends the existing `voice-whisper`-specific
seam in core's `ui/src/lib/api.ts`; the generic transcription-capability contract is
tracked in erwins-enkel/shepherd#1453.
