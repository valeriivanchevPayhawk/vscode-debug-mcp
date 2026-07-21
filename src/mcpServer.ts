import * as http from "http";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DebugBridge } from "./debugBridge";

/**
 * Wrap a tool handler so any thrown error is returned as a readable MCP tool
 * error result instead of crashing the transport.
 */
function tool<T>(fn: (args: T) => Promise<any> | any) {
  return async (args: T) => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
      };
    }
  };
}

/**
 * Build a fully-configured MCP server wired to the given DebugBridge.
 * A fresh server is created per request (stateless HTTP transport).
 */
function buildServer(bridge: DebugBridge): McpServer {
  const server = new McpServer({ name: "vscode-debug-mcp", version: "0.1.0" });

  server.tool(
    "get_status",
    "Report the MCP/debug status: active session, whether execution is paused, and where.",
    {},
    tool(() => bridge.getStatus()),
  );

  server.tool(
    "list_debug_configurations",
    "List launch.json debug configurations available in the open workspace folders.",
    {},
    tool(() => bridge.listConfigurations()),
  );

  server.tool(
    "start_debug_session",
    "Start a debug session from a launch.json config name or an inline config object.",
    {
      configName: z.string().optional().describe("Name of a launch.json configuration."),
      config: z
        .record(z.any())
        .optional()
        .describe("Inline debug configuration object (alternative to configName)."),
      folder: z.string().optional().describe("Workspace folder name or path (defaults to first)."),
      noDebug: z.boolean().optional().describe("Run without attaching the debugger."),
    },
    tool((a: any) => bridge.startSession(a)),
  );

  server.tool(
    "stop_debug_session",
    "Stop a debug session (the active one unless sessionId is given).",
    { sessionId: z.string().optional() },
    tool((a: any) => bridge.stopSession(a.sessionId)),
  );

  server.tool(
    "set_breakpoint",
    "Set a source breakpoint. Supports conditional breakpoints, hit conditions and logpoints (logMessage).",
    {
      file: z.string().describe("Absolute path to the source file."),
      line: z.number().int().describe("1-based line number."),
      column: z.number().int().optional().describe("1-based column."),
      condition: z.string().optional().describe("Expression; breaks only when truthy."),
      hitCondition: z.string().optional().describe("e.g. '>5' to break after N hits."),
      logMessage: z
        .string()
        .optional()
        .describe("Turns this into a logpoint (does not pause). Use {expr} interpolation."),
    },
    tool((a: any) => bridge.setBreakpoint(a)),
  );

  server.tool(
    "remove_breakpoints",
    "Remove breakpoints: all of them, all in a file, or a specific file+line.",
    {
      file: z.string().optional(),
      line: z.number().int().optional(),
      all: z.boolean().optional(),
    },
    tool((a: any) => bridge.removeBreakpoints(a)),
  );

  server.tool(
    "list_breakpoints",
    "List all source breakpoints currently set.",
    {},
    tool(() => bridge.listBreakpoints()),
  );

  server.tool(
    "continue_execution",
    "Resume execution (continue) on the paused thread.",
    { sessionId: z.string().optional(), threadId: z.number().int().optional() },
    tool((a: any) => bridge.continue(a)),
  );

  server.tool(
    "pause_execution",
    "Pause a running thread.",
    { sessionId: z.string().optional(), threadId: z.number().int().optional() },
    tool((a: any) => bridge.pause(a)),
  );

  const stepArgs = {
    sessionId: z.string().optional(),
    threadId: z.number().int().optional(),
    waitForStop: z.boolean().optional().describe("Wait for the next stop and return location (default true)."),
    timeoutMs: z.number().int().optional(),
  };

  server.tool(
    "step_over",
    "Step over (DAP 'next') the current line.",
    stepArgs,
    tool((a: any) => bridge.step("next", a)),
  );
  server.tool(
    "step_in",
    "Step into the call on the current line.",
    stepArgs,
    tool((a: any) => bridge.step("stepIn", a)),
  );
  server.tool(
    "step_out",
    "Step out of the current function.",
    stepArgs,
    tool((a: any) => bridge.step("stepOut", a)),
  );

  server.tool(
    "wait_for_stop",
    "Block until execution next stops (breakpoint/step/exception) or a timeout elapses.",
    { timeoutMs: z.number().int().optional() },
    tool((a: any) => bridge.waitForStop(a)),
  );

  server.tool(
    "get_threads",
    "List the threads of a debug session.",
    { sessionId: z.string().optional() },
    tool((a: any) => bridge.getThreads(a)),
  );

  server.tool(
    "get_call_stack",
    "Get the call stack (stack frames) of the paused thread. Frame ids feed inspect_variables/evaluate.",
    {
      sessionId: z.string().optional(),
      threadId: z.number().int().optional(),
      startFrame: z.number().int().optional(),
      levels: z.number().int().optional(),
    },
    tool((a: any) => bridge.getCallStack(a)),
  );

  server.tool(
    "get_scopes",
    "Get the variable scopes (Local/Closure/Global) for a stack frame.",
    {
      sessionId: z.string().optional(),
      frameId: z.number().int().optional().describe("Defaults to the top frame of the paused thread."),
      threadId: z.number().int().optional(),
    },
    tool((a: any) => bridge.getScopes(a)),
  );

  server.tool(
    "inspect_variables",
    "Inspect live variables. Pass a variablesReference to expand a specific object, or a frameId (or nothing → top frame) to dump that frame's scopes.",
    {
      sessionId: z.string().optional(),
      variablesReference: z.number().int().optional(),
      frameId: z.number().int().optional(),
      threadId: z.number().int().optional(),
      maxDepth: z.number().int().optional().describe("Recursion depth for nested objects (default 1, max 4)."),
      maxChildren: z.number().int().optional().describe("Max children per object (default 100, max 500)."),
    },
    tool((a: any) => bridge.inspectVariables(a)),
  );

  server.tool(
    "evaluate",
    "Evaluate an expression, in the paused frame's context when available (great for inspecting/mutating live state).",
    {
      sessionId: z.string().optional(),
      expression: z.string(),
      frameId: z.number().int().optional(),
      threadId: z.number().int().optional(),
      context: z.enum(["repl", "watch", "hover", "clipboard"]).optional(),
    },
    tool((a: any) => bridge.evaluate(a)),
  );

  server.tool(
    "get_output",
    "Get captured debug-console/stdout/stderr output for a session.",
    {
      sessionId: z.string().optional(),
      category: z.string().optional().describe("Filter: 'stdout' | 'stderr' | 'console'."),
      maxLines: z.number().int().optional(),
    },
    tool((a: any) => bridge.getOutput(a)),
  );

  server.tool(
    "run_and_capture",
    "Start a config (noDebug by default), wait for it to finish, and return its captured output + exit code.",
    {
      configName: z.string().optional(),
      config: z.record(z.any()).optional(),
      folder: z.string().optional(),
      noDebug: z.boolean().optional().describe("Default true. Set false to keep breakpoints active."),
      timeoutMs: z.number().int().optional().describe("Default 60000."),
    },
    tool((a: any) => bridge.runAndCapture(a)),
  );

  return server;
}

/**
 * Runs the MCP server over Streamable HTTP on 127.0.0.1:<port>, in stateless
 * mode (a fresh McpServer + transport per POST). Endpoint: POST /mcp.
 */
export class McpHttpServer {
  private httpServer: http.Server | undefined;

  constructor(
    private readonly bridge: DebugBridge,
    private readonly log: (msg: string) => void,
  ) {}

  get running(): boolean {
    return !!this.httpServer;
  }

  async start(port: number): Promise<void> {
    if (this.httpServer) {
      return;
    }
    const app = express();
    app.use(express.json({ limit: "8mb" }));

    app.get("/health", (_req, res) => {
      res.json({ ok: true, name: "vscode-debug-mcp" });
    });

    app.post("/mcp", async (req, res) => {
      const server = buildServer(this.bridge);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err: any) {
        this.log(`MCP request error: ${err?.message ?? err}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    // Stateless transport does not support GET (SSE) or DELETE.
    const methodNotAllowed = (_req: express.Request, res: express.Response) => {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed (stateless server)." },
        id: null,
      });
    };
    app.get("/mcp", methodNotAllowed);
    app.delete("/mcp", methodNotAllowed);

    await new Promise<void>((resolve, reject) => {
      const srv = app.listen(port, "127.0.0.1", () => {
        this.httpServer = srv;
        this.log(`MCP server listening on http://127.0.0.1:${port}/mcp`);
        resolve();
      });
      srv.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    const srv = this.httpServer;
    if (!srv) {
      return;
    }
    this.httpServer = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    this.log("MCP server stopped");
  }
}
