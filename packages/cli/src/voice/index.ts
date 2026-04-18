import { AudioRecorder } from "./recorder.js";
import {
  detectBackend,
  transcribe,
  type TranscriptionResult,
  type WhisperBackend,
} from "./transcriber.js";

/**
 * Voice input manager for Brainstorm CLI.
 *
 * Push-to-talk: press a key to start recording, release to transcribe.
 * Requires either sox (recording) + whisper.cpp (local) or sox + OpenAI API key (cloud).
 */
export class VoiceInput {
  private recorder: AudioRecorder;
  private backend: WhisperBackend | null;

  constructor() {
    this.recorder = new AudioRecorder();
    this.backend = detectBackend();
  }

  /** Check if voice input is available. */
  isAvailable(): boolean {
    return AudioRecorder.isAvailable() && this.backend !== null;
  }

  /** Get the active transcription backend. */
  getBackend(): WhisperBackend | null {
    return this.backend;
  }

  /** Start recording audio. */
  startRecording(): void {
    this.recorder.start();
  }

  /** Stop recording and transcribe. Returns the transcribed text. */
  async stopAndTranscribe(): Promise<TranscriptionResult> {
    if (!this.backend) {
      throw new Error(
        "No transcription backend available. Install whisper.cpp or set OPENAI_API_KEY.",
      );
    }

    const audioPath = await this.recorder.stop();
    return transcribe(audioPath, this.backend);
  }

  /** Check if currently recording. */
  isRecording(): boolean {
    return this.recorder.isRecording();
  }

  /** Get a status string for display. */
  getStatusString(): string {
    if (!this.isAvailable()) {
      return "Voice: unavailable (need sox + whisper)";
    }
    if (this.isRecording()) {
      return "Voice: recording... (release to send)";
    }
    return `Voice: ready (${this.backend})`;
  }
}

export { AudioRecorder } from "./recorder.js";
export {
  detectBackend,
  transcribe,
  type TranscriptionResult,
  type WhisperBackend,
} from "./transcriber.js";
export {
  analyzeVoiceSentiment,
  type VoiceSentimentResult,
} from "./voice-sentiment.js";
