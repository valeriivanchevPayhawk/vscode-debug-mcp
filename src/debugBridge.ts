import * as vscode from "vscode";

/**
 * Snapshot of the most recent `stopped` DAP event for a session — i.e. where
 * execution is currently paused.
 */
export interface StoppedState {
  sessionId: string;
  sessionName: string;
  threadId: number;
  reason: string;
  description?: string;
  text?: string;
  timestamp: number;
}

interface OutputLine {
  category: string;
  output: string;
}

interface SessionMeta {
  session: vscode.DebugSession;
  output: OutputLine[];
  running: boolean;
  exitCode?: number;
  terminated: boolean;
  terminateWaiters: Array<() => void>;
}

type StopWaiter = {
  resolve: (s: StoppedState) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Central bridge between the MCP tools and VS Code's debug subsystem.
 *
 * It talks to running debug sessions two ways:
 *  - high-level `vscode.debug.*` APIs for breakpoints / starting sessions
 *  - raw DAP via `session.customRequest(...)` for stack frames, scopes,
 *    variables, evaluation and stepping.
 *
 * A `DebugAdapterTracker` (wired up in extension.ts) feeds `handleAdapterMessage`
 * so the bridge always knows whether a session is paused and can capture
 * console output.
 */
export class DebugBridge {
  private sessions = new Map<string, SessionMeta>();
  private lastStopped: StoppedState | undefined;
  private stopWaiters: StopWaiter[] = [];
  private pendingRun:
    | { matcher: (s: vscode.DebugSession) => boolean; resolve: (s: vscode.DebugSession) => void }
    | undefined;

  constructor(private readonly getMaxOutputLines: () => number) {}

  // ---------------------------------------------------------------------------
  // Session lifecycle — called from extension.ts event handlers.
  // ---------------------------------------------------------------------------

  onSessionStart(session: vscode.DebugSession): void {
    this.sessions.set(session.id, {
      session,
      output: [],
      running: true,
      terminated: false,
      terminateWaiters: [],
    });
    if (this.pendingRun && this.pendingRun.matcher(session)) {
      const { resolve } = this.pendingRun;
      this.pendingRun = undefined;
      resolve(session);
    }
  }

  onSessionTerminate(session: vscode.DebugSession): void {
    const meta = this.sessions.get(session.id);
    if (!meta) {
      return;
    }
    meta.terminated = true;
    meta.running = false;
    for (const w of meta.terminateWaiters.splice(0)) {
      w();
    }
    if (this.lastStopped?.sessionId === session.id) {
      this.lastStopped = undefined;
    }
  }

  /**
   * Handle a DAP message emitted by an adapter (via the tracker).
   * We only care about a handful of event types.
   */
  handleAdapterMessage(session: vscode.DebugSession, message: any): void {
    if (!message || message.type !== "event") {
      return;
    }
    const meta = this.sessions.get(session.id);
    switch (message.event) {
      case "stopped": {
        if (meta) {
          meta.running = false;
        }
        const body = message.body ?? {};
        const state: StoppedState = {
          sessionId: session.id,
          sessionName: session.name,
          threadId: body.threadId,
          reason: body.reason,
          description: body.description,
          text: body.text,
          timestamp: Date.now(),
        };
        this.lastStopped = state;
        for (const w of this.stopWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve(state);
        }
        break;
      }
      case "continued": {
        if (meta) {
          meta.running = true;
        }
        if (this.lastStopped?.sessionId === session.id) {
          this.lastStopped = undefined;
        }
        break;
      }
      case "output": {
        if (meta) {
          const body = message.body ?? {};
          if (typeof body.output === "string") {
            meta.output.push({ category: body.category ?? "console", output: body.output });
            const max = this.getMaxOutputLines();
            if (meta.output.length > max) {
              meta.output.splice(0, meta.output.length - max);
            }
          }
        }
        break;
      }
      case "exited": {
        if (meta) {
          meta.exitCode = message.body?.exitCode;
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers.
  // ---------------------------------------------------------------------------

  private get activeSession(): vscode.DebugSession | undefined {
    return vscode.debug.activeDebugSession;
  }

  private resolveSession(sessionId?: string): vscode.DebugSession {
    if (sessionId) {
      const meta = this.sessions.get(sessionId);
      if (!meta) {
        throw new Error(`No debug session with id ${sessionId}`);
      }
      return meta.session;
    }
    const active = this.activeSession;
    if (active) {
      return active;
    }
    // Fall back to the single live session if there is exactly one.
    const live = [...this.sessions.values()].filter((m) => !m.terminated);
    if (live.length === 1) {
      return live[0].session;
    }
    throw new Error(
      "No active debug session. Start one with start_debug_session, or pass sessionId.",
    );
  }

  private resolveThreadId(session: vscode.DebugSession, threadId?: number): number {
    if (threadId != null) {
      return threadId;
    }
    if (this.lastStopped && this.lastStopped.sessionId === session.id) {
      return this.lastStopped.threadId;
    }
    throw new Error("threadId is required (the session is not paused on a known thread).");
  }

  private async resolveTopFrameId(
    session: vscode.DebugSession,
    threadId: number,
  ): Promise<number> {
    const res = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 });
    const frame = res?.stackFrames?.[0];
    if (!frame) {
      throw new Error("No stack frames available (is execution paused?).");
    }
    return frame.id;
  }

  // ---------------------------------------------------------------------------
  // Status.
  // ---------------------------------------------------------------------------

  getStatus() {
    const live = [...this.sessions.values()].filter((m) => !m.terminated);
    return {
      activeSessionId: this.activeSession?.id,
      paused: !!this.lastStopped,
      stoppedAt: this.lastStopped,
      sessions: live.map((m) => ({
        id: m.session.id,
        name: m.session.name,
        type: m.session.type,
        running: m.running,
        active: m.session.id === this.activeSession?.id,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Configurations & starting / stopping.
  // ---------------------------------------------------------------------------

  listConfigurations() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.map((folder) => {
      const launch = vscode.workspace.getConfiguration("launch", folder.uri);
      const configs = launch.get<any[]>("configurations") ?? [];
      return {
        folder: folder.name,
        folderPath: folder.uri.fsPath,
        configurations: configs.map((c) => ({ name: c.name, type: c.type, request: c.request })),
      };
    });
  }

  async startSession(opts: {
    configName?: string;
    config?: vscode.DebugConfiguration;
    folder?: string;
    noDebug?: boolean;
  }): Promise<{ started: boolean; sessionId?: string; sessionName?: string }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let folder: vscode.WorkspaceFolder | undefined;
    if (opts.folder) {
      folder = folders.find((f) => f.name === opts.folder || f.uri.fsPath === opts.folder);
      if (!folder) {
        throw new Error(`Workspace folder not found: ${opts.folder}`);
      }
    } else {
      folder = folders[0];
    }

    const nameOrConfig: string | vscode.DebugConfiguration =
      opts.config ?? opts.configName ?? "";
    if (!nameOrConfig) {
      throw new Error("Provide either configName or an inline config object.");
    }

    // Track the session that is about to appear so we can return its id.
    const wantName = opts.config?.name ?? opts.configName;
    const sessionPromise = new Promise<vscode.DebugSession | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingRun) {
          this.pendingRun = undefined;
        }
        resolve(undefined);
      }, 8000);
      this.pendingRun = {
        matcher: (s) => (wantName ? s.name === wantName : true),
        resolve: (s) => {
          clearTimeout(timer);
          resolve(s);
        },
      };
    });

    const started = await vscode.debug.startDebugging(folder, nameOrConfig, {
      noDebug: opts.noDebug ?? false,
    });
    if (!started) {
      this.pendingRun = undefined;
      return { started: false };
    }
    const session = await sessionPromise;
    return { started: true, sessionId: session?.id, sessionName: session?.name };
  }

  async stopSession(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await vscode.debug.stopDebugging(session);
  }

  // ---------------------------------------------------------------------------
  // Breakpoints.
  // ---------------------------------------------------------------------------

  setBreakpoint(opts: {
    file: string;
    line: number;
    column?: number;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
  }) {
    const uri = vscode.Uri.file(opts.file);
    const position = new vscode.Position(
      Math.max(0, opts.line - 1),
      opts.column ? Math.max(0, opts.column - 1) : 0,
    );
    const bp = new vscode.SourceBreakpoint(
      new vscode.Location(uri, position),
      true,
      opts.condition,
      opts.hitCondition,
      opts.logMessage,
    );
    vscode.debug.addBreakpoints([bp]);
    return this.describeBreakpoint(bp);
  }

  removeBreakpoints(opts: { file?: string; line?: number; all?: boolean }) {
    const all = vscode.debug.breakpoints;
    let toRemove: vscode.Breakpoint[];
    if (opts.all) {
      toRemove = [...all];
    } else if (opts.file) {
      const target = vscode.Uri.file(opts.file).fsPath;
      toRemove = all.filter((bp) => {
        if (!(bp instanceof vscode.SourceBreakpoint)) {
          return false;
        }
        if (bp.location.uri.fsPath !== target) {
          return false;
        }
        if (opts.line != null) {
          return bp.location.range.start.line === opts.line - 1;
        }
        return true;
      });
    } else {
      throw new Error("Provide `all: true`, or `file` (optionally with `line`).");
    }
    vscode.debug.removeBreakpoints(toRemove);
    return { removed: toRemove.length };
  }

  listBreakpoints() {
    return vscode.debug.breakpoints
      .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
      .map((bp) => this.describeBreakpoint(bp));
  }

  private describeBreakpoint(bp: vscode.SourceBreakpoint) {
    return {
      id: bp.id,
      file: bp.location.uri.fsPath,
      line: bp.location.range.start.line + 1,
      column: bp.location.range.start.character + 1,
      enabled: bp.enabled,
      condition: bp.condition,
      hitCondition: bp.hitCondition,
      logMessage: bp.logMessage,
    };
  }

  // ---------------------------------------------------------------------------
  // Execution control.
  // ---------------------------------------------------------------------------

  async continue(opts: { sessionId?: string; threadId?: number }) {
    const session = this.resolveSession(opts.sessionId);
    const threadId = this.resolveThreadId(session, opts.threadId);
    if (this.lastStopped?.sessionId === session.id) {
      this.lastStopped = undefined;
    }
    await session.customRequest("continue", { threadId });
    return { ok: true };
  }

  async pause(opts: { sessionId?: string; threadId?: number }) {
    const session = this.resolveSession(opts.sessionId);
    const threadId = opts.threadId ?? (await this.firstThreadId(session));
    await session.customRequest("pause", { threadId });
    return { ok: true };
  }

  async step(
    kind: "next" | "stepIn" | "stepOut",
    opts: { sessionId?: string; threadId?: number; waitForStop?: boolean; timeoutMs?: number },
  ) {
    const session = this.resolveSession(opts.sessionId);
    const threadId = this.resolveThreadId(session, opts.threadId);
    const waiter =
      opts.waitForStop === false ? undefined : this.makeStopWaiter(opts.timeoutMs ?? 10000);
    if (this.lastStopped?.sessionId === session.id) {
      this.lastStopped = undefined;
    }
    await session.customRequest(kind, { threadId });
    if (!waiter) {
      return { ok: true, stopped: null };
    }
    const stopped = await waiter;
    if (!stopped) {
      return { ok: true, stopped: null, note: "Timed out waiting for stop." };
    }
    const location = await this.topFrameLocation(session, stopped.threadId);
    return { ok: true, stopped: { ...stopped, location } };
  }

  private async firstThreadId(session: vscode.DebugSession): Promise<number> {
    const res = await session.customRequest("threads", {});
    const t = res?.threads?.[0];
    if (!t) {
      throw new Error("No threads available.");
    }
    return t.id;
  }

  // ---------------------------------------------------------------------------
  // Waiting for stops.
  // ---------------------------------------------------------------------------

  private makeStopWaiter(timeoutMs: number): Promise<StoppedState | undefined> {
    return new Promise<StoppedState | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.stopWaiters = this.stopWaiters.filter((w) => w.timer !== timer);
        resolve(undefined);
      }, timeoutMs);
      this.stopWaiters.push({ resolve, timer });
    });
  }

  async waitForStop(opts: { timeoutMs?: number }) {
    // If we're already paused, return immediately.
    if (this.lastStopped) {
      const session = this.sessions.get(this.lastStopped.sessionId)?.session;
      const location = session
        ? await this.topFrameLocation(session, this.lastStopped.threadId)
        : undefined;
      return { stopped: { ...this.lastStopped, location } };
    }
    const stopped = await this.makeStopWaiter(opts.timeoutMs ?? 15000);
    if (!stopped) {
      return { stopped: null, note: "Timed out waiting for stop." };
    }
    const session = this.sessions.get(stopped.sessionId)?.session;
    const location = session
      ? await this.topFrameLocation(session, stopped.threadId)
      : undefined;
    return { stopped: { ...stopped, location } };
  }

  private async topFrameLocation(session: vscode.DebugSession, threadId: number) {
    try {
      const res = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 });
      const f = res?.stackFrames?.[0];
      if (!f) {
        return undefined;
      }
      return { frameId: f.id, name: f.name, file: f.source?.path, line: f.line, column: f.column };
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Inspection.
  // ---------------------------------------------------------------------------

  async getThreads(opts: { sessionId?: string }) {
    const session = this.resolveSession(opts.sessionId);
    const res = await session.customRequest("threads", {});
    return { threads: res?.threads ?? [] };
  }

  async getCallStack(opts: {
    sessionId?: string;
    threadId?: number;
    startFrame?: number;
    levels?: number;
  }) {
    const session = this.resolveSession(opts.sessionId);
    const threadId = this.resolveThreadId(session, opts.threadId);
    const res = await session.customRequest("stackTrace", {
      threadId,
      startFrame: opts.startFrame ?? 0,
      levels: opts.levels ?? 20,
    });
    const frames = (res?.stackFrames ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      file: f.source?.path,
      line: f.line,
      column: f.column,
    }));
    return { threadId, totalFrames: res?.totalFrames, frames };
  }

  async getScopes(opts: { sessionId?: string; frameId?: number; threadId?: number }) {
    const session = this.resolveSession(opts.sessionId);
    let frameId = opts.frameId;
    if (frameId == null) {
      const threadId = this.resolveThreadId(session, opts.threadId);
      frameId = await this.resolveTopFrameId(session, threadId);
    }
    const res = await session.customRequest("scopes", { frameId });
    const scopes = (res?.scopes ?? []).map((s: any) => ({
      name: s.name,
      variablesReference: s.variablesReference,
      expensive: s.expensive,
    }));
    return { frameId, scopes };
  }

  /**
   * Expand variables. Either give an explicit `variablesReference`, or a
   * `frameId` (or nothing → top frame) to expand that frame's scopes.
   */
  async inspectVariables(opts: {
    sessionId?: string;
    variablesReference?: number;
    frameId?: number;
    threadId?: number;
    maxDepth?: number;
    maxChildren?: number;
  }) {
    const session = this.resolveSession(opts.sessionId);
    const maxDepth = Math.min(opts.maxDepth ?? 1, 4);
    const maxChildren = Math.min(opts.maxChildren ?? 100, 500);

    if (opts.variablesReference != null) {
      const vars = await this.expandRef(session, opts.variablesReference, maxDepth, maxChildren);
      return { variables: vars };
    }

    let frameId = opts.frameId;
    if (frameId == null) {
      const threadId = this.resolveThreadId(session, opts.threadId);
      frameId = await this.resolveTopFrameId(session, threadId);
    }
    const scopesRes = await session.customRequest("scopes", { frameId });
    const scopes = scopesRes?.scopes ?? [];
    const out: any[] = [];
    for (const scope of scopes) {
      if (scope.expensive) {
        out.push({ scope: scope.name, skipped: "expensive scope; expand explicitly if needed" });
        continue;
      }
      const vars = await this.expandRef(session, scope.variablesReference, maxDepth, maxChildren);
      out.push({ scope: scope.name, variables: vars });
    }
    return { frameId, scopes: out };
  }

  private async expandRef(
    session: vscode.DebugSession,
    variablesReference: number,
    depth: number,
    maxChildren: number,
  ): Promise<any[]> {
    if (variablesReference === 0 || depth < 0) {
      return [];
    }
    const res = await session.customRequest("variables", { variablesReference });
    const vars = (res?.variables ?? []).slice(0, maxChildren);
    const result: any[] = [];
    for (const v of vars) {
      const entry: any = {
        name: v.name,
        value: v.value,
        type: v.type,
        variablesReference: v.variablesReference,
      };
      if (v.variablesReference > 0 && depth > 0) {
        entry.children = await this.expandRef(
          session,
          v.variablesReference,
          depth - 1,
          maxChildren,
        );
      }
      result.push(entry);
    }
    return result;
  }

  async evaluate(opts: {
    sessionId?: string;
    expression: string;
    frameId?: number;
    threadId?: number;
    context?: string;
  }) {
    const session = this.resolveSession(opts.sessionId);
    let frameId = opts.frameId;
    if (frameId == null && (this.lastStopped?.sessionId === session.id || opts.threadId != null)) {
      try {
        const threadId = this.resolveThreadId(session, opts.threadId);
        frameId = await this.resolveTopFrameId(session, threadId);
      } catch {
        // fall through — evaluate in global context
      }
    }
    const res = await session.customRequest("evaluate", {
      expression: opts.expression,
      frameId,
      context: opts.context ?? "repl",
    });
    return {
      result: res?.result,
      type: res?.type,
      variablesReference: res?.variablesReference,
    };
  }

  // ---------------------------------------------------------------------------
  // Output capture / run-and-capture.
  // ---------------------------------------------------------------------------

  getOutput(opts: { sessionId?: string; category?: string; maxLines?: number }) {
    const session = this.resolveSession(opts.sessionId);
    const meta = this.sessions.get(session.id);
    if (!meta) {
      return { output: "" };
    }
    let lines = meta.output;
    if (opts.category) {
      lines = lines.filter((l) => l.category === opts.category);
    }
    if (opts.maxLines) {
      lines = lines.slice(-opts.maxLines);
    }
    return {
      sessionId: session.id,
      running: meta.running,
      terminated: meta.terminated,
      exitCode: meta.exitCode,
      output: lines.map((l) => l.output).join(""),
    };
  }

  async runAndCapture(opts: {
    configName?: string;
    config?: vscode.DebugConfiguration;
    folder?: string;
    noDebug?: boolean;
    timeoutMs?: number;
  }) {
    const timeoutMs = opts.timeoutMs ?? 60000;
    const start = await this.startSession({
      configName: opts.configName,
      config: opts.config,
      folder: opts.folder,
      noDebug: opts.noDebug ?? true,
    });
    if (!start.started || !start.sessionId) {
      return { started: start.started, note: "Could not correlate a session id.", output: "" };
    }
    const meta = this.sessions.get(start.sessionId);
    if (!meta) {
      return { started: true, sessionId: start.sessionId, output: "" };
    }

    const terminated = await new Promise<boolean>((resolve) => {
      if (meta.terminated) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        meta.terminateWaiters = meta.terminateWaiters.filter((w) => w !== onDone);
        resolve(false);
      }, timeoutMs);
      const onDone = () => {
        clearTimeout(timer);
        resolve(true);
      };
      meta.terminateWaiters.push(onDone);
    });

    return {
      started: true,
      sessionId: start.sessionId,
      sessionName: start.sessionName,
      terminated,
      timedOut: !terminated,
      exitCode: meta.exitCode,
      output: meta.output.map((l) => l.output).join(""),
    };
  }
}
