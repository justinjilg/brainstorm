import { detectTone, type ToneResult, type UserTone } from "@brainst0rm/core";
import type { TranscriptionResult } from "./transcriber.js";

/**
 * Combined voice + text sentiment analysis.
 *
 * Augments text-based tone detection with voice signal heuristics:
 * - Fast transcription + short text → urgent
 * - Long pause before speaking → exploring/deliberate
 * - Very short utterance → frustrated (if preceded by corrections)
 */

export interface VoiceSentimentResult extends ToneResult {
  /** Raw text tone. */
  textTone: ToneResult;
  /** Voice signal adjustments applied. */
  voiceSignals: string[];
}

/**
 * Analyze combined voice + text sentiment.
 *
 * @param transcription - The transcription result from Whisper
 * @param recentMessages - Recent user messages for text-based tone detection
 */
export function analyzeVoiceSentiment(
  transcription: TranscriptionResult,
  recentMessages: string[],
): VoiceSentimentResult {
  // Start with text-based tone detection (includes the transcribed text)
  const allMessages = [...recentMessages, transcription.text];
  const textTone = detectTone(allMessages);

  const voiceSignals: string[] = [];
  let adjustedTone = textTone.tone;
  let adjustedConfidence = textTone.confidence;

  // Voice signal: very short utterance (< 5 words) suggests urgency or frustration
  const wordCount = transcription.text.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3 && wordCount > 0) {
    voiceSignals.push("very-short-utterance");
    // Short commands often indicate urgency
    if (textTone.tone === "calm") {
      adjustedTone = "urgent";
      adjustedConfidence = Math.max(adjustedConfidence, 0.5);
    }
  }

  // Voice signal: fast speech (short duration for many words)
  const wordsPerSecond =
    wordCount / Math.max(transcription.durationMs / 1000, 0.1);
  if (wordsPerSecond > 3.5 && wordCount > 5) {
    voiceSignals.push("fast-speech");
    if (textTone.tone === "calm") {
      adjustedTone = "urgent";
      adjustedConfidence = Math.max(adjustedConfidence, 0.4);
    }
  }

  // Voice signal: slow/deliberate speech (many words, slow pace)
  if (wordsPerSecond < 1.5 && wordCount > 8) {
    voiceSignals.push("deliberate-speech");
    if (textTone.tone === "calm") {
      adjustedTone = "exploring";
      adjustedConfidence = Math.max(adjustedConfidence, 0.3);
    }
  }

  // Voice signal: long transcription with questions
  if (transcription.text.includes("?") && wordCount > 10) {
    voiceSignals.push("detailed-question");
    if (textTone.tone !== "frustrated") {
      adjustedTone = "exploring";
      adjustedConfidence = Math.max(adjustedConfidence, 0.4);
    }
  }

  return {
    tone: adjustedTone,
    confidence: adjustedConfidence,
    textTone,
    voiceSignals,
  };
}
