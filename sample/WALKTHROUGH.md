# End-to-end validation walkthrough

A fixed script to confirm the whole chain works: Claude → MCP → VS Code
debugger → this sample program.

## Setup

1. In VS Code, open the `vscode-debug-mcp` folder and press **F5**
   ("Run Extension"). An Extension Development Host window opens with the
   extension active — its status bar shows `Debug MCP :7345`.
2. In that dev-host window, make sure this same folder is the open workspace
   (so `sample/orders.js` and the "Debug: sample orders" launch config resolve).
3. Register the server with Claude Code:
   ```bash
   claude mcp add --transport http vscode-debug http://127.0.0.1:7345/mcp
   ```

## Script (expected tool calls & results)

1. `get_status` → `paused: false`, no sessions.
2. `list_debug_configurations` → includes `"Debug: sample orders"`.
3. `set_breakpoint { file: "<abs>/sample/orders.js", line: 22 }`
   (the `total += ...` line).
4. `start_debug_session { configName: "Debug: sample orders" }`.
5. `wait_for_stop {}` → stops at `orders.js:22`, reason `breakpoint`.
6. `inspect_variables {}` → top-frame Local scope shows `i`, `item`, `total`.
7. `evaluate { expression: "i" }` and `evaluate { expression: "items.length" }`
   → step with `step_over` repeatedly and watch `i` reach `items.length` (3)
   while the loop condition `i <= items.length` is still true → `item` becomes
   `undefined`. That is **BUG #1**.
8. `set_breakpoint { file: "<abs>/sample/orders.js", line: 38 }` (inside
   `applyDiscount`), `continue_execution` — but note the program throws before
   reaching it because of BUG #1. This demonstrates catching a runtime crash.
9. `stop_debug_session {}` then `remove_breakpoints { all: true }`.

## What "success" looks like

You observed the loop index `i` exceed the valid range **at runtime** (not by
reading the code), pinpointing line 22 / the `<=` condition — and you can read
`total`'s live value at each iteration. That confirms breakpoints, stepping,
stack, and variable inspection all work over MCP.

To also exercise `run_and_capture`, fix BUG #1 (`<=` → `<`) and call
`run_and_capture { configName: "Debug: sample orders", noDebug: true }` — it
returns the printed subtotal/total and exit code.
