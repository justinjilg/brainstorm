/**
 * MSP Device Tools — endpoint management via BrainstormMSP.
 *
 * "Protect John's computer" → resolves device → simulates → ChangeSet → execute
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { MSPClient } from "../client.js";
import { createChangeSet, registerExecutor } from "../../../changeset.js";

export function createDeviceTools(client: MSPClient): BrainstormToolDef[] {
  // Register executors for changeset-backed tools
  registerExecutor("msp_protect_device", async (cs) => {
    const data = cs.simulation.statePreview as any;
    const deviceId = cs.changes[0]?.entity.replace("device:", "") ?? "";
    const level = data?.firewall === "strict" ? "maximum" : "standard";
    const result = await client.executeProtect(deviceId, level);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `Protection enabled on ${deviceId}`,
      rollbackData: {
        deviceId,
        previousState: cs.changes.map((c) => c.before),
      },
    };
  });

  registerExecutor("msp_isolate_device", async (cs) => {
    const deviceId = cs.changes[0]?.entity.replace("device:", "") ?? "";
    const result = await client.isolateDevice(deviceId);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `Device ${deviceId} isolated from network`,
      rollbackData: { deviceId },
    };
  });

  return [
    defineTool({
      name: "msp_list_devices",
      description:
        "Search for devices/endpoints by owner name, hostname, or keyword. Use this to resolve 'John\\'s computer' to a specific device ID.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search term: owner name, hostname, serial, or keyword"),
      }),
      async execute({ query }) {
        return client.searchDevices(query);
      },
    }),

    defineTool({
      name: "msp_device_status",
      description:
        "Get detailed status of a specific device: hardware, OS, compliance, security posture, software inventory.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        device_id: z.string().describe("Device ID or hostname"),
      }),
      async execute({ device_id }) {
        const [device, software] = await Promise.all([
          client.getDevice(device_id),
          client.getDeviceSoftware(device_id),
        ]);
        return { device, software };
      },
    }),

    defineTool({
      name: "msp_protect_device",
      description:
        "Enable full protection suite on a device: disk encryption, firewall hardening, EDR agent. Returns a ChangeSet for approval before executing. Use after resolving a device with msp_list_devices.",
      permission: "confirm",
      inputSchema: z.object({
        device_id: z.string().describe("Device ID (from msp_list_devices)"),
        level: z
          .enum(["standard", "maximum"])
          .default("standard")
          .describe(
            "Protection level: standard (firewall + encryption) or maximum (strict firewall + encryption + EDR)",
          ),
      }),
      async execute({ device_id, level }) {
        const { simulation, changes } = await client.simulateProtect(
          device_id,
          level,
        );

        if (!simulation.success) {
          return {
            error: "Simulation failed",
            constraints: simulation.constraints,
          };
        }

        const changeset = createChangeSet({
          connector: "msp",
          action: "msp_protect_device",
          description: `Enable ${level} protection on device ${device_id}`,
          changes,
          simulation,
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          changes: changeset.changes,
          simulation: changeset.simulation,
          message: `ChangeSet created. Present this to the user and call gm_changeset_approve with id "${changeset.id}" after approval.`,
        };
      },
    }),

    defineTool({
      name: "msp_isolate_device",
      description:
        "Network-isolate a compromised device. The device will lose all network connectivity except to the management plane. Returns a ChangeSet for approval.",
      permission: "confirm",
      inputSchema: z.object({
        device_id: z.string().describe("Device ID to isolate"),
        reason: z
          .string()
          .describe("Reason for isolation (logged in evidence chain)"),
      }),
      async execute({ device_id, reason }) {
        const device = await client.getDevice(device_id);
        if (device.error) return { error: device.error };

        const changes = [
          {
            system: "msp",
            entity: `device:${device.hostname ?? device_id}`,
            operation: "update" as const,
            before: { network: "connected" },
            after: { network: "isolated" },
          },
        ];

        const changeset = createChangeSet({
          connector: "msp",
          action: "msp_isolate_device",
          description: `Network-isolate ${device.hostname ?? device_id}: ${reason}`,
          changes,
          simulation: {
            success: true,
            statePreview: { network: "isolated", management: "connected" },
            cascades: [
              "All network connections will be dropped",
              "User will lose remote access",
            ],
            constraints: [],
            estimatedDuration: "~10 seconds",
          },
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          changes: changeset.changes,
          simulation: changeset.simulation,
          message: `ChangeSet created. Call gm_changeset_approve with id "${changeset.id}" after user approval.`,
        };
      },
    }),

    defineTool({
      name: "msp_scan_device",
      description:
        "Trigger an antivirus/compliance scan on a device. Non-destructive — no ChangeSet needed.",
      permission: "auto",
      inputSchema: z.object({
        device_id: z.string().describe("Device ID to scan"),
      }),
      async execute({ device_id }) {
        return client.scanDevice(device_id);
      },
    }),
  ];
}
