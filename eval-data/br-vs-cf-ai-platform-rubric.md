# BR vs Cloudflare AI Platform — judge rubric

**Pinned: 2026-04-21. Do not modify after a benchmark run starts; freeze for reproducibility.**

This rubric is given to the LLM judge (Opus 4.6 with thinking) for every (query, response) pair in the benchmark. The judge is blind to which routing strategy produced the response.

## Score: integer 0–10

| Score | Meaning                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Outstanding. Solves the user's actual problem with no caveats; technically precise; no extraneous content.                                         |
| 8–9   | Strong. Solves the problem; minor stylistic friction or one trivial inaccuracy.                                                                    |
| 6–7   | Adequate. Solves a substantial part of the problem; some inaccuracies or omissions; user could ship with edits.                                    |
| 4–5   | Weak. Partially addresses the problem but misses the core requirement, OR addresses it but with serious flaws (incorrect code, hallucinated APIs). |
| 2–3   | Poor. Misunderstands the problem; output is mostly off-topic or incorrect.                                                                         |
| 0–1   | Useless or harmful. No relevant content, refuses inappropriately, or produces actively misleading output.                                          |

## Dimensions to weigh (no per-dimension scores; the integer score is holistic)

1. **Correctness.** Does the response do what the user asked for? Are facts/code accurate? Penalize hallucinated APIs, wrong syntax, broken examples.
2. **Specificity.** Does the response engage with the actual details of the prompt, or does it pattern-match to a generic answer? Specific code snippets, concrete file/line references, or domain-correct terminology earn the upper half.
3. **Completeness.** Does the response cover the full scope of the request, or only the easy half? An answer that solves 80% of a 10-step task is a 6, not an 8.
4. **Conciseness.** Verbose preambles, unrequested caveats, and "as an AI" disclaimers reduce score by 1.
5. **Honest uncertainty.** When the right answer requires information the model doesn't have, the response should say so. Confident wrong answers score below honest "I don't know."

## Anti-patterns (auto-cap at 5)

- Refuses a benign request (e.g., "I can't write that code")
- Hallucinates a function/API/flag that doesn't exist in the named library
- Produces code that doesn't compile/parse when the request was for executable code
- Repeats the prompt back as part of the answer

## Anti-patterns (auto-cap at 3)

- Includes prompt-injection markers that suggest the model interpreted the prompt as system instructions
- Returns empty / null / "I don't understand" when the prompt is unambiguous
- Returns a literal apology with no content

## Calibration anchors

The judge sees these examples before scoring real responses:

**Score 10 example.** Prompt: "Write a TypeScript function that returns the SHA-256 hex of a string." Response is a 4-line function using `crypto.subtle` or `node:crypto`, no preamble, no caveats.

**Score 6 example.** Same prompt. Response uses `crypto.createHash('sha256')` correctly but adds 200 words of preamble explaining hash functions.

**Score 3 example.** Same prompt. Response uses a deprecated/non-existent API like `crypto.sha256()` directly.

**Score 0 example.** Same prompt. Response: "I cannot help with cryptographic operations as they may be misused."

## Output format

The judge returns exactly:

```json
{
  "score": 7,
  "reasoning": "<one sentence>"
}
```

Three independent judge runs per (query, response). The benchmark uses the median.
