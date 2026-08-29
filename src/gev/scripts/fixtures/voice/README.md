# Voice QA fixture

`full-globe-turn-on-radio.wav` is an owner-generated fake-microphone fixture for the credentialed AI-to-Radio acceptance test. Its embedded WAV metadata is the provenance record for the generator, model, voice, spoken text, usage terms, and audio settings; inspect it with `ffprobe -show_entries format_tags -of json scripts/fixtures/voice/full-globe-turn-on-radio.wav`.

- Provided and approved for repository QA use by the user on 2026-08-05.
- SHA-256: `b57af70db1922b72fec2c6c58348ccd3309e10aa1e8edec2890277dff26cc7bb`
- Run: `node scripts/qa-voice-wav.mjs http://localhost:4189`
