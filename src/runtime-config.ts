import path from "node:path";
import type { RuntimeChecks, RuntimeOptions, VerificationCommand } from "./runtime-types.js";

export function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unknown option ${key}`);
}

export function relativeFile(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim() || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || value.includes(":") || value.includes("\0") || value.replaceAll("\\", "/").split("/").some(p => p === "..")) {
    throw new Error(`${where} must be a relative path within the workspace`);
  }
  return value.replaceAll("\\", "/");
}

export function stringList(value: unknown, where: string, paths = false): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) throw new Error(`${where} must be an array of nonempty strings`);
  return paths ? value.map(v => relativeFile(v, where)) : value;
}

export function optionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`);
  return value;
}

function number(value: unknown, where: string, min = 0, integer = true): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`${where} must be a ${integer ? "whole" : "finite"} number >= ${min}`);
  }
  return value;
}

export function parseRuntimeChecks(value: unknown, where = "runtime_checks"): RuntimeChecks | undefined {
  if (value === undefined) return undefined;
  const r = record(value, where);
  knownKeys(r, ["requiredCommands", "forbiddenCommands", "commandOrder", "requiredFiles", "forbiddenFiles", "fileContents", "allowedChanges", "maxCommands", "maxRepeatedCommands", "maxTokens", "maxDurationMs", "maxCostUsd", "noPermissionDenials"], where);
  let fileContents: RuntimeChecks["fileContents"];
  if (r.fileContents !== undefined) {
    if (!Array.isArray(r.fileContents)) throw new Error(`${where}.fileContents must be an array`);
    fileContents = r.fileContents.map((v, i) => {
      const f = record(v, `${where}.fileContents[${i}]`);
      knownKeys(f, ["path", "contains"], `${where}.fileContents[${i}]`);
      if (typeof f.contains !== "string" || !f.contains.length) throw new Error(`${where}.fileContents[${i}].contains must be a nonempty string`);
      return { path: relativeFile(f.path, `${where}.fileContents[${i}].path`), contains: f.contains };
    });
  }
  return {
    requiredCommands: stringList(r.requiredCommands, `${where}.requiredCommands`),
    forbiddenCommands: stringList(r.forbiddenCommands, `${where}.forbiddenCommands`),
    commandOrder: stringList(r.commandOrder, `${where}.commandOrder`),
    requiredFiles: stringList(r.requiredFiles, `${where}.requiredFiles`, true),
    forbiddenFiles: stringList(r.forbiddenFiles, `${where}.forbiddenFiles`, true),
    allowedChanges: stringList(r.allowedChanges, `${where}.allowedChanges`, true),
    fileContents,
    maxCommands: number(r.maxCommands, `${where}.maxCommands`),
    maxRepeatedCommands: number(r.maxRepeatedCommands, `${where}.maxRepeatedCommands`),
    maxTokens: number(r.maxTokens, `${where}.maxTokens`),
    maxDurationMs: number(r.maxDurationMs, `${where}.maxDurationMs`),
    maxCostUsd: number(r.maxCostUsd, `${where}.maxCostUsd`, 0, false),
    noPermissionDenials: optionalBoolean(r.noPermissionDenials, `${where}.noPermissionDenials`),
  };
}

export function parseVerification(value: unknown, where = "verification"): VerificationCommand[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value.map((v, i) => {
    const w = `${where}[${i}]`, r = record(v, w);
    knownKeys(r, ["name", "command", "args", "timeoutMs", "url"], w);
    if (typeof r.name !== "string" || !r.name.trim() || typeof r.command !== "string" || !r.command.trim()) throw new Error(`${w} requires name and command strings`);
    if (r.url !== undefined) {
      if (typeof r.url !== "string") throw new Error(`${w}.url must be a URL string`);
      const url = new URL(r.url);
      if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error(`${w}.url must use a loopback HTTP(S) address`);
    }
    return { name: r.name, command: r.command, args: stringList(r.args, `${w}.args`), timeoutMs: number(r.timeoutMs, `${w}.timeoutMs`, 1), url: r.url as string | undefined };
  });
}

export function parseRuntimeOptions(value: unknown, where = "runtimeOptions"): Omit<RuntimeOptions, "runtime" | "model"> | undefined {
  if (value === undefined) return undefined;
  const r = record(value, where);
  knownKeys(r, ["executable", "executableArgs", "timeoutMs", "maxOutputBytes", "allowWrites", "allowedTools"], where);
  if (r.executable !== undefined && (typeof r.executable !== "string" || !r.executable.trim())) throw new Error(`${where}.executable must be a nonempty string`);
  return {
    executable: r.executable as string | undefined,
    executableArgs: stringList(r.executableArgs, `${where}.executableArgs`),
    timeoutMs: number(r.timeoutMs, `${where}.timeoutMs`, 1),
    maxOutputBytes: number(r.maxOutputBytes, `${where}.maxOutputBytes`, 1),
    allowWrites: optionalBoolean(r.allowWrites, `${where}.allowWrites`),
    allowedTools: stringList(r.allowedTools, `${where}.allowedTools`),
  };
}
