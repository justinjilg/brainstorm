import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Audio transcription via OpenAI Whisper API or local whisper.cpp.
 *
 * Supports two backends:
 * 1. Cloud: OpenAI Whisper API (requires OPENAI_API_KEY)
 * 2. Local: whisper.cpp binary (no API key needed)
 */
export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs: number;
}

export type WhisperBackend = 'cloud' | 'local';

/**
 * Detect available Whisper backend.
 * Prefers local whisper.cpp if available, falls back to cloud.
 */
export function detectBackend(): WhisperBackend | null {
  // Check for local whisper.cpp
  try {
    execFileSync('whisper', ['--help'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    return 'local';
  } catch {
    // Not found
  }

  // Check for cloud API key
  if (process.env.OPENAI_API_KEY || process.env.BRAINSTORM_API_KEY) {
    return 'cloud';
  }

  return null;
}

/**
 * Transcribe an audio file using the specified backend.
 */
export async function transcribe(audioPath: string, backend: WhisperBackend): Promise<TranscriptionResult> {
  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const start = Date.now();

  if (backend === 'local') {
    return transcribeLocal(audioPath, start);
  } else {
    return transcribeCloud(audioPath, start);
  }
}

/**
 * Transcribe using local whisper.cpp.
 */
function transcribeLocal(audioPath: string, startTime: number): TranscriptionResult {
  try {
    const output = execFileSync('whisper', [
      '--model', 'base',
      '--language', 'en',
      '--output-txt',
      '--no-timestamps',
      audioPath,
    ], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // whisper.cpp outputs to stdout or a .txt file
    const text = output.trim() || readWhisperOutput(audioPath);

    return {
      text: text || '(no speech detected)',
      language: 'en',
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    throw new Error(`Local transcription failed: ${err.message}`);
  }
}

/**
 * Transcribe using OpenAI Whisper API.
 */
async function transcribeCloud(audioPath: string, startTime: number): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.BRAINSTORM_API_KEY;
  if (!apiKey) {
    throw new Error('No API key for cloud transcription. Set OPENAI_API_KEY or BRAINSTORM_API_KEY.');
  }

  const audioData = readFileSync(audioPath);
  const formData = new FormData();
  formData.append('file', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Whisper API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json() as { text: string };

  return {
    text: result.text || '(no speech detected)',
    language: 'en',
    durationMs: Date.now() - startTime,
  };
}

/**
 * Read whisper.cpp output from companion .txt file.
 */
function readWhisperOutput(audioPath: string): string {
  const txtPath = audioPath.replace(/\.wav$/, '.txt');
  if (existsSync(txtPath)) {
    return readFileSync(txtPath, 'utf-8').trim();
  }
  return '';
}
