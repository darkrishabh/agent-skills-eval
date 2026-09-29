import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AttachedFile } from "./types.js";

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024;

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export const pathToPosix = toPosixPath;
export const normalizePosix = toPosixPath;

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function isInsideDir(root: string, candidate: string): boolean {
  const rootDir = path.resolve(root);
  const absolutePath = path.resolve(candidate);
  return absolutePath === rootDir || absolutePath.startsWith(rootDir + path.sep);
}

export function assertInside(root: string, candidate: string, label = "path"): void {
  if (!isInsideDir(root, candidate)) {
    throw new Error(`${label} escapes ${root}`);
  }
}

export function safeResolve(root: string, relativePath: string): { absolutePath: string; relativePath: string } | null {
  const rootDir = path.resolve(root);
  const absolutePath = path.resolve(rootDir, relativePath);
  if (absolutePath !== rootDir && !absolutePath.startsWith(rootDir + path.sep)) {
    return null;
  }
  return { absolutePath, relativePath: toPosixPath(path.relative(rootDir, absolutePath)) };
}

export function resolveInside(root: string, relativePath: string): string {
  const resolved = safeResolve(root, relativePath);
  if (!resolved) throw new Error(`Path escapes skill directory: ${relativePath}`);
  return resolved.relativePath;
}

export function readAttachedFile(root: string, relativePath: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES): AttachedFile {
  const resolved = safeResolve(root, relativePath);
  const normalized = resolved?.relativePath ?? toPosixPath(relativePath);
  if (!resolved || !existsSync(resolved.absolutePath)) {
    return { path: normalized, content: "", kind: "missing" };
  }

  const stat = statSync(resolved.absolutePath);
  if (!stat.isFile()) {
    return { path: normalized, content: "", kind: "missing" };
  }

  const buffer = readFileSync(resolved.absolutePath);
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (probe.includes(0)) {
    return { path: normalized, content: "", kind: "binary-skipped", bytes: stat.size };
  }

  if (buffer.length > maxFileBytes) {
    return {
      path: normalized,
      content: buffer.subarray(0, maxFileBytes).toString("utf-8"),
      kind: "too-large",
      bytes: stat.size,
    };
  }

  return { path: normalized, content: buffer.toString("utf-8"), kind: "text", bytes: stat.size };
}

export function writeFileInside(root: string, relativePath: string, content: string | Buffer): void {
  const resolved = safeResolve(root, relativePath);
  if (!resolved) throw new Error(`Output file escapes output directory: ${relativePath}`);
  ensureDir(path.dirname(resolved.absolutePath));
  writeFileSync(resolved.absolutePath, content);
}

export function safeReadJson(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function attachedFileXml(tag: string, file: AttachedFile): string {
  const attrs = `path="${escapeXml(file.path)}" kind="${file.kind}"${file.bytes === undefined ? "" : ` bytes="${file.bytes}"`}`;
  if (file.kind === "text" || file.kind === "too-large") {
    return `<${tag} ${attrs}>\n${file.content}\n</${tag}>`;
  }
  return `<${tag} ${attrs}>${file.kind}</${tag}>`;
}

export function slugify(value: string, fallback = "item"): string {
  // Normalization collapses each separator run to one dash, so trimming never
  // needs a quantified, end-anchored expression that can backtrack repeatedly.
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return slug || fallback;
}

export function walkFiles(root: string, predicate: (absolutePath: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && predicate(absolutePath)) {
        out.push(absolutePath);
      }
    }
  };
  visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}
