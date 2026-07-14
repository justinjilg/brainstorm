/**
 * Phase 7 — tool-use enforcement.
 *
 * Weak models (especially some BR-routed open models) frequently NARRATE a
 * tool action in prose — "Let me read config.ts", "I'll search for the
 * handler" — and then STOP without ever emitting a real function call. The
 * agentic loop sees zero tool calls and a normal `finishReason === "stop"`,
 * so it records the turn as a success and completes, leaving the user with an
 * assistant that described work it never did.
 *
 * This module supplies the two pure pieces the loop needs to correct that:
 *   1. `detectNarratedToolIntent` — a CONSERVATIVE detector that decides
 *      whether a no-tool-call turn's text looks like an un-acted tool intent.
 *   2. `buildToolUseCorrection` — the user-role nudge fed back so the model
 *      re-emits the action as an actual function call.
 *
 * Design constraint (see loop.ts integration): false positives are costly — a
 * legitimate plain-text final answer must NEVER be nudged. The loop already
 * gates the call on the stop-state (finishReason !== "tool-calls",
 * toolCallCount === 0, tools available); this detector adds the SEMANTIC gate:
 * the text must actually read as a tool intent. When in doubt, return false so
 * the turn finishes normally.
 */

/**
 * Lead-in phrases a model uses right before announcing an action it is
 * "about to" take: "let me …", "I'll …", "I will …", "now I'll …",
 * "going to …". Deliberately small and high-precision.
 *
 * NOTE the `(?! know\b)` after "let me": "let me know …" is an extremely common
 * polite CLOSER ("let me know if you'd like me to run the tests") — an offer
 * deferred to the user, not a self-declared action. Excluding it here is the
 * first line of defense against nudging a legitimate final answer.
 */
const INTENT_LEADIN =
  "(?:let me(?! know\\b)|i'?ll|i will|i'?m going to|i am going to|going to|now i(?:'?ll| will)?|next,? i)";

/**
 * Action verbs that denote a tool-shaped operation (filesystem / shell / search
 * / edit). Kept to concrete tool verbs so conversational uses ("let me
 * explain", "let me know") do not match.
 */
const TOOL_VERB =
  "(?:read|open|look at|inspect|examine|find|search|grep|locate|list|edit|modify|update|change|write|create|check|run|execute|explore|fetch|scan|review the (?:file|code))";

/**
 * Tempered gap between the lead-in and the tool verb. A plain `.{0,40}` window
 * bridges an offer/deferral ("let me know IF YOU want me to RUN the tests") to
 * a far-off verb and fires on legitimate finishers. This variant is a
 * tempered-dot that REFUSES to cross a sentence boundary (`[.!?]`) or an
 * offer/deferral marker — a word-boundaried "you"/"if"/"whether", or "would"
 * ("I would recommend you run …") — so only a self-declared action where the
 * MODEL is the subject and the verb sits close to the intent matches.
 */
const INTENT_GAP =
  "(?:(?!\\byou\\b|\\bif\\b|\\bwhether\\b|\\bwould\\b|[.!?]).){0,30}?";

/**
 * Narration = an intent lead-in followed (within a short, tempered window) by a
 * tool verb — with the model as subject and no offer/deferral in between. This
 * keeps "let me read the file" / "I'll search for the handler" matching while
 * refusing "let me know if you'd like me to run the tests" and other polite
 * closers that defer the action to the user.
 */
const NARRATION_RE = new RegExp(
  `\\b${INTENT_LEADIN}\\b${INTENT_GAP}\\b${TOOL_VERB}\\b`,
  "i",
);

/**
 * Literal artifacts of a model that tried to hand-write a tool call as text
 * instead of using the function-call channel: our own blocked-tool marker, a
 * raw `tool_call` token, or a fenced ```json block that names a tool/function.
 */
const FAKE_TOOL_ARTIFACT_RE =
  /\[TOOL BLOCKED\]|\btool_call\b|```(?:json|tool_code)?[\s\S]*?["`](?:tool_name|function|tool|name)["`]\s*:/i;

/**
 * Decide whether a completed no-tool-call turn NARRATED a tool intent it never
 * acted on. Pure/synchronous so it is trivial to unit-test.
 *
 * The loop is responsible for the STRUCTURAL preconditions (zero tool calls,
 * finishReason is a self-stop not "tool-calls", tools are available); this
 * function only judges the TEXT. Returns true only on a clear narration or a
 * fake-tool artifact — otherwise false (prefer a normal finish).
 */
export function detectNarratedToolIntent(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  return NARRATION_RE.test(t) || FAKE_TOOL_ARTIFACT_RE.test(t);
}

/**
 * The user-role corrective turn pushed back onto the conversation. It tells the
 * model to either emit the real function call (not prose) or, if it is actually
 * done, to say so — giving a legitimate finisher a clean escape hatch instead
 * of being forced into a bogus call.
 */
export function buildToolUseCorrection(): string {
  return (
    "[tool-enforcement] You described an action but did not emit a tool call. " +
    "If you intended to act, call the tool NOW using the function-call " +
    "interface — do not describe the action in text. If you are actually " +
    "finished and no tool call is needed, reply with a normal answer."
  );
}
