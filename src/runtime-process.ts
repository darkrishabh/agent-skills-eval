import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** A successful HTTP response finishes a server smoke check and stops its process tree. */
  readyUrl?: string;
}
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}

/** Resolve Windows npm shims to their native executable or Node entry, never a shell. */
export function resolveExecutable(command: string): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args: [] };
  const directories = path.isAbsolute(command) || /[\\/]/.test(command)
    ? [path.dirname(path.resolve(command))]
    : (process.env.PATH ?? "").split(path.delimiter);
  const name = path.basename(command).replace(/\.(?:cmd|bat|ps1|exe)$/i, "");
  for (const directory of directories) {
    const native = path.join(directory, `${name}.exe`);
    if (existsSync(native)) return { command: native, args: [] };
    const shim = path.join(directory, `${name}.cmd`);
    if (!existsSync(shim)) continue;
    const contents = readFileSync(shim, "utf8");
    // npm's standard shim contains a quoted path rooted at %dp0% / %~dp0.
    const targets = [...contents.matchAll(/"(%(?:~dp0|dp0%)[^"\r\n]*\.(?:[cm]?js|exe))"/gi)];
    for (const match of targets.reverse()) {
      const entry = path.resolve(directory, match[1].replace(/^%(?:~dp0|dp0%)[\\/]*/i, ""));
      if (!existsSync(entry)) continue;
      if (/\.exe$/i.test(entry)) return { command: entry, args: [] };
      const siblingNode = path.join(directory, "node.exe");
      return { command: existsSync(siblingNode) ? siblingNode : process.execPath, args: [entry] };
    }
    throw new Error(`Cannot safely resolve CLI shim ${shim}; configure executable and executableArgs with a native executable or Node entry point.`);
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(command)) throw new Error(`Shell scripts are not executed directly: ${command}`);
  return { command, args: [] };
}

export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  let executable: ReturnType<typeof resolveExecutable>;
  try { executable = resolveExecutable(options.command); }
  catch (error) { return { stdout: "", stderr: "", exitCode: -1, durationMs: Date.now() - started, error: String(error) }; }
  return new Promise(resolve => {
    const child = spawn(executable.command, [...executable.args, ...(options.args ?? [])], {
      cwd: options.cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    let bytes = 0;
    let error: string | undefined;
    let finished = false;
    let stopping = false;
    let ready = false;
    let pollBusy = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(poll);
      if (fallback) clearTimeout(fallback);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: ready && !error ? 0 : code ?? -1, durationMs: Date.now() - started, error });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill("SIGKILL"));
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
      fallback = setTimeout(() => { child.kill("SIGKILL"); finish(-1); }, 3000);
      fallback.unref();
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, limit - bytes);
      target.push(chunk.subarray(0, available));
      bytes += Math.min(available, chunk.length);
      if (chunk.length > available && !error) { error = `Process output limit exceeded (${limit} bytes)`; stop(); }
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.stdin.on("error", () => { /* EPIPE is reported through process exit / stderr. */ });
    child.on("error", cause => { error = cause.message; finish(-1); });
    child.on("close", code => {
      if (options.readyUrl && !ready && !error) error = "Server exited before its smoke URL became ready";
      finish(code);
    });
    const timeout = setTimeout(() => { error = `Process timed out after ${options.timeoutMs ?? 300000} ms`; stop(); }, options.timeoutMs ?? 300000);
    const poll = options.readyUrl ? setInterval(() => {
      if (pollBusy || finished || stopping) return;
      pollBusy = true;
      fetch(options.readyUrl!, { signal: AbortSignal.timeout(1000) }).then(response => {
        void response.body?.cancel();
        if (response.ok && !finished && !stopping) { ready = true; stop(); }
      }).catch(() => {}).finally(() => { pollBusy = false; });
    }, 150) : undefined;
    child.stdin.end(options.stdin ?? "");
  });
}
