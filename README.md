# Debug MCP Bridge

A VS Code extension that exposes the editor's built-in debugger (Debug Adapter
Protocol) as an **MCP server**, so Claude can do real runtime investigation:
set breakpoints, launch/attach, step, walk the call stack, inspect live
variables, and evaluate expressions in the paused frame.

```
Claude Code  ──MCP over HTTP──▶  VS Code extension  ──vscode.debug / DAP──▶  your program
```

Works with any VS Code debug adapter; targeted first at **Node/TypeScript**
(the built-in `js-debug` adapter — no extra debugger needed).

## How it works

- On activation the extension starts a **stateless Streamable-HTTP MCP server**
  bound to `127.0.0.1:<port>` (default `7345`), endpoint `POST /mcp`.
- A `DebugAdapterTracker` observes DAP traffic so the bridge always knows when
  execution is paused (`stopped` events) and captures console output.
- MCP tools call `vscode.debug.*` for breakpoints/launch and raw DAP
  (`session.customRequest`) for stacks, scopes, variables, evaluation, stepping.

## Install (development)

```bash
npm install
npm run build
```

Then in VS Code: open this folder and press **F5** ("Run Extension") to launch an
Extension Development Host with the extension loaded. Open your target project in
that window.

### Package as a .vsix (to install into your normal VS Code)

```bash
npm run package        # produces vscode-debug-mcp-0.1.0.vsix
code --install-extension vscode-debug-mcp-0.1.0.vsix
```

## Wire it into Claude Code

With the extension running (status bar shows `Debug MCP :7345`):

```bash
claude mcp add --transport http vscode-debug http://127.0.0.1:7345/mcp
```

(The command **Debug MCP: Copy 'claude mcp add' command** copies this for you.)

Verify:

```bash
curl -s http://127.0.0.1:7345/health      # {"ok":true,...}
```

## Install the skill

Copy `skill/SKILL.md` into a skill folder Claude can see, e.g.:

```bash
mkdir -p ~/.claude/skills/vscode-live-debug
cp skill/SKILL.md ~/.claude/skills/vscode-live-debug/SKILL.md
```

Claude will then load `vscode-live-debug` when a task calls for runtime debugging.

## Tools

`get_status`, `list_debug_configurations`, `start_debug_session`,
`stop_debug_session`, `set_breakpoint`, `remove_breakpoints`,
`list_breakpoints`, `continue_execution`, `pause_execution`, `step_over`,
`step_in`, `step_out`, `wait_for_stop`, `get_threads`, `get_call_stack`,
`get_scopes`, `inspect_variables`, `evaluate`, `get_output`, `run_and_capture`.

See `skill/SKILL.md` for the debugging workflow and tool details.

## Validate end-to-end

`sample/orders.js` is a deliberately buggy program with a matching
"Debug: sample orders" launch config. Follow `sample/WALKTHROUGH.md` for a fixed
sequence of tool calls that proves breakpoints, stepping, stack, variable
inspection, and `run_and_capture` all work over MCP.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `debugMcp.port` | `7345` | Local port (127.0.0.1). |
| `debugMcp.autoStart` | `true` | Start server on VS Code launch. |
| `debugMcp.outputBufferLines` | `2000` | Captured output lines retained per session. |

## Security

The server binds to loopback only and is unauthenticated — any local process can
drive your debugger while it runs. Stop it (**Debug MCP: Stop Server**) when not
in use. Do not expose the port beyond `127.0.0.1`.

## Commands

- **Debug MCP: Start Server** / **Stop Server**
- **Debug MCP: Copy 'claude mcp add' command**
- **Debug MCP: Show Status**
