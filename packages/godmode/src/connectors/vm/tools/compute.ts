/**
 * VM Compute Tools — create, destroy, migrate, status.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { VMClient } from "../client.js";
import { createChangeSet, registerExecutor } from "../../../changeset.js";

export function createComputeTools(client: VMClient): BrainstormToolDef[] {
  registerExecutor("vm_create", async (cs) => {
    const spec = cs.simulation.statePreview as any;
    const result = await client.createVM(spec);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `VM ${spec.name} created (ID: ${result.id})`,
      rollbackData: { vmId: result.id },
    };
  });

  registerExecutor("vm_destroy", async (cs) => {
    const vmId = cs.changes[0]?.entity.replace("vm:", "") ?? "";
    const result = await client.destroyVM(vmId);
    if (result.error) return { success: false, message: result.error };
    return { success: true, message: `VM ${vmId} destroyed` };
  });

  registerExecutor("vm_migrate", async (cs) => {
    const data = cs.simulation.statePreview as any;
    const result = await client.migrateVM(data.vmId, data.targetNode);
    if (result.error) return { success: false, message: result.error };
    return { success: true, message: `VM migrated to ${data.targetNode}` };
  });

  return [
    defineTool({
      name: "vm_list",
      description:
        "List all VMs with optional filtering by name, status, or node.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        name: z.string().optional().describe("Filter by VM name"),
        status: z
          .string()
          .optional()
          .describe("Filter: running, stopped, migrating"),
      }),
      async execute({ name, status }) {
        const filters: Record<string, string> = {};
        if (name) filters.name = name;
        if (status) filters.status = status;
        return client.listVMs(filters);
      },
    }),

    defineTool({
      name: "vm_status",
      description:
        "Get detailed VM status: CPU, memory, disk, network, health, uptime.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        vm_id: z.string().describe("VM ID or name"),
      }),
      async execute({ vm_id }) {
        return client.getVM(vm_id);
      },
    }),

    defineTool({
      name: "vm_create",
      description:
        "Create a new VM. Returns a ChangeSet for approval. Specify CPU, memory, disk, and optional template.",
      permission: "confirm",
      inputSchema: z.object({
        name: z.string().describe("VM name (e.g., 'qa-server-01')"),
        vcpus: z.number().min(1).max(64).default(2).describe("Number of vCPUs"),
        memory_mb: z
          .number()
          .min(512)
          .max(131072)
          .default(2048)
          .describe("Memory in MB"),
        disk_gb: z
          .number()
          .min(10)
          .max(2048)
          .default(50)
          .describe("Disk in GB"),
        template: z
          .string()
          .optional()
          .describe("Template name for CoW cloning (e.g., 'ubuntu-24.04')"),
        network: z.string().optional().describe("Network name to attach to"),
      }),
      async execute({ name, vcpus, memory_mb, disk_gb, template, network }) {
        const spec = {
          name,
          vcpus,
          memoryMb: memory_mb,
          diskGb: disk_gb,
          template,
          network,
        };

        const changeset = createChangeSet({
          connector: "vm",
          action: "vm_create",
          description: `Create VM "${name}" (${vcpus} vCPUs, ${memory_mb}MB RAM, ${disk_gb}GB disk)`,
          changes: [
            {
              system: "vm",
              entity: `vm:${name}`,
              operation: "create",
              after: spec,
            },
          ],
          simulation: {
            success: true,
            statePreview: spec,
            cascades: template ? [`Clone from template "${template}"`] : [],
            constraints: [],
            estimatedDuration: template
              ? "~15 seconds (CoW clone)"
              : "~60 seconds",
          },
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          message: `Call gm_changeset_approve with id "${changeset.id}" after approval.`,
        };
      },
    }),

    defineTool({
      name: "vm_destroy",
      description:
        "Destroy a VM permanently. Returns a ChangeSet for approval. WARNING: This is destructive and irreversible.",
      permission: "confirm",
      inputSchema: z.object({
        vm_id: z.string().describe("VM ID to destroy"),
        reason: z.string().describe("Reason for destruction (logged)"),
      }),
      async execute({ vm_id, reason }) {
        const vm = await client.getVM(vm_id);
        if (vm.error) return { error: vm.error };

        const changeset = createChangeSet({
          connector: "vm",
          action: "vm_destroy",
          description: `Destroy VM ${vm.name ?? vm_id}: ${reason}`,
          changes: [
            {
              system: "vm",
              entity: `vm:${vm_id}`,
              operation: "delete",
              before: vm,
            },
          ],
          simulation: {
            success: true,
            statePreview: null,
            cascades: [
              "All data on this VM will be permanently lost",
              "Associated network interfaces will be released",
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
          message: `Call gm_changeset_approve with id "${changeset.id}" after approval.`,
        };
      },
    }),

    defineTool({
      name: "vm_migrate",
      description:
        "Live-migrate a VM to another node. Returns a ChangeSet for approval.",
      permission: "confirm",
      inputSchema: z.object({
        vm_id: z.string().describe("VM ID to migrate"),
        target_node: z.string().describe("Target node hostname or ID"),
      }),
      async execute({ vm_id, target_node }) {
        const changeset = createChangeSet({
          connector: "vm",
          action: "vm_migrate",
          description: `Live-migrate VM ${vm_id} to node ${target_node}`,
          changes: [
            {
              system: "vm",
              entity: `vm:${vm_id}`,
              operation: "update",
              before: { node: "current" },
              after: { node: target_node },
            },
          ],
          simulation: {
            success: true,
            statePreview: { vmId: vm_id, targetNode: target_node },
            cascades: ["Brief network interruption during migration"],
            constraints: [],
            estimatedDuration: "~30-120 seconds depending on memory size",
          },
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          message: `Call gm_changeset_approve with id "${changeset.id}" after approval.`,
        };
      },
    }),

    defineTool({
      name: "vm_cluster_health",
      description:
        "Get cluster-wide health: node status, alerts, resource utilization.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        const [health, alerts] = await Promise.all([
          client.getClusterHealth(),
          client.getAlerts(),
        ]);
        return { health, alerts };
      },
    }),

    defineTool({
      name: "vm_snapshot",
      description:
        "Create a snapshot of a VM for backup or cloning. Non-destructive.",
      permission: "auto",
      inputSchema: z.object({
        vm_id: z.string().describe("VM ID to snapshot"),
        name: z.string().describe("Snapshot name (e.g., 'pre-upgrade-backup')"),
      }),
      async execute({ vm_id, name }) {
        return client.createSnapshot(vm_id, name);
      },
    }),

    defineTool({
      name: "vm_topology",
      description:
        "Show the network topology: nodes, VLANs, WireGuard mesh, resource graph.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.getTopology();
      },
    }),
  ];
}
