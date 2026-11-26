#!/usr/bin/env node
// Generate the 5 ritual voice variants using ElevenLabs.
//
// Round 38 architecture: chunked generation + real silences.
// Previously we used SSML <break time="N" /> tags inside one big API
// call. ElevenLabs caps each break at ~3s, and chained breaks didn't
// produce the deep meditation silences the user was after.
//
// New approach:
//   1. The script is an array of {text, silenceAfter} chunks.
//   2. Each chunk gets its own ElevenLabs call → MP3.
//   3. ffmpeg generates the requested silence (44.1kHz mono AAC).
//   4. ffmpeg concatenates: chunk1 | silence1 | chunk2 | silence2 | …
//   5. afconvert ensures the final file is a real AAC M4A.
//
// Result: pauses are EXACTLY the length we want (3-15s), the speech
// runs cleanly inside each chunk without weird SSML artefacts, and
// the total runtime grows to a proper meditation length (~3 min).
//
// Usage:
//   cd mobile && node scripts/generate-ritual-voices.mjs
//
// Requires:
//   – Node 18+ (built-in fetch)
//   – ffmpeg (for silence + concat)
//   – afconvert (macOS, for final AAC M4A wrap)
//   – ELEVENLABS_API_KEY in mobile/.env

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── load .env ──────────────────────────────────────────────
async function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (err) {
    console.warn(`[warn] could not load .env: ${err.message}`);
  }
}
await loadEnv();

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error('ELEVENLABS_API_KEY not found in process env or mobile/.env');
  process.exit(1);
}

// ── the script as phrase chunks ────────────────────────────
// R39 rewrite:
//   • Third-person "they" replaced with direct second-person "you" —
//     the user becomes the future self, not an observer of them.
//   • "write what is true today" → "write your intention for today" —
//     clearer, matches the data field name (intentionText) and the
//     "Anchor it" framing on the next screen.
//
// Each chunk: clean speech (no SSML), then a precise silence.
// Silences sized for meditation pacing — multi-second breathing
// spaces at every meaningful transition. Total estimated runtime
// ~180s (3 minutes).
// R55: silences trimmed ~30-40% after first device test felt draggy.
// Old durations (2-13s) → new durations (2-8s). Estimated total runtime
// drops from ~2:49 → ~2:00. Still meditative pacing, less waiting.
const SCRIPT_CHUNKS_DAILY = [
  { text: 'Welcome back.', silenceAfter: 3 },
  { text: 'Take a moment.', silenceAfter: 2 },
  { text: 'Let your shoulders fall.', silenceAfter: 2 },
  { text: 'Let whatever happened before this moment, go quiet.', silenceAfter: 3 },
  { text: "You don't need to do anything yet.", silenceAfter: 3 },
  { text: 'Breathe in, slowly.', silenceAfter: 3 },
  { text: 'And out.', silenceAfter: 3 },
  { text: 'Again. In.', silenceAfter: 3 },
  { text: 'And out.', silenceAfter: 4 },
  { text: 'Each breath, settling you deeper into here.', silenceAfter: 3 },
  { text: "Now, picture yourself, already living what you're becoming.", silenceAfter: 3 },
  { text: 'Not someday. See yourself now.', silenceAfter: 3 },
  { text: 'What are you wearing?', silenceAfter: 3 },
  { text: 'Where are you standing?', silenceAfter: 3 },
  { text: 'Who is around you?', silenceAfter: 3 },
  { text: 'What does the room look like?', silenceAfter: 4 },
  { text: 'How are you holding yourself?', silenceAfter: 3 },
  { text: 'What does your face say?', silenceAfter: 4 },
  { text: "This isn't a fantasy. This is already real.", silenceAfter: 2 },
  { text: 'This is you. Already.', silenceAfter: 5 },
  { text: "Now, write today's intention. Use 'I am', like an affirmation.", silenceAfter: 8 },
  { text: 'You are becoming.', silenceAfter: 2 },
  { text: 'Carry this with you.', silenceAfter: 2 },
];

// R74/R76: four additional ritual scripts in the Visora voice (second
// person, contemplative, "who you want to become" not "becoming"). Run
// with `--variant=N` to generate only one. Daily uses Lily (default
// catalog); Threshold / Practice / Anchor / Manifest use Milo (shared
// Voice Library voice — must be added to the user's ElevenLabs account
// from the share URL before the API will accept it, and some plans
// require an upgrade to use Voice Library voices via API).
const MILO_VOICE_ID = 'GUDYcgRAONiI1nXDcNQQ';

const SCRIPT_CHUNKS_THRESHOLD = [
  { text: 'Take a moment.', silenceAfter: 3 },
  { text: 'You are standing in a doorway.', silenceAfter: 4 },
  { text: 'Behind you is who you have been.', silenceAfter: 3 },
  { text: 'Every choice. Every habit. Every story.', silenceAfter: 4 },
  { text: 'In front of you is who you want to become.', silenceAfter: 4 },
  { text: 'You do not have to leave the past behind. Just stop carrying it.', silenceAfter: 5 },
  { text: 'Breathe in.', silenceAfter: 3 },
  { text: 'And out.', silenceAfter: 3 },
  { text: 'Picture the person on the other side of the doorway.', silenceAfter: 3 },
  { text: 'What do they look like, on a Tuesday afternoon?', silenceAfter: 4 },
  { text: 'How do they move through small moments?', silenceAfter: 3 },
  { text: 'What do they no longer argue with?', silenceAfter: 4 },
  { text: 'What do they say yes to, without flinching?', silenceAfter: 4 },
  { text: 'The doorway is not a leap. It is a step.', silenceAfter: 3 },
  { text: 'Today you take one step.', silenceAfter: 4 },
  { text: "Now, write today's intention. Use 'I am'.", silenceAfter: 8 },
  { text: 'The threshold is yours.', silenceAfter: 2 },
  { text: 'Carry this with you.', silenceAfter: 2 },
];

const SCRIPT_CHUNKS_PRACTICE = [
  { text: 'Welcome back.', silenceAfter: 3 },
  { text: 'No fanfare. Just here, again.', silenceAfter: 4 },
  { text: 'This is the practice.', silenceAfter: 3 },
  { text: 'You showing up. Again. And again.', silenceAfter: 4 },
  { text: 'Breathe in.', silenceAfter: 3 },
  { text: 'And out.', silenceAfter: 3 },
  { text: 'The person you want to become is not built in a single day.', silenceAfter: 4 },
  { text: 'They are built in mornings like this one.', silenceAfter: 4 },
  { text: 'A small choice. A quiet act. Then another.', silenceAfter: 5 },
  { text: 'Picture them now. The person you want to become.', silenceAfter: 3 },
  { text: 'What do they do, when no one is watching?', silenceAfter: 4 },
  { text: 'What do they keep showing up for?', silenceAfter: 4 },
  { text: 'What did they decide a long time ago, that you can decide today?', silenceAfter: 5 },
  { text: 'You are not behind. You are mid practice.', silenceAfter: 4 },
  { text: "Now, write today's intention. Use 'I am'.", silenceAfter: 8 },
  { text: 'One day at a time, this is how it happens.', silenceAfter: 2 },
  { text: 'Carry this with you.', silenceAfter: 2 },
];

const SCRIPT_CHUNKS_ANCHOR = [
  { text: 'Take a moment.', silenceAfter: 3 },
  { text: 'Feel your feet, or your seat. Wherever you meet the ground.', silenceAfter: 4 },
  { text: 'Notice the weight of you. Real, here.', silenceAfter: 4 },
  { text: 'The body is the anchor.', silenceAfter: 3 },
  { text: 'When the mind drifts, this is what brings you back.', silenceAfter: 4 },
  { text: 'Breathe in. Feel the chest rise.', silenceAfter: 3 },
  { text: 'And out. Feel it fall.', silenceAfter: 4 },
  { text: 'Soften the jaw.', silenceAfter: 3 },
  { text: 'Soften the space between your eyes.', silenceAfter: 3 },
  { text: 'Let the hands rest, open.', silenceAfter: 4 },
  { text: 'Now picture the person you want to become.', silenceAfter: 3 },
  { text: 'How do they hold their body in a long meeting?', silenceAfter: 4 },
  { text: 'How do they breathe, when something difficult arrives?', silenceAfter: 4 },
  { text: 'How do they walk into a room?', silenceAfter: 4 },
  { text: 'The future self is not just a mind. It is a body that knows itself.', silenceAfter: 4 },
  { text: 'You are training that body now.', silenceAfter: 4 },
  { text: "Now, write today's intention. Use 'I am'.", silenceAfter: 8 },
  { text: 'You are here.', silenceAfter: 2 },
  { text: 'Carry this with you.', silenceAfter: 2 },
];

const SCRIPT_CHUNKS_MANIFEST = [
  { text: 'Take a moment.', silenceAfter: 3 },
  { text: 'Let your shoulders fall.', silenceAfter: 3 },
  { text: 'Close your eyes, if it helps.', silenceAfter: 4 },
  { text: 'Picture the version of you that you want to become.', silenceAfter: 4 },
  { text: 'Not a fantasy. Not perfect. Just the truest version.', silenceAfter: 4 },
  { text: 'See them clearly.', silenceAfter: 5 },
  { text: 'Where do they live?', silenceAfter: 3 },
  { text: 'How do they spend a Wednesday?', silenceAfter: 4 },
  { text: 'What does their voice sound like, when they speak gently to themselves?', silenceAfter: 4 },
  { text: 'What have they let go of, that you still carry?', silenceAfter: 5 },
  { text: 'What have they built, slowly, that you have only begun?', silenceAfter: 5 },
  { text: 'Breathe in.', silenceAfter: 3 },
  { text: 'And out.', silenceAfter: 3 },
  { text: 'The distance between you and them is not as far as it feels.', silenceAfter: 4 },
  { text: 'They are not waiting in the future. They are here, in the choice you make next.', silenceAfter: 5 },
  { text: 'Speak it now, quietly. Say who you want to become.', silenceAfter: 5 },
  { text: 'I am the one who.', silenceAfter: 5 },
  { text: 'Finish that sentence.', silenceAfter: 4 },
  { text: "Now, write today's intention. Use 'I am'.", silenceAfter: 8 },
  { text: 'You are calling them forward. They are answering.', silenceAfter: 2 },
  { text: 'Carry this with you.', silenceAfter: 2 },
];

// ── voice mapping ──────────────────────────────────────────
// R55: switched off Daniel ("Steady Broadcaster" — too newsreader-y for
// meditation) to Lily — warm British female from the default catalog.
// (Originally we tried a Voice Library voice but ElevenLabs free plans
// can't use those via API. Lily is a default voice, no plan upgrade
// needed, and was in the pre-R46 voice rotation.)
//
// Each VARIANT can specify EITHER `voiceId` (direct, no name lookup —
// required for Voice Library voices) OR `voiceName` (looked up via the
// /voices API — works for default voices in any account).
const VARIANTS = [
  { index: 1, day: 'Daily',     voiceName: 'Lily',          outFile: 'ritual.m4a',           chunks: SCRIPT_CHUNKS_DAILY },
  { index: 2, day: 'Threshold', voiceId: MILO_VOICE_ID,     voiceLabel: 'Milo', outFile: 'ritual-threshold.m4a', chunks: SCRIPT_CHUNKS_THRESHOLD },
  { index: 3, day: 'Practice',  voiceId: MILO_VOICE_ID,     voiceLabel: 'Milo', outFile: 'ritual-practice.m4a',  chunks: SCRIPT_CHUNKS_PRACTICE },
  { index: 4, day: 'Anchor',    voiceId: MILO_VOICE_ID,     voiceLabel: 'Milo', outFile: 'ritual-anchor.m4a',    chunks: SCRIPT_CHUNKS_ANCHOR },
  { index: 5, day: 'Manifest',  voiceId: MILO_VOICE_ID,     voiceLabel: 'Milo', outFile: 'ritual-manifest.m4a',  chunks: SCRIPT_CHUNKS_MANIFEST },
];

// ── ElevenLabs helpers ─────────────────────────────────────
async function fetchVoices() {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': API_KEY },
  });
  if (!res.ok) {
    throw new Error(`voices fetch failed: ${res.status} — ${await res.text()}`);
  }
  const data = await res.json();
  return data.voices ?? [];
}

function findVoiceId(voices, name) {
  const target = name.toLowerCase();
  let v = voices.find((x) => x.name === name);
  if (v) return v.voice_id;
  v = voices.find((x) => x.name?.toLowerCase() === target);
  if (v) return v.voice_id;
  v = voices.find((x) => {
    const first = x.name?.split(/[\s\-—]+/)[0]?.toLowerCase();
    return first === target;
  });
  if (v) return v.voice_id;
  v = voices.find((x) => x.name?.toLowerCase().startsWith(target));
  return v?.voice_id;
}

async function generateChunk(voiceId, text, outPath) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        // R55 tuning for soothing meditation:
        //  • stability lowered 0.85 → 0.60 — adds natural emotional
        //    variation, less monotone-newsreader.
        //  • style raised 0.0 → 0.35 — adds breathy expressiveness,
        //    the "speaking close to you" intimacy that meditation apps
        //    use. Higher style values can make the voice too dramatic;
        //    0.35 is a gentle nudge.
        //  • speed stays at 0.7 (ElevenLabs API minimum). Slowness
        //    comes from pace + the inter-chunk silences below.
        stability: 0.60,
        similarity_boost: 0.85,
        style: 0.35,
        use_speaker_boost: true,
        speed: 0.7,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`chunk generation failed: ${res.status} — ${await res.text()}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(outPath, Buffer.from(arrayBuffer));
}

function silenceFile(workDir, seconds) {
  // Pre-generate one silence file per unique duration so we don't
  // run ffmpeg redundantly. 44.1kHz mono MP3 to match ElevenLabs output.
  const filename = path.join(workDir, `silence-${seconds}s.mp3`);
  return { filename, seconds };
}

async function ensureSilenceFile(filename, seconds) {
  try {
    await fs.stat(filename);
    return; // already exists
  } catch {
    // create it
  }
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=r=44100:cl=mono`,
    '-t', String(seconds),
    '-acodec', 'libmp3lame',
    '-b:a', '128k',
    filename,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// ── per-variant generation ─────────────────────────────────
async function generateVariant(variantIndex, voiceId, voiceLabel, finalOutPath, chunks) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `ritual-${variantIndex}-`));

  try {
    // 1. Generate all speech chunks
    const chunkFiles = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(workDir, `chunk-${String(i).padStart(2, '0')}.mp3`);
      await generateChunk(voiceId, chunks[i].text, chunkPath);
      chunkFiles.push({ path: chunkPath, silenceAfter: chunks[i].silenceAfter });
    }

    // 2. Generate silence files for each unique duration
    const uniqueSilences = [...new Set(chunks.map((c) => c.silenceAfter))];
    const silenceMap = new Map();
    for (const seconds of uniqueSilences) {
      const { filename } = silenceFile(workDir, seconds);
      await ensureSilenceFile(filename, seconds);
      silenceMap.set(seconds, filename);
    }

    // 3. Build the concat list: chunk1, silence1, chunk2, silence2, ...
    const listPath = path.join(workDir, 'concat.txt');
    const lines = [];
    for (const { path: chunkPath, silenceAfter } of chunkFiles) {
      lines.push(`file '${chunkPath.replace(/'/g, "'\\''")}'`);
      const silPath = silenceMap.get(silenceAfter);
      if (silPath) {
        lines.push(`file '${silPath.replace(/'/g, "'\\''")}'`);
      }
    }
    await fs.writeFile(listPath, lines.join('\n'));

    // 4. ffmpeg concat + post-processing → MP3
    // R55: added a soothing filter chain. Previously we just did `-c copy`
    // which preserved the raw ElevenLabs output as-is. Now we re-encode
    // through these filters:
    //   • lowpass=f=7000 — softens harsh sibilants (s/sh/t) above 7kHz
    //   • equalizer 300Hz +2dB — small low-mid warmth boost (vocal body)
    //   • acompressor 2:1 — gentle dynamic evenness, smooths out peaks
    //     without flattening; long attack/release keeps it natural
    //   • volume 0.92 — slight headroom so the final M4A never clips
    const concatMp3 = path.join(workDir, 'concat.mp3');
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-af', [
        'lowpass=f=7000',
        'equalizer=f=300:width_type=h:width=200:g=2',
        'acompressor=threshold=0.05:ratio=2:attack=200:release=1000',
        'volume=0.92',
      ].join(','),
      '-acodec', 'libmp3lame',
      '-b:a', '128k',
      concatMp3,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // 5. afconvert → AAC M4A (so expo-av plays it cleanly on iOS).
    //    Same step we used in R28 when MP3-as-.m4a failed on device.
    execFileSync('afconvert', [
      '-f', 'm4af',
      '-d', 'aac@44100',
      concatMp3,
      finalOutPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const { size } = await fs.stat(finalOutPath);
    return size;
  } finally {
    // Clean up temp dir
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── main ───────────────────────────────────────────────────
async function main() {
  // CLI: `--variant=4` regenerates ONLY variant 4. Useful for
  // targeted fixes without burning credits on the other four.
  const variantArg = process.argv.find((a) => a.startsWith('--variant='));
  const variantFilter = variantArg ? Number(variantArg.split('=')[1]) : null;
  const variantsToRun = variantFilter
    ? VARIANTS.filter((v) => v.index === variantFilter)
    : VARIANTS;
  if (variantFilter && variantsToRun.length === 0) {
    console.error(`No variant with index ${variantFilter}. Valid: ${VARIANTS.map((v) => v.index).join(', ')}`);
    process.exit(1);
  }

  const audioDir = path.join(__dirname, '..', 'assets', 'audio', 'ritual');
  await fs.mkdir(audioDir, { recursive: true });

  console.log('Fetching voice library...');
  const voices = await fetchVoices();
  console.log(`  found ${voices.length} voice(s) in your account`);

  for (const v of variantsToRun) {
    const runtime =
      v.chunks.reduce((sum, c) => sum + c.silenceAfter, 0) +
      Math.round(v.chunks.reduce((sum, c) => sum + c.text.length, 0) * 0.07);
    console.log(`  • ${v.day}: ${v.chunks.length} chunks, ~${runtime}s`);
  }
  console.log('');

  if (variantFilter) {
    console.log(`Regenerating only variant ${variantFilter} (--variant flag).\n`);
  }

  let ok = 0;
  let failed = 0;
  for (const variant of variantsToRun) {
    // R55: support direct voiceId (for Voice Library voices) OR
    // voiceName (looked up in account voices via /voices API).
    const id = variant.voiceId ?? findVoiceId(voices, variant.voiceName);
    const label = variant.voiceLabel ?? variant.voiceName ?? variant.voiceId;
    if (!id) {
      console.warn(`  ⚠ variant ${variant.index} (${label}) not found — skipping`);
      failed++;
      continue;
    }
    // R46: `outFile` is configurable per-variant. For MVP there's just
    // one (`ritual.m4a`) — future voices can pick their own filename
    // (e.g. `ritual-evening.m4a`) without touching the engine code.
    const outPath = path.join(audioDir, variant.outFile);
    process.stdout.write(
      `  → ${variant.outFile} (${variant.day} · ${label})... `,
    );
    try {
      const size = await generateVariant(variant.index, id, label, outPath, variant.chunks);
      console.log(`✓ ${(size / 1024).toFixed(1)} KB`);
      ok++;
    } catch (err) {
      console.log('✗');
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${ok} generated, ${failed} skipped/failed.`);
  if (ok > 0) {
    console.log('Reload Expo Go (fully kill + reopen) to hear the new voices.');
  }
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
