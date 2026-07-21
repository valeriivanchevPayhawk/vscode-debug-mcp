import * as vscode from "vscode";
import { DebugBridge } from "./debugBridge";
import { McpHttpServer } from "./mcpServer";

let output: vscode.OutputChannel;
let bridge: DebugBridge;
let server: McpHttpServer;
let statusItem: vscode.StatusBarItem;

function getPort(): number {
  return vscode.workspace.getConfiguration("debugMcp").get<number>("port", 7345);
}

function claudeAddCommand(port: number): string {
  return `claude mcp add --transport http vscode-debug http://127.0.0.1:${port}/mcp`;
}

function updateStatus() {
  const port = getPort();
  if (server.running) {
    statusItem.text = `$(debug) Debug MCP :${port}`;
    statusItem.tooltip = `MCP debug bridge running on http://127.0.0.1:${port}/mcp\nClick for status`;
  } else {
    statusItem.text = `$(debug-disconnect) Debug MCP off`;
    statusItem.tooltip = "MCP debug bridge stopped. Click to start.";
  }
  statusItem.show();
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Debug MCP");
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  bridge = new DebugBridge(() =>
    vscode.workspace.getConfiguration("debugMcp").get<number>("outputBufferLines", 2000),
  );
  server = new McpHttpServer(bridge, log);

  // Feed DAP messages into the bridge (stopped/output/exited events).
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: (m) => bridge.handleAdapterMessage(session, m),
          onError: (e) => log(`Adapter error (${session.name}): ${e?.message ?? e}`),
        };
      },
    }),
    vscode.debug.onDidStartDebugSession((s) => {
      bridge.onSessionStart(s);
      log(`Debug session started: ${s.name} (${s.id})`);
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      bridge.onSessionTerminate(s);
      log(`Debug session terminated: ${s.name} (${s.id})`);
    }),
  );

  // Status bar.
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "debugMcp.showStatus";
  context.subscriptions.push(statusItem);

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("debugMcp.start", async () => {
      try {
        await server.start(getPort());
        updateStatus();
        vscode.window.showInformationMessage(`Debug MCP started on port ${getPort()}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Debug MCP failed to start: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand("debugMcp.stop", async () => {
      await server.stop();
      updateStatus();
    }),
    vscode.commands.registerCommand("debugMcp.copyClaudeCommand", async () => {
      const cmd = claudeAddCommand(getPort());
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage(`Copied: ${cmd}`);
    }),
    vscode.commands.registerCommand("debugMcp.showStatus", async () => {
      if (!server.running) {
        const pick = await vscode.window.showInformationMessage(
          "Debug MCP is stopped.",
          "Start",
        );
        if (pick === "Start") {
          await vscode.commands.executeCommand("debugMcp.start");
        }
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        `Debug MCP running on http://127.0.0.1:${getPort()}/mcp`,
        "Copy claude command",
        "Show log",
        "Stop",
      );
      if (pick === "Copy claude command") {
        await vscode.commands.executeCommand("debugMcp.copyClaudeCommand");
      } else if (pick === "Show log") {
        output.show();
      } else if (pick === "Stop") {
        await vscode.commands.executeCommand("debugMcp.stop");
      }
    }),
  );

  // Restart the server if the port changes while running.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("debugMcp.port") && server.running) {
        await server.stop();
        await server.start(getPort());
        updateStatus();
      }
    }),
  );

  const autoStart = vscode.workspace.getConfiguration("debugMcp").get<boolean>("autoStart", true);
  if (autoStart) {
    try {
      await server.start(getPort());
    } catch (e: any) {
      log(`Auto-start failed: ${e?.message ?? e}`);
    }
  }
  updateStatus();
}

export async function deactivate() {
  await server?.stop();
}
