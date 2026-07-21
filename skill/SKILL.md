---
name: vscode-live-debug
description: Drive a live VS Code debugger over MCP to investigate code at runtime — set breakpoints, launch/attach, step, read the call stack, inspect live variables, and evaluate expressions in the paused frame. Use when static reading is not enough and you need to observe actual runtime state, reproduce a bug under the debugger, or confirm a hypothesis by stepping through execution. Triggers - "debug this", "step through", "why is this variable wrong", "set a breakpoint", "inspect at runtime", "run under the debugger", "what is X at this point".
---

# VS Code Live Debugging (MCP)

You have a live debugger available through the `vscode-debug` MCP server (the "Debug MCP Bridge" VS Code extension). It lets you do real dynamic analysis instead of only reading code: pause execution, walk the stack, and read/evaluate actual values.

Prefer this over guessing from source whenever a question is about *what actually happens at runtime* (real values, which branch is taken, why state is wrong, order of calls).

## Prerequisites (check first)

1. Call `get_status`. If it errors/unreachable, the MCP server isn't connected — tell the user to open VS Code with the "Debug MCP Bridge" extension installed and running (status bar shows `Debug MCP :7345`), and that the MCP server must be registered in this Claude session (`claude mcp add --transport http vscode-debug http://127.0.0.1:7345/mcp`).
2. The **VS Code window must have the target project open as a workspace folder** — breakpoints and launch configs are resolved relative to it.

## Core loop

Static-read the relevant code first (so you know which lines/vars matter), then:

1. **Set breakpoints** at the lines of interest — `set_breakpoint` (use `condition` to catch a specific case, e.g. `id === 'abc'`).
2. **Start** — `start_debug_session` with a `configName` from `list_debug_configurations`, or an inline `config`. Pass `waitForStop` implicitly by following with `wait_for_stop`.
3. **Wait** — `wait_for_stop` blocks until a breakpoint/step/exception hits. It returns the stop `reason` and top-frame `location`.
4. **Observe** — `get_call_stack`, then `inspect_variables` (top frame by default) and `evaluate` for specific expressions.
5. **Advance** — `step_over` / `step_in` / `step_out` (each waits for the next stop and returns the new location), or `continue_execution` to run to the next breakpoint.
6. Repeat until the hypothesis is confirmed, then `stop_debug_session` and clean up breakpoints (`remove_breakpoints { all: true }`).

## Tools

| Tool | Purpose |
|------|---------|
| `get_status` | Is anything paused, and where. Start here. |
| `list_debug_configurations` | launch.json configs per workspace folder. |
| `start_debug_session` | Launch/attach via `configName` or inline `config`; `noDebug` to just run. |
| `stop_debug_session` | Terminate a session. |
| `set_breakpoint` | `file` (absolute), `line` (1-based); optional `condition`, `hitCondition` (`>5`), `logMessage` (logpoint — logs without pausing). |
| `remove_breakpoints` / `list_breakpoints` | Manage breakpoints. |
| `wait_for_stop` | Block until next stop (timeout returns `stopped: null`). |
| `continue_execution` / `pause_execution` | Resume / pause. |
| `step_over` / `step_in` / `step_out` | Step; returns new location. |
| `get_threads` / `get_call_stack` | Threads and stack frames (frame `id` feeds the tools below). |
| `get_scopes` | Local/Closure/Global scopes for a frame. |
| `inspect_variables` | Expand a `variablesReference`, or dump a `frameId`'s scopes (defaults to top frame). Use `maxDepth` (≤4) for nested objects. |
| `evaluate` | Run an expression in the paused frame — inspect *or* mutate live state. |
| `get_output` | Captured stdout/stderr/debug-console for a session. |
| `run_and_capture` | Run a config to completion (noDebug by default) and return output + exit code. |

## Guidance & gotchas

- **Lines and columns are 1-based** in every tool.
- **`file` must be an absolute path.**
- After stepping or waiting, `inspect_variables`/`evaluate`/`get_call_stack` default to the **paused thread's top frame** — you usually don't need to pass ids. To inspect a *caller*, get its `frameId` from `get_call_stack` and pass it.
- **Conditional breakpoints beat stepping** for finding one case in a loop — set `condition` instead of stepping N times.
- `inspect_variables` truncates: default depth 1, 100 children. Bump `maxDepth`/`maxChildren` or expand a specific `variablesReference` rather than dumping everything.
- `evaluate` can **change** state (`context: "repl"`). Great for probing, but note side effects.
- To reproduce a bug from a **test**, use that test's launch config (e.g. a Jest/Mocha "debug current test") or an inline config; set the breakpoint, then `wait_for_stop`.
- Long-running / never-terminating programs: use `wait_for_stop` with a sensible `timeoutMs`; don't rely on `run_and_capture` (it waits for termination).
- Always clean up: stop the session and remove breakpoints when done so you don't leave the user's editor full of stale breakpoints.

## Example: "why is `total` negative here?"

1. Read the function; note the file + the line where `total` is computed.
2. `set_breakpoint { file, line, condition: "total < 0" }`.
3. `start_debug_session { configName: "Debug: current file" }` → `wait_for_stop`.
4. `get_call_stack` → `inspect_variables` (see the inputs feeding `total`).
5. `evaluate { expression: "items.map(i => i.amount)" }` to see the offending values.
6. Confirm root cause, `stop_debug_session`, `remove_breakpoints { all: true }`, report findings with the concrete values observed.
