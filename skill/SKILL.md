---
name: vscode-live-debug
description: Drive a live VS Code debugger over MCP to investigate code at runtime — set breakpoints, launch/attach, step, read the call stack, inspect live variables, and evaluate expressions in the paused frame. Use when static reading is not enough and you need to observe actual runtime state, reproduce a bug under the debugger, or confirm a hypothesis by stepping through execution. Triggers - "debug this", "step through", "why is this variable wrong", "set a breakpoint", "inspect at runtime", "run under the debugger", "what is X at this point".
---

# VS Code Live Debugging (MCP)

You have a live debugger available through the `vscode-debug` MCP server (the "Debug MCP Bridge" VS Code extension). It lets you do real dynamic analysis instead of only reading code: pause execution, walk the stack, and read/evaluate actual values.

Prefer this over guessing from source whenever a question is about *what actually happens at runtime* (real values, which branch is taken, why state is wrong, order of calls).

## Prerequisites (check first)

1. Call `get_status`. If it errors/unreachable, the MCP server isn't connected — tell the user to open VS Code with the "Debug MCP Bridge" extension installed and running (status bar shows `Debug MCP :7345`), and that the MCP server must be registered in this Claude session.
   - Register at **user scope** so it loads regardless of which directory the session runs from: `claude mcp add --scope user --transport http vscode-debug http://127.0.0.1:7345/mcp`. A project-scoped add only loads when the session's cwd is inside that project — a common reason the tools silently don't appear.
   - **MCP tools load only at session start.** After `claude mcp add`, `claude mcp list` will show `✔ Connected`, but the `mcp__vscode-debug__*` tools won't be callable until the user **restarts Claude Code**. Registering mid-session is not enough.
2. The **VS Code window must have the target project open as a workspace folder** — breakpoints and launch configs are resolved relative to it. If Explorer shows "NO FOLDER OPENED", `start_debug_session` returns `{started:false}` and breakpoints never bind; have the user File → Open Folder the target repo. Confirm with `list_debug_configurations` (it returns the folder path).

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

## Debugging a browser / React app in Chrome (incl. the Payhawk portal)

Node configs won't reach browser code. To debug a web app you attach js-debug to a Chrome instance over the Chrome DevTools Protocol (CDP). The hard parts are (a) getting a **logged-in** Chrome that also exposes CDP, and (b) binding breakpoints inside bundler-served files.

**Chrome refuses CDP on the default profile.** Launching Chrome with `--remote-debugging-port` on the default user-data-dir logs: `DevTools remote debugging requires a non-default data directory.` A fresh temp profile has the port but **isn't logged in**, so it can't reach authed pages. The reliable fix is to **debug a copy of the real profile**:

```bash
# 1. Fully quit Chrome first (a page 'beforeunload' can block a graceful quit → force it)
osascript -e 'tell application "Google Chrome" to quit'; sleep 2; killall "Google Chrome" 2>/dev/null

# 2. Copy the logged-in profile to a temp dir, minus the big caches (cookies + localStorage carry the session)
SRC="$HOME/Library/Application Support/Google/Chrome"; DST="/tmp/chrome-debug-profile"
rm -rf "$DST"; mkdir -p "$DST"; cp "$SRC/Local State" "$DST/"
rsync -a --exclude Cache --exclude 'Code Cache' --exclude GPUCache --exclude '*Cache*' \
  --exclude 'Service Worker/CacheStorage' "$SRC/Default" "$DST/"

# 3. Launch that copy WITH the debug port, pointed at the repro URL
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$DST" --remote-debugging-port=9222 --no-first-run --restore-last-session=false \
  "http://localhost:3000/<repro-path>" &
sleep 5; curl -s http://127.0.0.1:9222/json | grep -oE '"(title|url)":"[^"]*"' | head   # verify it's the logged-in page, not a login redirect
```

macOS cookie encryption is keyed per-user (Keychain), so cookies still decrypt in the copied profile. The copy never touches the real profile.

**Attach the debugger** with an inline config (no launch.json needed):

```json
{ "type": "chrome", "request": "attach", "port": 9222,
  "webRoot": "/absolute/path/to/repo", "urlFilter": "http://localhost:3000/*" }
```

**Breakpoints in bundler-served / Vite pre-bundled deps.** Set the breakpoint on the **on-disk** file that Vite serves, e.g. `…/node_modules/.vite/deps/react-virtuoso.js`. The served URL carries a `?v=<hash>` query — js-debug strips it when mapping via `webRoot`, so a disk-path breakpoint binds to `http://localhost:3000/node_modules/.vite/deps/react-virtuoso.js?v=…`. Read the on-disk file to pick an executable line (a `function` declaration line often won't pause — use a statement inside).

**Driving the reproduction without the automation extension.** A CLI-launched Chrome usually isn't bound to the claude-in-chrome extension, so `tabs_context_mcp` reports "not connected." You don't need it — `evaluate { context: "repl" }` runs JS in the **page's global context even when not paused**, so you can click through the flow (`document.querySelector(...).click()`, dispatch `MouseEvent`/`FocusEvent` with `{bubbles:true}`). Key trick: **schedule the state-changing action with `setTimeout(fn, 500)` and return immediately**, THEN call `wait_for_stop`. If you trigger the render synchronously inside `evaluate`, the breakpoint pauses *inside your evaluate call* and it hangs. Some React widgets open on `focusin`/`mousedown`, not a bare `.click()` — dispatch the full sequence (`mousedown → focus → focusin → mouseup → click`).

**"Run until it breaks" (catch a runaway render loop).** Confirm the loop by pausing on the suspect line and `continue_execution` → `wait_for_stop` a few times (it re-hits within tens of ms). To reach the actual crash, `remove_breakpoints { all: true }` then `continue_execution`, let it run free, and `evaluate` the page (`/Something went wrong|Maximum update depth/.test(document.body.innerText)`) to read the thrown React error + component stack. Reading `props`/refs across two consecutive hits proves whether inputs are stable (store a ref on `window` in hit 1, compare in hit 2).

**Cleanup.** `stop_debug_session` currently returns a response-schema error from the bridge even though it acts — verify with `get_status`, and just `killall "Google Chrome"` (ends the attached session) and `rm -rf /tmp/chrome-debug-profile`. Then `remove_breakpoints { all: true }`. The user's real Chrome reopens normally — its profile was never modified.

**Payhawk portal specifics:** dev server runs at `http://localhost:3000` (Vite, `strictPort`), workspace folder `…/Development/portal`, deps served from `…/portal/node_modules/.vite/deps/`. Portal auth lives in the profile (cookies + localStorage), so the profile-copy approach above is required to reach any authed route.

## Example: "why is `total` negative here?"

1. Read the function; note the file + the line where `total` is computed.
2. `set_breakpoint { file, line, condition: "total < 0" }`.
3. `start_debug_session { configName: "Debug: current file" }` → `wait_for_stop`.
4. `get_call_stack` → `inspect_variables` (see the inputs feeding `total`).
5. `evaluate { expression: "items.map(i => i.amount)" }` to see the offending values.
6. Confirm root cause, `stop_debug_session`, `remove_breakpoints { all: true }`, report findings with the concrete values observed.
