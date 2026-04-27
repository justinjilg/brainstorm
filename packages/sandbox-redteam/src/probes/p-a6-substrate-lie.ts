// P-A6-substrate-lie
// Threat model class: A6 (substrate-lying attacker; threat-model §3.1).
//
// THE HEADLINE PROBE. Between two dispatches, the *host* — not any
// in-guest tool — mutates the sandbox's overlay file (the substrate
// underneath the integrity monitor). The next `reset()` MUST detect
// divergence in the 3-source verification (FS hash + open-fd count +
// VMM API state) and surface `divergence_action !== "none"`. Per
// threat-model §5.1 the integrity monitor halts on any disagreement.
//
// Two flavours of substrate lie this probe distinguishes:
//   1. Honest VMM, dirty overlay: the FS hash diverges and reset
//      throws SandboxResetDivergenceError. PASS.
//   2. Lying VMM, dirty overlay: the VMM reports baseline hash to hide
//      the mutation. The probe asserts divergence INDEPENDENTLY by
//      re-reading the host-side overlay it mutated and comparing to
//      what reset() reported. This catches the lying-VMM case at the
//      probe level even when the sandbox itself is fooled.
//
// On a real CHV this maps to: harness writes into the cow-overlay
// directly on the host (P3.4 image-builder controls the overlay layout);
// next reset must detect via SHA-256 of the post-restore overlay disk.
//
// Honesty: validated against mock only. Real CHV requires the
// snapshot/restore + overlay-hash machinery from P3.1a, none of which
// has run on this checkout.

import { SandboxResetDivergenceError, type Sandbox } from "@brainst0rm/sandbox";

import { MockSandbox } from "../mock-sandbox.js";
import type { Probe, ProbeOutcome } from "../types.js";

const SUBSTRATE_PATH = "/var/lib/sandbox/overlay/marker";
const SUBSTRATE_PAYLOAD = "BSM_RT_A6_HOST_MUTATION_" + Date.now();

export const pA6SubstrateLie: Probe = {
  name: "P-A6-substrate-lie",
  attackerClass: "A6",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Host-side mutation of sandbox overlay between dispatches. Next reset " +
    "MUST detect divergence (3-source verification halts). If the VMM lies " +
    "and reports baseline hash, the probe catches it via independent " +
    "host-side evidence.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    // Step 1. Run a benign tool just to anchor lifecycle ("between
    // dispatches" — there must be a previous dispatch).
    await sandbox.executeTool({
      command_id: "redteam-A6-anchor",
      tool: "noop",
      params: {},
      deadline_ms: 1_000,
    });

    // Step 2. Reset to clean state, then mutate the overlay from the host.
    // On a real sandbox, this would be a host-side overlay-file write
    // (e.g. mounting the cow-image and writing). On the mock, we use the
    // exposed hostMutateOverlay() helper.
    if (!(sandbox instanceof MockSandbox)) {
      // Stubbed: real-host overlay mutation is backend-specific. Without
      // a CHV process to address, we cannot perform the host-side write.
      return {
        passed: false,
        reason:
          "real-sandbox host-overlay mutation not implemented yet; needs " +
          "CHV cow-overlay path from P3.4 image-builder",
        evidence: { stub: true, backend: sandbox.backend },
      };
    }
    sandbox.hostMutateOverlay(SUBSTRATE_PATH, SUBSTRATE_PAYLOAD);

    // Step 3. Trigger reset. EXPECTED: SandboxResetDivergenceError.
    try {
      const reportedReset = await sandbox.reset();
      // If we get here, reset DID NOT throw. Two sub-cases:
      //   a. divergence_action says "halt" but the impl forgot to throw —
      //      that's still a defender failure (the flag is right but the
      //      action is wrong).
      //   b. divergence_action says "none" — the substrate is lying.
      const divergenceAction =
        reportedReset.verification_details.divergence_action;
      if (divergenceAction !== "none") {
        return {
          passed: false,
          reason:
            `reset reported divergence_action="${divergenceAction}" but did ` +
            `NOT throw SandboxResetDivergenceError. Defender flagged the ` +
            `lie but did not enforce the halt.`,
          evidence: { divergence_action: divergenceAction },
        };
      }
      // VMM is lying. Independent host-side evidence: we know we wrote
      // SUBSTRATE_PAYLOAD; the reset claimed baseline hash. That is
      // detectable via the overlay snapshot the mock exposes.
      const overlayPostReset = sandbox.getOverlay().get(SUBSTRATE_PATH);
      if (overlayPostReset === SUBSTRATE_PAYLOAD) {
        return {
          passed: false,
          reason:
            "VMM reported divergence_action=none but overlay still contains " +
            "the host-mutated payload — sandbox lied about state.",
          evidence: {
            host_payload: SUBSTRATE_PAYLOAD,
            overlay_seen: overlayPostReset,
          },
        };
      }
      return {
        passed: false,
        reason:
          "reset reported clean and overlay was reverted, but we expected a " +
          "throw because the substrate WAS dirty pre-reset. Possible false " +
          "positive in mock — investigate.",
      };
    } catch (e) {
      if (e instanceof SandboxResetDivergenceError) {
        return {
          passed: true,
          reason: `reset detected divergence: ${(e as Error).message}`,
          evidence: { error_code: "SANDBOX_RESET_DIVERGENCE" },
        };
      }
      return {
        passed: false,
        reason: `unexpected error from reset: ${(e as Error).message}`,
      };
    }
  },
};
