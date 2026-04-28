# Brainstorm Relay on brainstormVM K8s — Deploy-Target Requirements

**Audience:** brainstormVM peer (`0bz7aztr`), scoping the Q2–Q3 K8s deploy-target roadmap.
**Author side:** Brainstorm relay (`~/Projects/brainstorm`, tag `v0.1.0`, deploy package merged on `main` as of 2026-04-27 in PR #281).
**Status:** Cross-product input. Not a Helm chart, not an architecture decision, not a security review. This is "here is what the relay actually needs at runtime, grounded in the v0.1.0 source, so you can scope plumbing work."
**Voice:** Collegial peer-to-peer. Things I verified against source are marked `[verified]`. Things I'm inferring or guessing are marked `[inferred]` or `[guess]`. Push back on anything that doesn't match what your side knows.

---

## 0. TL;DR

The relay is a single Node 22 process that listens on two TCP ports (WS + HTTP), persists three SQLite databases to a real filesystem, and needs outbound HTTPS to BR for downstream verification work. To deploy it onto your K8s cluster as a reference workload, you need the standard "stateful single-replica" K8s posture: a `Deployment` with one replica, a `PVC` backed by a CSI driver that supports `fsync` (i.e. NOT `emptyDir`/`tmpfs` — `better-sqlite3` will silently corrupt or hard-fail), an `Ingress` with path-based routing for four prefixes, `cert-manager` issuing a Let's Encrypt cert, and a `Secret` carrying three pieces of key material the bootstrap script currently generates with `openssl rand -hex 32`.

There is no container image yet. That's the first artifact a Q2 roadmap item should produce, on the Brainstorm side, and it's the cleanest hand-off boundary between us and you. After that, the cluster-side components (CSI, ingress, cert-manager, registry) are all yours.

---

## 1. Workload Sketch

The relay binary is `packages/relay/dist/bin.js`, a Node 22 ESM entry point [verified: `packages/relay/src/bin.ts` lines 1–207]. At v0.1.0 it wires together fourteen TypeScript modules into one process: an audit log (SQLite), a nonce store (SQLite), a session store (in-memory), a lifecycle state machine, a result router, an ACK-timeout manager, a dispatch orchestrator, a relay server, a WS binding (the `ws` library), and an HTTP enrollment server.

**Process shape:**

- One process. No worker threads, no clustering, no IPC. Single-replica is the v0.1.0 story; HA is explicitly post-MVP and would require a different audit-log architecture (see §5).
- Memory: ~50 MB RSS at idle [guess, based on Node 22 + better-sqlite3 + `ws` baseline; not measured]. Should set a `requests.memory` of `128Mi` and a `limits.memory` of `256Mi` to leave headroom.
- CPU: Effectively idle except during dispatch. Each command performs Ed25519 sign + SHA-256 + JCS canonicalization + SQLite insert. Single-digit-ms per dispatch on a modern x86 core [inferred from algorithm choice]. `requests.cpu: 100m`, `limits.cpu: 500m` is a reasonable starting envelope. Burst is bounded by ACK-timeout (5s, hard-coded in `bin.ts:110`).
- I/O: Audit-log writes dominate. Every operator command, every endpoint frame, every late arrival, every dispatch event is appended to `audit.db` [verified: `packages/relay/src/audit.ts` lines 70–113]. SQLite is in WAL mode with `synchronous = NORMAL` [verified: `audit.ts:57–58`, `nonce-store.ts:49–50`, `enrollment.ts:75–76`]. Expect short bursts of fsyncs per command; not high IOPS, but the storage layer must honor `fsync()`.

**Port surface:**

- WS port (default 8443, env `BRAINSTORM_RELAY_PORT_WS`) — serves two paths: `/v1/operator` and `/v1/endpoint/connect` [verified: `bin.ts:163`].
- HTTP port (default 8444, env `BRAINSTORM_RELAY_PORT_HTTP`) — serves enrollment paths: `POST /v1/admin/endpoint/enroll`, `POST /v1/endpoint/enroll`, `POST /v1/admin/endpoint/<endpoint_id>/rotate` [verified: `enrollment.ts:312, 330, 363`].
- The relay binds these to `127.0.0.1` by default [verified: `bin.ts:91`]. In the single-host deploy package, Caddy is the externally-reachable surface and the relay is loopback-only [verified: `packages/relay/deploy/Caddyfile.template`]. On K8s, the equivalent posture is "ClusterIP `Service`, `Ingress` does TLS + path routing, relay still binds 127.0.0.1 inside the pod."

**TLS expectations:**

- The relay does **not** terminate TLS itself [verified: `packages/relay/README.md:115` — "TLS termination directly in the relay (currently relies on reverse proxy)"]. This is a feature for K8s: the ingress controller terminates, and the relay container speaks plain HTTP/WS over loopback inside the pod.
- WebSocket upgrades must be allowed by the ingress. `ingress-nginx` handles this with the right annotations; we'll call those out in §3.

**Replica count:**

- v0.1.0: **1 replica, fixed.** No leader election, no shared state across replicas, audit log is per-process SQLite. Setting `replicas: 2` will produce two relays with diverging audit logs and two independent nonce stores; cross-replica replay attacks would not be caught. Don't do it.
- HA is post-MVP and would require either (a) a shared-storage SQLite story (risky, we'd avoid it) or (b) replacing the audit-log + nonce-store layer with a network-database backend. Out of scope for this doc.

---

## 2. Required K8s Primitives

Each row states **what** is needed and **why** the relay breaks (or degrades) without it.

### 2.1 `Deployment`

| Field | Value | Why |
|---|---|---|
| `replicas` | `1` | Single-process audit-log invariant (§1). |
| `strategy.type` | `Recreate` | Rolling-update would briefly run two replicas; the second would open `audit.db` and conflict on the SQLite WAL. `Recreate` waits for pod termination before starting the new one. See §6 open question on draining. |
| `containers[0].image` | `<registry>/brainstorm-relay:v0.1.0` | Image does not exist yet. See §3.5. |
| `containers[0].command` | `["node", "/app/packages/relay/dist/bin.js"]` | Mirrors `ExecStart` in `relay.service` [verified: `relay.service:11`]. |
| `containers[0].ports` | `[{ name: ws, containerPort: 8443 }, { name: http, containerPort: 8444 }]` | Default ports from `bin.ts:89–90`. |
| `containers[0].resources.requests.memory` | `128Mi` | See §1 memory. |
| `containers[0].resources.limits.memory` | `256Mi` | Headroom for SQLite cache + WAL. |
| `containers[0].resources.requests.cpu` | `100m` | See §1 CPU. |
| `containers[0].resources.limits.cpu` | `500m` | Burst ceiling. |
| `containers[0].securityContext.runAsNonRoot` | `true` | Mirrors `User=brainstorm-relay` in `relay.service:8`. |
| `containers[0].securityContext.runAsUser` | `1000` (or whatever `brainstorm-relay` UID is in the image) | — |
| `containers[0].securityContext.readOnlyRootFilesystem` | `true` | Matches `ProtectSystem=strict` posture in `relay.service:18`. Requires writable `emptyDir` for `/tmp` and the PVC for data. |
| `containers[0].securityContext.allowPrivilegeEscalation` | `false` | Matches `NoNewPrivileges=yes` in `relay.service:16`. |
| `containers[0].securityContext.capabilities.drop` | `["ALL"]` | Relay needs no Linux capabilities. |
| `spec.template.spec.containers[0].resources.limits` (sysctls) | `nofile=65536` | Mirrors `LimitNOFILE=65536` in `relay.service:14`. K8s exposes this via `securityContext.sysctls` or `initContainer` in some setups; check your cluster's `PodSecurity` admission. |

**Liveness / readiness:** v0.1.0 does not expose a `/health` HTTP endpoint [verified: `enrollment.ts` only registers the three enrollment routes]. Readiness probe options:

- Option A (recommended for now): TCP probe on `:8443` and `:8444`. Relay is "ready" if both ports accept connections. Cheap, matches what Caddy assumes today.
- Option B (Brainstorm-side work): add `GET /v1/health` to the HTTP server. Tracked as a follow-up; not blocking your scoping.

### 2.2 `Service`

| Field | Value | Why |
|---|---|---|
| `type` | `ClusterIP` | Ingress controller is the external surface; service is internal. |
| `ports[0]` | `name: ws, port: 8443, targetPort: 8443` | WS path-routed by ingress. |
| `ports[1]` | `name: http, port: 8444, targetPort: 8444` | HTTP enrollment path-routed by ingress. |
| `selector` | matches Deployment pod labels | Standard. |

A second `Service` of `type: LoadBalancer` (or `NodePort`) is **only** needed if the relay must be reachable without an ingress controller. For the dogfood path, ingress + cert-manager + Let's Encrypt is the cleaner story.

### 2.3 `PersistentVolumeClaim`

This is the most load-bearing primitive in the deploy story.

| Field | Value | Why |
|---|---|---|
| `accessModes` | `[ReadWriteOnce]` | Single replica, single mount. RWX would let two pods race on the SQLite WAL. |
| `resources.requests.storage` | `10Gi` | Audit log grows with command volume; nonce store grows with command volume; endpoint registry is tiny. 10 GiB covers a year of moderate dispatch traffic [guess, not measured]. |
| `storageClassName` | `<csi-backed class>` | **Must be a CSI driver that honors `fsync`. NOT `emptyDir`, NOT `hostPath` on tmpfs, NOT a `medium: Memory` `emptyDir`.** |

**SQLite-on-tmpfs trap (load-bearing):** `better-sqlite3` opens the database file with `O_RDWR | O_CREAT` and relies on `fsync()` semantics for WAL durability [verified: it's the default better-sqlite3 path; relay enables WAL mode in three places]. On `tmpfs` and `emptyDir{ medium: Memory }`, `fsync()` is essentially a no-op and the data lives only in page cache; on pod restart the audit log is gone and nonce-replay protection resets. On `hostPath` backed by node-local SSD, you lose cross-node portability and the "schedulable anywhere" property of the Deployment. The CSI-backed PVC is the right answer. Persistent disk is a hard requirement, not a nice-to-have. If your team's first instinct is "let's just use emptyDir for the dogfood test," push back hard.

The mount path inside the container should match `BRAINSTORM_RELAY_DATA_DIR` (default `~/.brainstorm/relay`, but in the systemd unit it's `/var/lib/brainstorm-relay` [verified: `relay.service:20` and `bootstrap.sh:88`]). For consistency with the systemd posture I'd default to `/var/lib/brainstorm-relay` inside the container.

### 2.4 `Ingress`

Path-based routing across four prefixes (the relay does not own routing — currently Caddy splits paths between the two backend ports [verified: `Caddyfile.template`]):

| Path | Backend port | Notes |
|---|---|---|
| `/v1/operator` | `8443` (WS) | WebSocket upgrade required. |
| `/v1/endpoint/connect` | `8443` (WS) | WebSocket upgrade required. |
| `/v1/endpoint/enroll` | `8444` (HTTP) | One-shot POST. |
| `/v1/admin/endpoint/*` | `8444` (HTTP) | Admin-token-gated; includes `/enroll` and `/<id>/rotate`. |
| (default) | 404 | Caddy explicitly rejects [verified: `Caddyfile.template:23–25`]. Mirror this in K8s ingress. |

For `ingress-nginx`, the WebSocket paths need the standard upgrade annotations. The request timeout should be set high enough that long-lived operator/endpoint sessions don't get terminated mid-dispatch (Caddy default is fine; ingress-nginx default of 60s would terminate WS sessions). Set `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` and `proxy-send-timeout: "3600"` [inferred from typical WS deploys; verify against your ingress-nginx config conventions].

### 2.5 `cert-manager` `Issuer` / `ClusterIssuer`

- ACME `ClusterIssuer` with Let's Encrypt as the upstream.
- HTTP-01 solver works if port 80 is reachable from the public internet (matches what `bootstrap.sh` assumes [verified: `bootstrap.sh:36` — "open firewall ports (caller must allow 80/443 inbound)"]).
- DNS-01 solver works if you'd rather not expose port 80; needs your DNS provider's API token. Not blocking; pick whichever fits your cluster's existing pattern.
- Certificate references the relay hostname (e.g. `relay.example.com`).

### 2.6 `ConfigMap`

The relay is configured entirely via env vars [verified: `bin.ts:8–20` documents 9 env vars]. Non-secret env goes in a `ConfigMap`:

```yaml
BRAINSTORM_RELAY_HOST: "127.0.0.1"
BRAINSTORM_RELAY_PORT_WS: "8443"
BRAINSTORM_RELAY_PORT_HTTP: "8444"
BRAINSTORM_RELAY_DATA_DIR: "/var/lib/brainstorm-relay"
BRAINSTORM_RELAY_OPERATOR_ID: "operator@local"
BRAINSTORM_RELAY_TENANT_ID: "tenant-local"
```

Mount as env via `envFrom.configMapRef`.

### 2.7 `Secret`

Three pieces of key material, all generated once at provisioning by `bootstrap.sh:96–98` [verified]:

```yaml
BRAINSTORM_RELAY_ADMIN_TOKEN: <openssl rand -hex 32>            # 64 hex chars
BRAINSTORM_RELAY_TENANT_KEY_HEX: <openssl rand -hex 32>          # Ed25519 private key seed, 32 bytes hex
BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX: <openssl rand -hex 32>   # 32-byte HMAC key, hex-encoded
```

The relay validates that the two key-hex fields decode to exactly 32 bytes [verified: `bin.ts:69–86`] — anything else is a startup error. Mount as env via `envFrom.secretRef`.

**Rotation:** v0.1.0 has no live rotation. Rotating any of these requires restarting the relay (`systemctl restart brainstorm-relay` in the systemd path; pod restart in K8s). Already-issued endpoint enrollment tokens that were signed with the previous tenant key will fail verification after rotation. This is acceptable for v0.1.0 single-tenant; it's a known sharp edge.

### 2.8 `ServiceAccount`

Low-priv. The relay does not call the Kubernetes API at runtime. No `Role` or `RoleBinding` needed. If your cluster has admission policies that require an explicit service account, name it `brainstorm-relay` and bind nothing.

If the relay later starts orchestrating peers (peer broker, multi-relay coordination), this changes. Not in scope for v0.1.0.

---

## 3. Specific Component Picks (Recommendations, Not Requirements)

These are recommendations grounded in what your CLAUDE.md says you already run. Push back if any of these conflict with your in-flight roadmap.

### 3.1 CSI driver: `piraeus-operator` + LINSTOR

You already document LINSTOR/DRBD as the storage pattern in your project's setup [inferred from peer brief; not verified by me]. `piraeus-operator` is the Kubernetes-native operator for LINSTOR and gives you a CSI driver that exposes DRBD-replicated block storage as PVs. Properties:

- Honors `fsync()` end-to-end (DRBD-A and DRBD-B both flush to backing disk before returning).
- Supports `ReadWriteOnce` cleanly.
- Replication factor of 2 or 3 across nodes gives you survival of one node loss without changing the relay's single-replica posture (the PV moves with the pod).
- Snapshots are first-class, which gives you a clean audit-log archival path later.

If `piraeus-operator` doesn't fit, any CSI driver that backs durable block storage works. The disqualifier list is: `tmpfs`, `emptyDir{ medium: Memory }`, in-memory CSI test drivers, anything that lies about `fsync`.

### 3.2 Ingress controller: `ingress-nginx`

Boring, well-supported, integrates with `cert-manager` via standard annotations, handles WebSocket upgrades cleanly with `proxy-read-timeout` annotations. Not a contrarian pick. If you've already got `traefik` or `gateway-api` running, those work too — but don't introduce a third just for this.

### 3.3 cert-manager: standard upstream `cert-manager` Helm chart

Nothing custom. The bootstrap currently hard-codes Let's Encrypt via Caddy's automatic HTTPS [verified: `bootstrap.sh:64–74` and Caddyfile semantics]. cert-manager + ingress-nginx + Let's Encrypt is the equivalent K8s-native posture.

### 3.4 Image registry

Three options, increasing in maturity:

1. **`ghcr.io/justinjilg/brainstorm-relay`** — easiest. GitHub Container Registry, public or private, OIDC-authenticatable from a CI job. Pin tags as `v0.1.0`, `v0.1.1`, etc. Good enough for the dogfood phase.
2. **Internal registry on brainstormVM** — once you have one. The relay image is small (~150 MiB compressed [guess; multi-stage Node 22 alpine target is the assumption]) so any registry works. This is the right long-term home for "Brainstorm-platform images that brainstormVM consumes," but ghcr is fine until that registry exists.
3. **DigitalOcean Container Registry** — already in your stack (DO App Platform deploys for MSP, GTM, etc.). Cheap and integrated; pull secrets are well-trodden.

### 3.5 Container image — does not exist yet

Brainstorm does not currently produce a container image for the relay. The deploy package is a `bash` installer that clones the monorepo into `/opt/brainstorm-relay`, runs `npm install` and `npx turbo run build --filter=@brainst0rm/relay`, and runs the result as a systemd service [verified: `bootstrap.sh:78–89`]. To deploy on K8s, someone has to produce a Dockerfile that:

- Multi-stage: build stage runs `npm install` + `turbo run build --filter=@brainst0rm/relay`; runtime stage copies just `node_modules` (production-only) and `packages/relay/dist/`.
- Base image: `node:22-alpine` for the runtime stage. Alpine because `better-sqlite3` ships prebuilt binaries for musl and the size win matters.
- Caveat on `better-sqlite3`: the prebuilt binary is platform-specific (linux/amd64 vs linux/arm64). The Dockerfile should `npm rebuild better-sqlite3` in the build stage to make sure the binary matches the target arch. The `postinstall` hook in this monorepo already does this for local installs [verified: commit `3cc7ccf` in the recent log — "postinstall rebuilds better-sqlite3 against current Node"].
- Non-root user `brainstorm-relay` (UID 1000), `WORKDIR /app`, `EXPOSE 8443 8444`.
- `ENTRYPOINT ["node", "/app/packages/relay/dist/bin.js"]`.

**This Dockerfile is Brainstorm-side work.** It belongs in `packages/relay/deploy/Dockerfile` next to the systemd unit. I have not written it as part of this requirements doc — that's a separate PR. Flagging it so your roadmap accounts for "we can't deploy until that PR lands."

---

## 4. Dependency Graph

What depends on what, in install order:

```
┌─────────────────────────────────────────────────────────────────┐
│ 0. K8s cluster (already shipped per peer brief)                 │
└──────────────────────────────────┬──────────────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                │                                     │
                ▼                                     ▼
┌───────────────────────────┐         ┌───────────────────────────┐
│ 1. CSI driver             │         │ 1. cert-manager           │
│    (piraeus / equiv)      │         │    (Helm chart)           │
└──────────────┬────────────┘         └──────────────┬────────────┘
               │                                     │
               ▼                                     ▼
┌───────────────────────────┐         ┌───────────────────────────┐
│ 2. StorageClass           │         │ 2. ClusterIssuer          │
│    pointing at CSI        │         │    (Let's Encrypt)        │
└──────────────┬────────────┘         └──────────────┬────────────┘
               │                                     │
               │             ┌───────────────────────┤
               │             ▼                       │
               │    ┌──────────────────┐             │
               │    │ 3. ingress-nginx │             │
               │    │    controller    │             │
               │    └────────┬─────────┘             │
               │             │                       │
               │             └───────────┬───────────┘
               │                         │
               ▼                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ 4. Image registry (ghcr.io for Q2; internal later)               │
│    + Dockerfile published as `brainstorm-relay:v0.1.0` image     │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ 5. Relay namespace + RBAC + ServiceAccount                       │
│    + ConfigMap + Secret (with generated keys)                    │
│    + PVC (using StorageClass from step 2)                        │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ 6. Deployment (uses image from step 4, mounts PVC + Secret)      │
│    + Service (ClusterIP)                                         │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ 7. Ingress (path-routed, with cert from cert-manager)            │
│    DNS A-record points at ingress-nginx LB                       │
└──────────────────────────────────────────────────────────────────┘
```

**Critical orderings:**

- CSI driver before any PVC. PVCs without a working CSI sit in `Pending` forever.
- cert-manager before Ingress (or simultaneously). Ingress without a cert is reachable on HTTP and Caddy/Let's Encrypt'll fall over on the first WS upgrade.
- ingress-nginx before any external traffic. Until the controller is up and DNS points at its LB IP, nothing external can reach the relay.
- Relay container image before Deployment. Deployment will `ImagePullBackOff` otherwise. This is the single hard gate between Brainstorm-side work and brainstormVM-side work.

**Parallelizable:**

- CSI install and cert-manager install are independent.
- ingress-nginx install is independent of the CSI work.
- Building the relay container image is independent of everything cluster-side (Brainstorm-side, can happen any time).

---

## 5. What This Document Is NOT

Explicit non-claims, so neither side reads more into this than is here:

- **Not a Helm chart.** The next layer of work is "turn the §2 primitives into a Helm chart or Kustomize overlay." That belongs in a `deploy/k8s/` directory, probably owned by Brainstorm-side, possibly co-owned. It's a separate scope item. This doc is requirements input; the chart is the artifact.

- **Not a security review of the cluster.** PSP/PSA, NetworkPolicy, RBAC tightening, image scanning, secrets-at-rest encryption — all real concerns, all brainstormVM-side. The container's own security posture is described in §2.1 (`runAsNonRoot`, dropped capabilities, read-only root FS) and mirrors the systemd hardening posture in `relay.service:16–28`. Beyond that, your cluster's defaults apply.

- **Not a multi-tenant deployment story.** The relay at v0.1.0 is single-tenant (one tenant key, one operator key) [verified: `bin.ts:62–86` only reads one `*_KEY_HEX` per role; multi-tenant is post-MVP per `README.md:117–118`]. A future multi-tenant relay needs different secret-management patterns (per-tenant secrets, key-rotation primitives) but that's a v0.2.0+ conversation.

- **Not a high-availability story.** Single replica is the only supported posture. HA needs the audit-log architecture replaced (network DB instead of per-process SQLite) and is gated on a different MVP. If the dogfood deployment pretends to be HA by setting `replicas: 2`, the audit log fragments and nonce-replay protection stops working. Don't.

- **Not a migration plan from the systemd deploy.** The systemd single-host deploy in `packages/relay/deploy/` is fully validated [verified: `packages/relay/deploy/README.md:62` — "Validated end-to-end on throwaway AWS Ubuntu 24.04 instance"]. K8s deploy is additive, not a replacement; both should keep working through Q2 at minimum. If the systemd path stops being supported, that's a separate Brainstorm-side decision.

- **Not a load test.** The §1 numbers are inferred or guessed, not measured. Before you size a real prod deployment, run a synthetic dispatch load against the relay and re-derive the resource envelope.

---

## 6. Open Questions (for `0bz7aztr` to answer or push back on)

These are genuine unknowns from my side. Answer the ones you can, push back on the ones I'm wrong about.

### 6.1 Outbound network policy for BR

The relay needs to reach `https://api.brainstormrouter.com` for two paths in the v0.1.0 design [inferred — I have not traced this in the relay source; the BR-call paths I'm aware of are operator-side, not relay-side]:

- CAF mTLS verification (if/when the relay does cross-cluster auth).
- Dispatch-outcomes POST (telemetry back to BR).

**Question:** Does the brainstormVM-managed K8s cluster's `NetworkPolicy` default-deny egress, and if so, do you have a pattern for "this workload is allowed outbound 443 to a specific FQDN"? Or do we punt and say "relay pod is in a namespace with permissive egress"?

I don't want to design the egress posture for you; I just want to know whether this is going to bite us at first-deploy time.

### 6.2 Secret-management path

The Brainstorm side keeps secrets in 1Password (`Dev Keys` vault) and pulls them via `op read` at process-start. That doesn't translate cleanly to K8s.

**Question:** Does brainstormVM have a preferred secret-management story?

- `sealed-secrets` (Bitnami)? — secrets committed to git, decrypted by controller in-cluster.
- `external-secrets` operator? — pulls from an external vault (1Password, Vault, AWS SM, GCP SM, etc.).
- Mounted from a vault sidecar (`vault-agent-injector`)? — sidecar populates a tmpfs file the relay reads.
- Plain `Secret` resources, provisioned by some out-of-band mechanism? — fine for v0.1.0 dogfood, not fine long-term.

If you have a strong preference, the §2.7 `Secret` definition becomes "use that pattern." If you don't, I'll default to plain `Secret` for the dogfood deploy and we'll revisit.

### 6.3 Rolling-update / drain semantics for SQLite WAL

The relay holds three SQLite databases open with WAL journal files (`audit.db`, `audit.db-wal`, `nonces.db`, `nonces.db-wal`, `endpoints.db`, `endpoints.db-wal`) [verified: `audit.ts:57`, `nonce-store.ts:49`, `enrollment.ts:75`]. On `SIGTERM` the relay calls `audit.close()`, `nonces.close()`, `registry.close()` [verified: `bin.ts:178–181`], which cleanly checkpoints the WAL and closes the DBs.

**Question:** Does the cluster's pod-eviction posture give the relay enough time to complete that shutdown? K8s default `terminationGracePeriodSeconds` is 30s. Closing three SQLite DBs takes single-digit ms in the happy case [inferred from better-sqlite3 internals], but if there's a long-running dispatch in flight, the ACK-timeout (5s) plus shutdown time could push past 10s. 30s should be plenty, but:

- Should we explicitly set `terminationGracePeriodSeconds: 60` on the Deployment to be safe?
- Should we add a `preStop` hook that does a quick "drain" — refuse new operator connections, wait for in-flight dispatches to ACK, then exit?
- Or is "kill -TERM, audit log finalizes, restart, no drain" acceptable?

My current view is: with `strategy.type: Recreate` and a 30–60s grace period, no preStop hook is needed for v0.1.0. But you know your cluster's eviction patterns better than I do.

### 6.4 Backup / DR for the PVC

Once the relay is on a CSI-backed PVC, the audit log is real persistent data with regulatory implications (it's the chain of custody for every dispatched command, hash-chained per PR #281).

**Question:** Does brainstormVM have a snapshot/backup pattern for stateful workloads? I'd assume "yes, LINSTOR snapshots + off-cluster sync" but I don't know your conventions. Tell me what to put in the runbook.

### 6.5 Image-pull policy and signed images

If the cluster enforces image signing (cosign, sigstore policy controller), the relay image needs to be signed at publish time. That's Brainstorm-side CI work, not blocking, but it'd be useful to know.

**Question:** Does brainstormVM enforce a signing policy on cluster-pulled images? If yes, what tool?

---

## 7. Reference Manifest Sketches

These are NOT a prescription — they're the v0.1.0-compatible shape of what §2 implies, so you can sanity-check the requirements against concrete YAML. A real Helm chart will template these. Treat any specific value here as "the minimum that won't crash on first pod start," not "the right value for your environment."

### 7.1 `Deployment` sketch

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: brainstorm-relay
  namespace: brainstorm-relay
  labels:
    app.kubernetes.io/name: brainstorm-relay
    app.kubernetes.io/version: "0.1.0"
spec:
  replicas: 1
  strategy:
    type: Recreate     # see §2.1: rolling-update would race on the SQLite WAL
  selector:
    matchLabels:
      app.kubernetes.io/name: brainstorm-relay
  template:
    metadata:
      labels:
        app.kubernetes.io/name: brainstorm-relay
    spec:
      serviceAccountName: brainstorm-relay
      terminationGracePeriodSeconds: 60   # see §6.3
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: relay
          image: ghcr.io/justinjilg/brainstorm-relay:v0.1.0   # not yet built — see §3.5
          imagePullPolicy: IfNotPresent
          command: ["node", "/app/packages/relay/dist/bin.js"]
          ports:
            - name: ws
              containerPort: 8443
              protocol: TCP
            - name: http
              containerPort: 8444
              protocol: TCP
          envFrom:
            - configMapRef:
                name: brainstorm-relay-config
            - secretRef:
                name: brainstorm-relay-secrets
          resources:
            requests:
              memory: 128Mi
              cpu: 100m
            limits:
              memory: 256Mi
              cpu: 500m
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: data
              mountPath: /var/lib/brainstorm-relay
            - name: tmp
              mountPath: /tmp
          readinessProbe:
            tcpSocket:
              port: ws
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: ws
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: brainstorm-relay-data
        - name: tmp
          emptyDir: {}
```

### 7.2 `PersistentVolumeClaim` sketch

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: brainstorm-relay-data
  namespace: brainstorm-relay
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
  storageClassName: piraeus-csi-replicated   # or whatever your CSI exposes
```

### 7.3 `Service` sketch

```yaml
apiVersion: v1
kind: Service
metadata:
  name: brainstorm-relay
  namespace: brainstorm-relay
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: brainstorm-relay
  ports:
    - name: ws
      port: 8443
      targetPort: ws
    - name: http
      port: 8444
      targetPort: http
```

### 7.4 `Ingress` sketch (ingress-nginx)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: brainstorm-relay
  namespace: brainstorm-relay
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    # WS upgrades: ingress-nginx auto-detects Upgrade header; no extra annotation needed
spec:
  ingressClassName: nginx
  tls:
    - hosts: [relay.example.com]
      secretName: brainstorm-relay-tls
  rules:
    - host: relay.example.com
      http:
        paths:
          - path: /v1/operator
            pathType: Prefix
            backend: { service: { name: brainstorm-relay, port: { name: ws } } }
          - path: /v1/endpoint/connect
            pathType: Prefix
            backend: { service: { name: brainstorm-relay, port: { name: ws } } }
          - path: /v1/endpoint/enroll
            pathType: Exact
            backend: { service: { name: brainstorm-relay, port: { name: http } } }
          - path: /v1/admin/endpoint
            pathType: Prefix
            backend: { service: { name: brainstorm-relay, port: { name: http } } }
```

Note the ordering of `pathType: Exact` for `/v1/endpoint/enroll` vs `pathType: Prefix` for `/v1/admin/endpoint` — the admin prefix matches `/v1/admin/endpoint/enroll` and `/v1/admin/endpoint/<id>/rotate` together [verified: `enrollment.ts:312, 363`].

### 7.5 `ConfigMap` + `Secret` sketches

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: brainstorm-relay-config
  namespace: brainstorm-relay
data:
  BRAINSTORM_RELAY_HOST: "127.0.0.1"
  BRAINSTORM_RELAY_PORT_WS: "8443"
  BRAINSTORM_RELAY_PORT_HTTP: "8444"
  BRAINSTORM_RELAY_DATA_DIR: "/var/lib/brainstorm-relay"
  BRAINSTORM_RELAY_OPERATOR_ID: "operator@local"
  BRAINSTORM_RELAY_TENANT_ID: "tenant-local"
---
apiVersion: v1
kind: Secret
metadata:
  name: brainstorm-relay-secrets
  namespace: brainstorm-relay
type: Opaque
stringData:
  # Generate exactly as bootstrap.sh:96–98 does:
  #   openssl rand -hex 32
  BRAINSTORM_RELAY_ADMIN_TOKEN: "<64 hex chars>"
  BRAINSTORM_RELAY_TENANT_KEY_HEX: "<64 hex chars — Ed25519 private key seed>"
  BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX: "<64 hex chars — 32-byte HMAC key>"
```

If you adopt `external-secrets` or `sealed-secrets` (see §6.2), this `Secret` becomes the rendered output of that controller. The shape is the same.

---

## 8. Observability and Runtime Concerns

Things that aren't structurally "K8s primitives" but matter for whether the deploy is operable.

### 8.1 Logs

The systemd unit pipes stdout to `/var/log/brainstorm-relay/relay.log` and stderr to `relay.err` [verified: `relay.service:31–32`]. The relay itself writes to stdout via `console.log` [verified: `bin.ts:158, 162, 165, 168, 175`]. There is no structured logger inside the relay at v0.1.0 — it's `[relay] message` on a line.

For K8s: stdout/stderr land in the kubelet's container-log path, which any log-shipping stack (`fluent-bit`, `vector`, `promtail`) can ingest. No special config needed. If your cluster's log retention is short, set up off-cluster shipping; the audit log itself is still the durable record (in the SQLite DB, not in stdout).

**Open follow-up (Brainstorm-side):** convert relay logging to structured JSON (pino) so log shippers can parse fields. Not blocking; flagged so you know the current shape.

### 8.2 Metrics

There are no Prometheus-style metrics emitted by the relay at v0.1.0. No `/metrics` endpoint, no counters, no histograms. The audit log is the closest thing to "metrics" — every dispatch, every late arrival, every nonce rejection is a row.

For K8s: at first deploy, set up basic Prometheus-via-kube-state-metrics + node-exporter for pod-level (CPU, memory, restart count). Don't try to scrape the relay process — there's nothing useful there yet. Brainstorm-side will add a metrics endpoint in a future release; track it as a known gap, not a blocker.

### 8.3 Tracing

No OpenTelemetry instrumentation in the relay at v0.1.0. The audit log gives you per-command lineage via `command_id` (which is a UUID stamped at dispatch and propagated through every state transition [verified: `audit.ts:39, 65–67`]). For end-to-end tracing across operator → relay → endpoint, you'd need to thread `command_id` into ingress-nginx access logs and any downstream observability you already run. Out of scope for this doc.

### 8.4 Audit log durability and retrieval

The audit log is the regulatory artifact. Some considerations:

- It's hash-chained at the per-row level (each row stores `payload_canonical_hash` of its own bytes [verified: `audit.ts:62–64, 70–89`]). It is NOT linked-list hash-chained across rows in v0.1.0; rows can be excised without breaking inter-row integrity. This may matter for compliance posture; if it does, that's a Brainstorm-side roadmap item.
- Retrieval is via `getByCommandId(command_id)` [verified: `audit.ts:116–143`]. There's no HTTP endpoint to query the audit log at v0.1.0 — it's read in-process by tests and (eventually) the operator CLI. For K8s, this means audit-log inspection requires either (a) `kubectl exec` into the pod and `sqlite3` the DB, or (b) a snapshot/copy of the PVC. Inelegant; flagged.
- WAL files: SQLite WAL mode produces `audit.db-wal` and `audit.db-shm` alongside the main file. Backups must capture all three or run a `PRAGMA wal_checkpoint(TRUNCATE)` first. If your CSI snapshot tool takes a crash-consistent snapshot, this works; if it does file-by-file copy, it might not. Verify with your team.

### 8.5 Pod-level telemetry contract

For a healthy relay pod, expect:

- `kubectl get pods -n brainstorm-relay` shows `1/1 Running`, `RESTARTS: 0`.
- `kubectl logs -n brainstorm-relay <pod>` shows three startup lines: WS listening, HTTP listening, data dir, tenant_id [verified: `bin.ts:162–171`].
- `kubectl exec -n brainstorm-relay <pod> -- ls /var/lib/brainstorm-relay/` shows `audit.db`, `audit.db-wal`, `audit.db-shm`, `nonces.db` (etc.), `endpoints.db` (etc.) — appearing within seconds of first dispatch.
- TCP probe on `:8443` and `:8444` from inside the cluster succeeds.
- `curl -k https://relay.example.com/v1/admin/endpoint/enroll -H 'Authorization: Bearer <admin-token>' -d '{"tenant_id":"tenant-local"}'` returns a `bootstrap_token` JSON response [verified: `packages/relay/deploy/README.md:34–36`].

If any of those don't hold post-deploy, that's the debug path.

---

## 9. Glossary / Anchors

For mutual ground-truth — these are the terms-of-art I'm using:

- **Relay** = the `@brainst0rm/relay` package, single Node process, source at `packages/relay/src/`.
- **Operator** = the CLI/SDK side that issues commands. Connects to relay over WS at `/v1/operator`.
- **Endpoint** = `brainstorm-agent`, the on-host agent that executes commands. Connects to relay over WS at `/v1/endpoint/connect`. Owned by `crd4sdom`.
- **Tenant** = the keying boundary. v0.1.0 supports exactly one tenant per relay process; multi-tenant is post-MVP.
- **CommandEnvelope** = the signed wire frame from operator to endpoint, transported through the relay. Bound to a specific endpoint (anti-replay).
- **Audit log** = the SQLite table at `audit.db` that records every operator-emitted byte verbatim plus relay-internal annotations. Anti-contamination invariant per `audit.ts:6–13`.
- **Nonce store** = the SQLite table at `nonces.db` that prevents replay of CommandEnvelopes within a clock-skew window.
- **Endpoint registry** = the SQLite table at `endpoints.db` that maps `endpoint_id` → enrollment state + public key.
- **CAF** = Cluster-Authoritative Federation, the future cross-cluster auth path. Out of scope for v0.1.0; flagged in §6.1 because it shapes egress policy.
- **Single-host deploy** = the systemd + Caddy installer at `packages/relay/deploy/`, validated end-to-end on Ubuntu 24.04 [verified].

---

## 10. Verification Status Map

What I claim vs. what I verified, in one table, so you can spot-check.

| Claim | Status | Source |
|---|---|---|
| Relay is single Node 22 process | verified | `bin.ts:1–207` |
| WS port default 8443, paths `/v1/operator` + `/v1/endpoint/connect` | verified | `bin.ts:89, 163` |
| HTTP port default 8444, paths `/v1/admin/endpoint/enroll`, `/v1/endpoint/enroll`, `/v1/admin/endpoint/<id>/rotate` | verified | `enrollment.ts:312, 330, 363` |
| Relay binds 127.0.0.1 by default | verified | `bin.ts:91` |
| Three SQLite DBs (audit, nonces, endpoints) all in WAL mode | verified | `audit.ts:57`, `nonce-store.ts:49`, `enrollment.ts:75` |
| Three secrets generated by `openssl rand -hex 32` | verified | `bootstrap.sh:96–98` |
| Tenant key + operator HMAC key validated to 32 bytes | verified | `bin.ts:69–86` |
| TLS terminated by Caddy, not by relay | verified | `Caddyfile.template`, `README.md:115` |
| systemd unit hardened: NoNewPrivileges, ProtectSystem=strict, etc. | verified | `relay.service:16–28` |
| `LimitNOFILE=65536` | verified | `relay.service:14` |
| Single-replica only at v0.1.0 | verified | `README.md:117–120` |
| ~50 MB RSS at idle | guess, not measured | — |
| ~150 MiB compressed image size | guess | inferred from Node 22 alpine baseline |
| `better-sqlite3` requires fsync (i.e. fails on tmpfs) | inferred | better-sqlite3 docs + WAL semantics; not directly tested by Brainstorm |
| `ingress-nginx` WebSocket annotations (`proxy-read-timeout: 3600`) | inferred | typical WS deploy patterns; verify against your conventions |
| Outbound BR HTTPS calls happen from relay | inferred | I have not grepped relay source for `api.brainstormrouter.com`; flagged as open question §6.1 |
| LINSTOR/DRBD is brainstormVM's storage pattern | inferred from peer brief | Verify against your CLAUDE.md |
| Container image does not currently exist | verified | No `Dockerfile` in `packages/relay/deploy/` or anywhere in the relay package |
| `postinstall` rebuilds `better-sqlite3` against current Node | verified | recent commit `3cc7ccf` |

---

## 11. Hand-off Checklist

If you're going to scope a 1–2 week roadmap item from this, here's the minimum boundary set:

**Brainstorm-side (us):**

1. Write `packages/relay/deploy/Dockerfile` (multi-stage Node 22 alpine, non-root, multi-arch). PR target: `main`.
2. Wire CI to publish `ghcr.io/justinjilg/brainstorm-relay:v0.1.0` (and `:latest`) on tag.
3. Add `GET /v1/health` to the HTTP server (low priority; TCP probes are fine for now).
4. Document the env-var contract in a stable place (already in `bin.ts:8–20`; promote to `packages/relay/deploy/CONFIG.md`).

**brainstormVM-side (you):**

1. Confirm CSI driver pick (piraeus or alternative) and StorageClass.
2. Confirm ingress controller pick and WS-friendly annotations.
3. Confirm cert-manager + Let's Encrypt path (HTTP-01 vs DNS-01).
4. Confirm secret-management story (§6.2).
5. Confirm egress policy for BR (§6.1).
6. Decide on backup/DR pattern for the PVC (§6.4).
7. Decide on image-signing policy (§6.5).

**Joint (whoever picks it up first):**

1. Helm chart or Kustomize overlay that materializes §2 into manifests.
2. Runbook: deploy, verify, rotate keys, restore from snapshot, decommission.
3. First end-to-end dogfood: relay deployed on brainstormVM K8s, real operator CLI dispatches a real endpoint command, audit log persists across pod restart, nonce-replay rejected after restart.

That last bullet is the success criterion for the dogfood phase. Everything else is plumbing.

---

## 12. Authors / Provenance

- **Drafted by:** Claude Opus 4.7 acting as Brainstorm-side technical decision-maker, with source-grounded reads of `packages/relay/src/bin.ts`, `packages/relay/src/audit.ts`, `packages/relay/src/enrollment.ts`, `packages/relay/src/nonce-store.ts`, `packages/relay/deploy/relay.service`, `packages/relay/deploy/Caddyfile.template`, `packages/relay/deploy/bootstrap.sh`, `packages/relay/deploy/README.md`, `packages/relay/README.md`.
- **Branch:** `docs/k8s-deploy-target-requirements`. No PR opened — Justin and `0bz7aztr` decide when to surface this.
- **Date:** 2026-04-27.
- **Relay version targeted:** `v0.1.0` (tag landed 2026-04-27).
- **Reviewers expected:** `0bz7aztr` (brainstormVM K8s scoping), `crd4sdom` (endpoint-side, for protocol-level cross-checks), Justin (final routing decision).

If anything in §1–§3 is wrong against your source, say so directly — I'd rather rewrite this doc than have it become load-bearing scaffolding for a roadmap that turns out to be misaligned.
