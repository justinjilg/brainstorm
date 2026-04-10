/**
 * BrainstormServer — the agent runtime as an HTTP service.
 *
 * Decouples the agent loop from the CLI. The server owns:
 * - Tool registry and execution
 * - Model routing and cost tracking
 * - Session and conversation management
 * - Memory (shared across conversations)
 * - God Mode connectors
 *
 * Clients (CLI, MCP, web UI, other agents) connect via HTTP/SSE.
 *
 * Endpoints:
 *   GET  /health                              Health + stats
 *   GET  /api/v1/products                     Connected God Mode products
 *   GET  /api/v1/tools                        All available tools
 *   POST /api/v1/tools/execute                Execute a tool directly
 *   GET  /api/v1/changesets                   Pending ChangeSets
 *   POST /api/v1/changesets/:id/approve       Approve + execute
 *   POST /api/v1/changesets/:id/reject        Reject
 *   GET  /api/v1/audit                        Tool execution audit trail
 *   GET  /api/v1/audit/changesets             God Mode changeset audit
 *   POST /api/v1/platform/events              Receive signed platform events
 *   POST /api/v1/chat                         Non-streaming chat
 *   POST /api/v1/chat/stream                  SSE streaming chat
 *   GET  /api/v1/conversations                List conversations
 *   POST /api/v1/conversations                Create conversation
 *   GET  /api/v1/conversations/:id            Get conversation
 *   PATCH /api/v1/conversations/:id           Update conversation
 *   DELETE /api/v1/conversations/:id          Delete conversation
 *   POST /api/v1/conversations/:id/fork       Fork conversation
 *   POST /api/v1/conversations/:id/handoff    Model handoff
 *   GET  /api/v1/conversations/:id/sessions   List conversation sessions
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { createLogger } from "@brainst0rm/shared";
import type { GodModeConnectionResult } from "@brainst0rm/godmode";
import type { ToolRegistry } from "@brainst0rm/tools";
import type { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type Database from "better-sqlite3";
import {
  runAgentLoop,
  buildSystemPrompt,
  SessionManager,
  createDefaultMiddlewarePipeline,
  ConversationManager,
} from "@brainst0rm/core";
import type { MemoryManager } from "@brainst0rm/core";
import type {
  ServerOptions,
  ChatRequest,
  ToolExecuteRequest,
  CreateConversationRequest,
  UpdateConversationRequest,
  HandoffRequest,
} from "./types.js";

const log = createLogger("server");

export interface ServerDependencies {
  db: Database.Database;
  config: any;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  tools: ToolRegistry;
  godmode: GodModeConnectionResult;
  memoryManager?: MemoryManager;
  version?: string;
}

export class BrainstormServer {
  private server: Server | null = null;
  private deps: ServerDependencies;
  private opts: Required<ServerOptions>;
  private conversationManager: ConversationManager | null = null;

  constructor(deps: ServerDependencies, opts?: ServerOptions) {
    this.deps = deps;
    this.opts = {
      port: opts?.port ?? 8000,
      host: opts?.host ?? "127.0.0.1",
      cors: opts?.cors ?? false,
      jwtSecret: opts?.jwtSecret ?? "",
      projectPath: opts?.projectPath ?? process.cwd(),
    };

    if (deps.memoryManager) {
      this.conversationManager = new ConversationManager(
        deps.db,
        deps.memoryManager,
      );
    }
  }

  /** Start the HTTP server. Returns a promise that resolves when listening. */
  async start(): Promise<{ url: string }> {
    const { port, host } = this.opts;

    // Security: refuse to start without auth on non-loopback interface.
    // POST /api/v1/god-mode/execute runs arbitrary operations on managed infrastructure —
    // exposing it without JWT auth is a critical security violation.
    if (!this.opts.jwtSecret) {
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        log.fatal(
          { host, port },
          "REFUSING TO START — jwtSecret required for non-loopback bind. Set BRAINSTORM_JWT_SECRET or bind to 127.0.0.1.",
        );
        process.exit(1);
      } else {
        log.info("Running in dev mode (no JWT auth) — localhost only");
      }
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as any)?.statusCode ?? 500;
        if (status >= 500) log.error({ err }, "Unhandled request error");
        this.errorResponse(res, status, msg);
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        const url = `http://${host}:${port}`;
        log.info({ url }, "Brainstorm server started");
        resolve({ url });
      });
    });
  }

  /** Stop the server gracefully. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        log.info("Brainstorm server stopped");
        this.server = null;
        resolve();
      });
    });
  }

  /** Get the underlying Node HTTP server (for testing or custom middleware). */
  getHttpServer(): Server | null {
    return this.server;
  }

  // ── Request Router ────────────────────────────────────────────────

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS" && this.opts.cors) {
      res.writeHead(204, this.corsHeaders());
      res.end();
      return;
    }

    // Health (no auth)
    if (path === "/health" && method === "GET") {
      return this.handleHealth(res);
    }

    // Auth gate for /api/* routes
    if (path.startsWith("/api/")) {
      const isLoopback =
        this.opts.host === "127.0.0.1" ||
        this.opts.host === "localhost" ||
        this.opts.host === "::1";

      if (this.opts.jwtSecret) {
        const authResult = await this.checkAuth(req);
        if (!authResult.ok) {
          return this.errorResponse(res, 401, authResult.error);
        }
        // Store authenticated identity for downstream handlers
        (req as any)._authPayload = authResult.ok
          ? (authResult as any).payload
          : undefined;
      } else if (!isLoopback) {
        // Refuse unauthenticated access on non-loopback interfaces
        return this.errorResponse(
          res,
          401,
          "Authentication required — set SUPABASE_JWT_SECRET",
        );
      }
    }

    // ── God Mode routes ───────────────────────────────────────────
    if (path === "/api/v1/products" && method === "GET")
      return this.handleProducts(res);
    if (path === "/api/v1/tools" && method === "GET")
      return this.handleTools(res);
    if (path === "/api/v1/tools/execute" && method === "POST")
      return this.handleToolExecute(req, res);
    if (path === "/api/v1/changesets" && method === "GET")
      return this.handleChangesets(res);

    const approveMatch = path.match(
      /^\/api\/v1\/changesets\/([^/]+)\/approve$/,
    );
    if (approveMatch && method === "POST")
      return this.handleChangesetApprove(approveMatch[1], req, res);

    const rejectMatch = path.match(/^\/api\/v1\/changesets\/([^/]+)\/reject$/);
    if (rejectMatch && method === "POST")
      return this.handleChangesetReject(rejectMatch[1], res);

    if (path === "/api/v1/audit" && method === "GET")
      return this.handleAudit(url, res);
    if (path === "/api/v1/audit/changesets" && method === "GET")
      return this.handleAuditChangesets(url, res);
    if (path === "/api/v1/platform/events" && method === "POST")
      return this.handlePlatformEvents(req, res);

    // ── Chat routes ───────────────────────────────────────────────
    if (path === "/api/v1/chat" && method === "POST")
      return this.handleChat(req, res);
    if (path === "/api/v1/chat/stream" && method === "POST")
      return this.handleChatStream(req, res);

    // ── Conversation routes ───────────────────────────────────────
    if (path === "/api/v1/conversations" && method === "GET")
      return this.handleListConversations(url, res);
    if (path === "/api/v1/conversations" && method === "POST")
      return this.handleCreateConversation(req, res);

    const convMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)$/);
    if (convMatch && method === "GET")
      return this.handleGetConversation(convMatch[1], res);
    if (convMatch && method === "PATCH")
      return this.handleUpdateConversation(convMatch[1], req, res);
    if (convMatch && method === "DELETE")
      return this.handleDeleteConversation(convMatch[1], res);

    const forkMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/fork$/);
    if (forkMatch && method === "POST")
      return this.handleForkConversation(forkMatch[1], req, res);

    const handoffMatch = path.match(
      /^\/api\/v1\/conversations\/([^/]+)\/handoff$/,
    );
    if (handoffMatch && method === "POST")
      return this.handleHandoff(handoffMatch[1], req, res);

    const sessionsMatch = path.match(
      /^\/api\/v1\/conversations\/([^/]+)\/sessions$/,
    );
    if (sessionsMatch && method === "GET")
      return this.handleConversationSessions(sessionsMatch[1], res);

    // ── Memory routes ──────────────────────────────────────────────
    if (path === "/api/v1/memory" && method === "GET")
      return this.handleListMemory(res);
    if (path === "/api/v1/memory" && method === "POST")
      return this.handleCreateMemory(req, res);
    const memoryMatch = path.match(/^\/api\/v1\/memory\/([^/]+)$/);
    if (memoryMatch && method === "PATCH")
      return this.handleUpdateMemory(memoryMatch[1], req, res);
    if (memoryMatch && method === "DELETE")
      return this.handleDeleteMemory(memoryMatch[1], res);
    if (path === "/api/v1/memory/dream" && method === "POST")
      return this.handleDreamCycle(res);

    // ── Skills routes ────────────────────────────────────────────
    if (path === "/api/v1/skills" && method === "GET")
      return this.handleListSkills(res);

    // ── Models route ─────────────────────────────────────────────
    if (path === "/api/v1/models" && method === "GET")
      return this.handleListModels(res);

    // ── Security route ───────────────────────────────────────────
    if (path === "/api/v1/security/red-team" && method === "POST")
      return this.handleRedTeam(req, res);

    // 404
    this.errorResponse(res, 404, `Not found: ${method} ${path}`);
  }

  // ── Health ────────────────────────────────────────────────────────

  private handleHealth(res: ServerResponse): void {
    let activeConvs = 0;
    try {
      const row = this.deps.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM conversations WHERE is_archived = 0",
        )
        .get() as any;
      activeConvs = row?.cnt ?? 0;
    } catch {
      // conversations table may not exist yet
    }

    this.json(res, 200, {
      status: "healthy",
      version: this.deps.version ?? "0.13.0",
      uptime_seconds: Math.floor(process.uptime()),
      god_mode: {
        connected: this.deps.godmode.connectedSystems.length,
        tools: this.deps.godmode.totalTools,
      },
      conversations: { active: activeConvs },
    });
  }

  // ── Products ──────────────────────────────────────────────────────

  private handleProducts(res: ServerResponse): void {
    const products = this.deps.godmode.connectedSystems.map((sys) => ({
      product: sys.name,
      display_name: sys.displayName,
      status: "healthy" as const,
      latency_ms: sys.latencyMs,
      tool_count: sys.toolCount,
      capabilities: sys.capabilities,
      last_checked: new Date().toISOString(),
    }));
    this.json(res, 200, this.envelope(products));
  }

  // ── Tools ─────────────────────────────────────────────────────────

  private handleTools(res: ServerResponse): void {
    this.json(res, 200, this.envelope(this.deps.tools.listTools()));
  }

  /** Tools that require explicit confirmation cannot be called via REST API. */
  private static readonly BLOCKED_TOOL_PERMISSIONS = new Set([
    "confirm",
    "deny",
  ]);

  private async handleToolExecute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody<ToolExecuteRequest>(req);
    if (!body.tool) {
      return this.errorResponse(res, 400, "Missing 'tool' field");
    }

    const tool = this.deps.tools.get(body.tool);
    if (!tool) {
      return this.errorResponse(res, 404, `Tool '${body.tool}' not found`);
    }

    // Enforce tool permission level — only "auto" tools can be called via API.
    // "confirm" tools (shell, file_write, git_commit) require interactive approval.
    if (BrainstormServer.BLOCKED_TOOL_PERMISSIONS.has(tool.permission)) {
      return this.errorResponse(
        res,
        403,
        `Tool '${body.tool}' requires '${tool.permission}' permission — use the agent loop instead`,
      );
    }

    try {
      const result = await tool.execute(body.params ?? {});
      this.json(
        res,
        200,
        this.envelope({
          tool: body.tool,
          result,
          executed_at: new Date().toISOString(),
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorResponse(res, 500, `Tool execution failed: ${msg}`);
    }
  }

  // ── ChangeSets ────────────────────────────────────────────────────

  private async handleChangesets(res: ServerResponse): Promise<void> {
    const { listChangeSets } = await import("@brainst0rm/godmode");
    this.json(res, 200, this.envelope(listChangeSets()));
  }

  private async handleChangesetApprove(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { approveChangeSet } = await import("@brainst0rm/godmode");
    // Use authenticated identity from JWT, fall back to "user" for dev mode
    const authPayload = (req as any)._authPayload;
    const approver = authPayload?.email ?? authPayload?.sub ?? "user";
    const result = await approveChangeSet(id, approver);
    this.json(res, result.success ? 200 : 400, this.envelope(result));
  }

  private async handleChangesetReject(
    id: string,
    res: ServerResponse,
  ): Promise<void> {
    const { rejectChangeSet } = await import("@brainst0rm/godmode");
    const result = rejectChangeSet(id);
    this.json(res, result.success ? 200 : 400, this.envelope(result));
  }

  // ── Audit ─────────────────────────────────────────────────────────

  private handleAudit(url: URL, res: ServerResponse): void {
    const limit = this.safeInt(url.searchParams.get("limit"), 50);
    const offset = this.safeInt(url.searchParams.get("offset"), 0);
    try {
      const rows = this.deps.db
        .prepare(
          "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .all(limit, offset);
      this.json(res, 200, this.envelope({ entries: rows, limit, offset }));
    } catch {
      this.json(res, 200, this.envelope({ entries: [], limit, offset }));
    }
  }

  private async handleAuditChangesets(
    url: URL,
    res: ServerResponse,
  ): Promise<void> {
    const { ChangeSetLogRepository } = await import("@brainst0rm/db");
    const csLog = new ChangeSetLogRepository(this.deps.db);
    const limit = this.safeInt(url.searchParams.get("limit"), 50);
    const offset = this.safeInt(url.searchParams.get("offset"), 0);
    const connector = url.searchParams.get("connector");
    const entries = connector
      ? csLog.byConnector(connector, limit)
      : csLog.recent(limit, offset);
    this.json(
      res,
      200,
      this.envelope({ entries, total: csLog.count(), limit, offset }),
    );
  }

  // ── Platform Events ───────────────────────────────────────────────

  private async handlePlatformEvents(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const masterSecret = process.env.BRAINSTORM_PLATFORM_SECRET;

    if (!masterSecret) {
      return this.errorResponse(res, 503, "Platform secret not configured");
    }

    const { verifyEvent } = await import("@brainst0rm/godmode");
    if (!verifyEvent(body, masterSecret)) {
      return this.errorResponse(res, 401, "Invalid event signature");
    }

    log.info(
      { type: body.type, product: body.product, tenant: body.tenant_id },
      "Platform event received",
    );
    this.json(res, 200, this.envelope({ received: true, event_id: body.id }));
  }

  // ── Chat ──────────────────────────────────────────────────────────

  private async handleChat(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody<ChatRequest>(req);
    if (!body.message) {
      return this.errorResponse(res, 400, "Missing 'message' field");
    }

    const {
      session,
      systemPrompt,
      segments,
      conversationId,
      preferredModelId,
    } = this.prepareChat(body);

    const messages = [{ role: "user" as const, content: body.message }];
    let finalText = "";
    let totalCost = 0;

    for await (const event of runAgentLoop(messages, {
      config: this.deps.config,
      registry: this.deps.registry,
      router: this.deps.router,
      costTracker: this.deps.costTracker,
      tools: this.deps.tools,
      sessionId: session.id,
      projectPath: this.opts.projectPath,
      systemPrompt,
      systemSegments: segments,
      permissionCheck: () => "allow" as const,
      middleware: createDefaultMiddlewarePipeline(this.opts.projectPath),
      preferredModelId,
    })) {
      if (event.type === "text-delta") finalText += event.delta;
      if (event.type === "done") totalCost = event.totalCost;
    }

    this.json(
      res,
      200,
      this.envelope({
        response: finalText,
        session_id: session.id,
        conversation_id: conversationId,
        cost: totalCost,
      }),
    );
  }

  private async handleChatStream(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody<ChatRequest>(req);
    if (!body.message) {
      return this.errorResponse(res, 400, "Missing 'message' field");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(this.opts.cors ? { "Access-Control-Allow-Origin": "*" } : {}),
    });

    const {
      session,
      systemPrompt,
      segments,
      conversationId,
      preferredModelId,
    } = this.prepareChat(body);

    // Send session info first
    res.write(
      `data: ${JSON.stringify({ type: "session", sessionId: session.id, conversationId })}\n\n`,
    );

    const messages = [{ role: "user" as const, content: body.message }];

    for await (const event of runAgentLoop(messages, {
      config: this.deps.config,
      registry: this.deps.registry,
      router: this.deps.router,
      costTracker: this.deps.costTracker,
      tools: this.deps.tools,
      sessionId: session.id,
      projectPath: this.opts.projectPath,
      systemPrompt,
      systemSegments: segments,
      permissionCheck: () => "allow" as const,
      middleware: createDefaultMiddlewarePipeline(this.opts.projectPath),
      preferredModelId,
    })) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done" || event.type === "error") break;
    }

    res.write("data: [DONE]\n\n");
    res.end();
  }

  // ── Conversations ─────────────────────────────────────────────────

  private handleListConversations(url: URL, res: ServerResponse): void {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const projectPath = url.searchParams.get("project") ?? undefined;
    const includeArchived = url.searchParams.get("archived") === "true";
    const limit = this.safeInt(url.searchParams.get("limit"), 50);
    const convs = this.conversationManager.list(projectPath, {
      includeArchived,
      limit,
    });
    this.json(res, 200, this.envelope(convs));
  }

  private async handleCreateConversation(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const body = await this.readBody<CreateConversationRequest>(req);
    const conv = this.conversationManager.create(this.opts.projectPath, body);
    this.json(res, 201, this.envelope(conv));
  }

  private handleGetConversation(id: string, res: ServerResponse): void {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const conv = this.conversationManager.get(id);
    if (!conv) return this.errorResponse(res, 404, "Conversation not found");

    const context = this.conversationManager.getContext(id);
    this.json(
      res,
      200,
      this.envelope({
        ...conv,
        totalCost: this.conversationManager.getTotalCost(id),
        totalMessages: this.conversationManager.getTotalMessages(id),
        effectiveModel: context?.effectiveModel ?? null,
      }),
    );
  }

  private async handleUpdateConversation(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const body = await this.readBody<UpdateConversationRequest>(req);
    const conv = this.conversationManager.update(id, body);
    if (!conv) return this.errorResponse(res, 404, "Conversation not found");
    this.json(res, 200, this.envelope(conv));
  }

  private handleDeleteConversation(id: string, res: ServerResponse): void {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const deleted = this.conversationManager.delete(id);
    if (!deleted) return this.errorResponse(res, 404, "Conversation not found");
    this.json(res, 200, this.envelope({ deleted: true }));
  }

  private async handleForkConversation(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const body = await this.readBody<{ name?: string }>(req);
    const forked = this.conversationManager.fork(id, body.name);
    if (!forked) return this.errorResponse(res, 404, "Conversation not found");
    this.json(res, 201, this.envelope(forked));
  }

  private async handleHandoff(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const body = await this.readBody<HandoffRequest>(req);
    if (!body.modelId) {
      return this.errorResponse(res, 400, "Missing 'modelId' field");
    }
    const conv = this.conversationManager.handoff(id, body.modelId);
    if (!conv) return this.errorResponse(res, 404, "Conversation not found");
    this.json(res, 200, this.envelope(conv));
  }

  private handleConversationSessions(id: string, res: ServerResponse): void {
    if (!this.conversationManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const conv = this.conversationManager.get(id);
    if (!conv) return this.errorResponse(res, 404, "Conversation not found");
    const sessions = this.conversationManager.getSessions(id);
    this.json(res, 200, this.envelope(sessions));
  }

  // ── Memory ────────────────────────────────────────────────────────

  private handleListMemory(res: ServerResponse): void {
    if (!this.deps.memoryManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const entries = this.deps.memoryManager.list();
    this.json(res, 200, this.envelope(entries));
  }

  private async handleCreateMemory(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.deps.memoryManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const body = await this.readBody<{
      name: string;
      content: string;
      type?: string;
      tier?: string;
      source?: string;
    }>(req);
    if (!body.name || !body.content) {
      return this.errorResponse(res, 400, "name and content required");
    }
    const entry = this.deps.memoryManager.save({
      name: body.name,
      description: body.name,
      type: (body.type as any) ?? "project",
      content: body.content,
      source: (body.source as any) ?? "user_input",
      trustScore: 1.0,
    });
    this.json(res, 201, this.envelope(entry));
  }

  private async handleUpdateMemory(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.deps.memoryManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    const body = await this.readBody<{
      content?: string;
      tier?: string;
    }>(req);
    try {
      if (body.tier === "system") {
        this.deps.memoryManager.promote(id);
      } else if (body.tier === "quarantine") {
        this.deps.memoryManager.quarantine(id);
      } else if (body.tier === "archive") {
        this.deps.memoryManager.demote(id);
      }
      this.json(res, 200, this.envelope({ updated: true, id }));
    } catch (err: any) {
      this.errorResponse(res, 404, err.message ?? "Entry not found");
    }
  }

  private handleDeleteMemory(id: string, res: ServerResponse): void {
    if (!this.deps.memoryManager) {
      return this.errorResponse(res, 503, "Memory manager not configured");
    }
    try {
      this.deps.memoryManager.delete(id);
      this.json(res, 200, this.envelope({ deleted: true, id }));
    } catch (err: any) {
      this.errorResponse(res, 404, err.message ?? "Entry not found");
    }
  }

  private handleDreamCycle(res: ServerResponse): void {
    // Dream cycle requires infrastructure not available via HTTP
    // Return accepted status — the CLI or desktop app triggers it directly
    this.json(
      res,
      202,
      this.envelope({
        status: "dream_acknowledged",
        message:
          "Dream cycle must be triggered from the CLI or desktop app directly",
      }),
    );
  }

  // ── Skills ───────────────────────────────────────────────────────

  private handleListSkills(res: ServerResponse): void {
    import("@brainst0rm/core").then(({ loadSkills }) => {
      try {
        const skills = loadSkills(this.opts.projectPath);
        const list = skills.map((s) => ({
          name: s.name,
          description: s.description ?? "",
          source: s.source ?? "builtin",
          content: s.content.slice(0, 500),
        }));
        this.json(res, 200, this.envelope(list));
      } catch {
        this.json(res, 200, this.envelope([]));
      }
    });
  }

  // ── Models ───────────────────────────────────────────────────────

  private handleListModels(res: ServerResponse): void {
    const models = this.deps.registry.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      status: m.status,
      pricing: m.pricing,
      capabilities: m.capabilities,
    }));
    this.json(res, 200, this.envelope(models));
  }

  // ── Security ─────────────────────────────────────────────────────

  private async handleRedTeam(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody<{
      generations?: number;
      populationSize?: number;
    }>(req);

    try {
      const { runRedTeamSimulation, createDefaultMiddlewarePipeline } =
        await import("@brainst0rm/core");
      const pipeline = createDefaultMiddlewarePipeline(this.opts.projectPath);
      const scorecard = runRedTeamSimulation(pipeline, {
        generations: body.generations ?? 5,
        populationSize: body.populationSize ?? 30,
      });
      this.json(res, 200, this.envelope(scorecard));
    } catch (err: any) {
      this.errorResponse(res, 500, err.message ?? "Red team simulation failed");
    }
  }

  // ── Chat Helpers ──────────────────────────────────────────────────

  private prepareChat(body: ChatRequest): {
    session: import("@brainst0rm/shared").Session;
    systemPrompt: string;
    segments: import("@brainst0rm/core").SystemPromptSegment[];
    conversationId?: string;
    preferredModelId?: string;
  } {
    const sessionManager = new SessionManager(this.deps.db);
    const { prompt: sysPrompt, segments } = buildSystemPrompt(
      this.opts.projectPath,
    );
    const gmPromptText = this.deps.godmode.promptSegment?.text ?? "";
    let systemPrompt = sysPrompt + gmPromptText;
    let preferredModelId = body.modelId;

    let session: import("@brainst0rm/shared").Session;
    let conversationId = body.conversationId;

    // If conversation specified, use its context
    if (conversationId && this.conversationManager) {
      const ctx = this.conversationManager.getContext(conversationId);
      if (ctx) {
        // Inject conversation memory context
        const memCtx =
          this.conversationManager.getContextString(conversationId);
        if (memCtx) systemPrompt += `\n\n${memCtx}`;

        // Use conversation's model override if no explicit model requested
        if (ctx.effectiveModel && !preferredModelId) {
          preferredModelId = ctx.effectiveModel;
        }
      }

      // Start a new session within the conversation
      const result = this.conversationManager.startSession(conversationId);
      if (result) {
        session = result.session;
      } else {
        session = sessionManager.start(this.opts.projectPath);
      }
    } else if (body.sessionId) {
      // Resume existing session
      const existing = sessionManager.resume(body.sessionId);
      session = existing ?? sessionManager.start(this.opts.projectPath);
    } else {
      // New standalone session
      session = sessionManager.start(this.opts.projectPath);

      // Auto-create a conversation if memory manager is available
      if (this.conversationManager) {
        const conv = this.conversationManager.create(this.opts.projectPath, {
          name: body.message.slice(0, 60),
        });
        conversationId = conv.id;
        // Use the manager's startSession path (handles linkSession + touchLastMessage)
        const result = this.conversationManager.startSession(conv.id);
        if (result) {
          session = result.session;
        }
      }
    }

    return {
      session,
      systemPrompt,
      segments,
      conversationId,
      preferredModelId,
    };
  }

  // ── Auth ──────────────────────────────────────────────────────────

  private async checkAuth(req: IncomingMessage): Promise<
    | {
        ok: true;
        payload?: { sub?: string; email?: string; platform_role?: string };
      }
    | { ok: false; error: string }
  > {
    const { verifyJWT, extractBearerToken } =
      await import("@brainst0rm/godmode");
    const token = extractBearerToken(
      req.headers.authorization as string | undefined,
    );
    if (!token) return { ok: false, error: "Missing Authorization header" };

    const auth = verifyJWT(token, this.opts.jwtSecret);
    if (!auth.authenticated)
      return { ok: false, error: auth.error ?? "Authentication failed" };

    return { ok: true, payload: auth.payload };
  }

  // ── HTTP Helpers ──────────────────────────────────────────────────

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      ...(this.opts.cors ? this.corsHeaders() : {}),
    });
    res.end(payload);
  }

  private envelope<T>(data: T) {
    return {
      ok: true as const,
      data,
      request_id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private errorResponse(
    res: ServerResponse,
    status: number,
    message: string,
  ): void {
    this.json(res, status, {
      ok: false,
      error: message,
      request_id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }

  private async readBody<T = any>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
    }
  }

  /** Parse an integer from a query param, falling back to a default on NaN. */
  private safeInt(value: string | null, fallback: number): number {
    if (!value) return fallback;
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  private corsHeaders() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };
  }
}
