const fs = require('fs');
const glob = require('glob');
const path = require('path');

const files = glob.sync('{packages,apps}/*/package.json');
const packages = {};

for (const file of files) {
  const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const name = content.name;
  if (!name) continue;
  
  const deps = { ...content.dependencies, ...content.devDependencies, ...content.peerDependencies };
  const internalDeps = Object.keys(deps).filter(d => d.startsWith('@brainst0rm/') || d === 'brainstorm');
  
  packages[name] = {
    path: path.dirname(file),
    deps: internalDeps
  };
}

// Generate an ASCII tree/graph or layered architecture
let output = "```text\n";
output += "BRAINSTORM MONOREPO ARCHITECTURE\n================================\n\n";

output += "Total packages found: " + Object.keys(packages).length + " (Turborepo Workspace)\n\n";

const layers = {
  "Applications (Apps / Entrypoints)": [],
  "High-Level Workflows & SDK": [],
  "Services & Core Infrastructure": [],
  "Mid-Level Utilities": [],
  "Foundation / Primitives": []
};

for (const [name, info] of Object.entries(packages)) {
  if (info.path.startsWith('apps/') || name === '@brainst0rm/cli') {
    layers["Applications (Apps / Entrypoints)"].push(name);
  } else if (name.includes('workflow') || name.includes('eval') || name.includes('orchestrator') || name.includes('onboard') || name.includes('sdk')) {
    layers["High-Level Workflows & SDK"].push(name);
  } else if (name.includes('core') || name.includes('server') || name.includes('godmode') || name.includes('agents') || name.includes('router') || name.includes('gateway')) {
    layers["Services & Core Infrastructure"].push(name);
  } else if (name.includes('providers') || name.includes('projects') || name.includes('scheduler') || name.includes('docgen') || name.includes('ingest') || name.includes('mcp')) {
    layers["Mid-Level Utilities"].push(name);
  } else {
    layers["Foundation / Primitives"].push(name);
  }
}

for (const [layerName, pkgNames] of Object.entries(layers)) {
  output += `[ ${layerName} ]\n`;
  output += `-------------------------------------------------\n`;
  for (const name of pkgNames) {
    const deps = packages[name].deps;
    output += `  📦 ${name.padEnd(25)}\n`;
    if (deps.length > 0) {
      deps.forEach((dep, idx) => {
        const isLast = idx === deps.length - 1;
        output += `     ${isLast ? '└' : '├'}─ ${dep}\n`;
      });
    } else {
      output += `     └─ (No internal dependencies)\n`;
    }
    output += `\n`;
  }
}

output += `
KEY INTERFACES & ABSTRACTIONS
=============================

1. BrainstormClient (@brainst0rm/server)
   ├─ Interface for interacting with the standardized 3-endpoint REST API.
   ├─ Methods: getHealth(), getTools(), executeCommand(), streamChat()
   └─ Usage: Connects frontend/desktop/CLI to backend God Mode instances.

2. BrainstormRouter (@brainst0rm/router)
   ├─ Gateway logic for multi-model routing and load balancing.
   ├─ Implements cost-first and quality-first strategies.
   └─ Usage: Mediates AI requests to external providers based on rules.

3. BrainstormToolDef (@brainst0rm/tools)
   ├─ Defines capabilities available to AI agents.
   ├─ Fields: name, description, schema, handler()
   └─ Usage: Implements shell, file operations, web fetch, github integration.

4. ChangeSet (@brainst0rm/godmode)
   ├─ Audit and execution tracking for God Mode.
   ├─ Manages createChangeSet(), approveChangeSet(), execute().
   └─ Usage: Wraps multi-step infrastructure edits safely.

5. RepoMap & SymbolSignature (@brainst0rm/core)
   ├─ Manages repository structure and context mapping.
   └─ Usage: Generates compact AI context (prompt segments) from codebase.

6. WorkflowEngine (@brainst0rm/workflow)
   ├─ Orchestrates KAIROS multi-phase pipelines.
   └─ Usage: Drives autonomous tasks through step execution and escalation.

7. IPC Bridge (apps/desktop)
   ├─ JSON NDJSON line-based protocol for Electron Main <-> Backend CLI.
   └─ Usage: Isolates native Node dependencies and streams chat events.
\`\`\`\n`;

// Write to file
fs.writeFileSync('ARCHITECTURE_DIAGRAM.txt', output);
console.log('Diagram generated to ARCHITECTURE_DIAGRAM.txt');
