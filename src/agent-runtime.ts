/** Experimental native-runtime lifecycle. Not wired into the stable Provider API. */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface RuntimeInfo {
  name: string;
  version: string | null;
  adapterVersion: string | null;
  model: string | null;
  configuration: "explicit" | "inherited";
  /** Relative native discovery directory, e.g. .opencode/skills. */
  skillDirectory: string;
  capabilities: { toolOutcomes: boolean; skillLoading: boolean };
  /** Describe inherited configuration and external state; never include secrets. */
  limitations: string[];
}
export interface RuntimeToolEvent {
  id: string;
  name: string;
  arguments: unknown;
  status: 'attempted' | 'succeeded' | 'failed' | 'unknown';
  result?: unknown;
}
export interface AgentExecution {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  output: string;
  error?: string;
  toolEvents: RuntimeToolEvent[];
  skillLoading: { status: 'loaded' | 'failed' | 'not_observed' | 'unknown'; evidence: string[] };
  /** Missing metrics remain absent. Adapters define token/cost scope in limitations. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
export interface PreparedAgentRun {
  workDir: string;
  prompt: string;
  mode: 'with_skill' | 'without_skill';
  skillPath?: string;
  /** Persist adapter events as they occur, including generated continuation prompts. */
  recordEvent(event: unknown): void;
}
export interface AgentRuntime {
  probe(): Promise<RuntimeInfo>;
  /** Must stop owned processes/sessions on abort before settling this promise. */
  run(request: PreparedAgentRun, signal: AbortSignal): Promise<AgentExecution>;
}
export interface RuntimeVerification {
  name: string;
  /** Runs against its own copy of target state, never the target snapshot. */
  run(workDir: string, signal: AbortSignal): Promise<{ passed: boolean; evidence: string }>;
}
export interface FileRecord { path: string; sha256: string; executable: boolean }
export interface AgentRunResult {
  schemaVersion: 1;
  mode: PreparedAgentRun['mode'];
  runtime: RuntimeInfo;
  execution: AgentExecution;
  /** Filesystem isolation alone does not establish global-skill or MCP isolation. */
  baselineComparability: 'unverified';
  taskFiles: FileRecord[];
  initialFiles: FileRecord[];
  targetFiles: FileRecord[];
  changedFiles: string[];
  snapshotPath: string;
  tracePath: string;
  verification: { name: string; status: 'passed' | 'failed' | 'skipped'; evidence: string }[];
}

function relative(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || path.isAbsolute(value) || value.split('/').some(p => p === '..' || p === '.' || !p)) {
    throw new Error(`Expected a nonempty relative path: ${value}`);
  }
  return value;
}
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function canonicalDestination(destination: string): string {
  const absolute = path.resolve(destination);
  if (existsSync(absolute)) return realpathSync(absolute);
  return path.join(canonicalDestination(path.dirname(absolute)), path.basename(absolute));
}
/** No symlinks or special files: source resources must never be writable through staging. */
function copyTree(source: string, destination: string, excludes = new Set<string>(), root = true): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symlink cannot be staged or captured: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (root && excludes.has(name)) continue;
      copyTree(path.join(source, name), path.join(destination, name), excludes, false);
    }
  } else if (stat.isFile()) {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode & 0o777);
  } else throw new Error(`Unsupported special file: ${source}`);
}
function manifest(root: string, prefix = ''): FileRecord[] {
  return readdirSync(path.join(root, prefix)).sort().flatMap(name => {
    const file = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(root, file);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) return manifest(root, file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsupported captured file: ${file}`);
    return [{ path: file, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'), executable: Boolean(stat.mode & 0o111) }];
  });
}
function changes(before: FileRecord[], after: FileRecord[]): string[] {
  const a = new Map(before.map(file => [file.path, file]));
  const b = new Map(after.map(file => [file.path, file]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(file => {
    return a.get(file)?.sha256 !== b.get(file)?.sha256 || a.get(file)?.executable !== b.get(file)?.executable;
  }).sort();
}
function failure(error: unknown, signal: AbortSignal): AgentExecution {
  return { status: signal.aborted ? 'cancelled' : 'failed', output: '', error: String(error), toolEvents: [], skillLoading: { status: 'unknown', evidence: [] } };
}

/**
 * One case/mode. fixtureDir is a declared task-only directory, not the user's live project.
 * outputDir must be new and disjoint from inputs. This is not an OS security sandbox.
 */
export async function executeAgentRun(options: {
  runtime: AgentRuntime;
  fixtureDir: string;
  skill: { name: string; dir: string };
  mode: PreparedAgentRun['mode'];
  prompt: string;
  outputDir: string;
  signal?: AbortSignal;
  verification?: RuntimeVerification[];
}): Promise<AgentRunResult> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (!['with_skill', 'without_skill'].includes(options.mode)) throw new Error('Invalid run mode');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.skill.name)) throw new Error('Invalid skill name');
  const fixture = realpathSync(options.fixtureDir);
  const skill = realpathSync(options.skill.dir);
  const output = canonicalDestination(options.outputDir);
  for (const source of [fixture, skill]) {
    if (inside(source, output) || inside(output, source)) throw new Error('Output directory must be disjoint from input directories');
  }
  // Task inputs are separate from skills, runtime configuration, and evaluation answer keys.
  for (const reserved of ['.git', '.agents', '.claude', '.opencode', 'evals']) {
    if (existsSync(path.join(fixture, reserved))) throw new Error(`Task fixture contains reserved directory: ${reserved}`);
  }
  const runtime = await options.runtime.probe();
  const discovery = relative(runtime.skillDirectory);
  if (existsSync(path.join(fixture, discovery))) throw new Error('Fixture collides with native skill directory');
  signal.throwIfAborted();
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output); // Refuse reuse: no existing artifact or user directory is deleted.
  const scratch = mkdtempSync(path.join(tmpdir(), 'agent-skills-native-'));
  const workDir = path.join(scratch, 'target');
  const snapshotPath = path.join(output, 'target');
  const tracePath = path.join(output, 'trace.jsonl');
  writeFileSync(tracePath, '');
  let recording = true;
  const recordEvent = (event: unknown) => {
    if (!recording) throw new Error('Runtime recorded an event after completion');
    const serialized = JSON.stringify(event);
    if (serialized === undefined) throw new Error("Runtime event must be JSON serializable");
    appendFileSync(tracePath, `${serialized}\n`);
  };
  try {
    copyTree(fixture, workDir);
    const taskFiles = manifest(workDir);
    let skillPath: string | undefined;
    if (options.mode === 'with_skill') {
      skillPath = path.join(workDir, discovery, options.skill.name);
      copyTree(skill, skillPath, new Set(['evals', '.git']));
      if (!existsSync(path.join(skillPath, 'SKILL.md'))) throw new Error('Skill payload requires SKILL.md');
    }
    const initialFiles = manifest(workDir);
    let execution: AgentExecution;
    try {
      signal.throwIfAborted();
      execution = await options.runtime.run({ workDir, prompt: options.prompt, mode: options.mode, skillPath, recordEvent }, signal);
      if (signal.aborted) execution = { ...execution, status: 'cancelled' };
    } catch (error) { execution = failure(error, signal); }
    finally { recording = false; }
    // Preserve terminal evidence even if snapshotting subsequently rejects an unsafe file.
    writeFileSync(path.join(output, 'execution.json'), `${JSON.stringify(execution, null, 2)}\n`);
    copyTree(workDir, snapshotPath);
    const targetFiles = manifest(snapshotPath);
    const result: AgentRunResult = {
      schemaVersion: 1, mode: options.mode, runtime, execution, baselineComparability: 'unverified',
      taskFiles, initialFiles, targetFiles, changedFiles: changes(initialFiles, targetFiles), snapshotPath, tracePath, verification: [],
    };
    for (const [index, verifier] of (options.verification ?? []).entries()) {
      if (execution.status !== 'completed' || signal.aborted) {
        result.verification.push({ name: verifier.name, status: 'skipped', evidence: 'Target did not complete or run was cancelled' });
        continue;
      }
      const verifyDir = path.join(scratch, `verification-${index}`);
      copyTree(snapshotPath, verifyDir);
      try {
        const check = await verifier.run(verifyDir, signal);
        result.verification.push({ name: verifier.name, status: signal.aborted ? 'skipped' : check.passed ? 'passed' : 'failed', evidence: signal.aborted ? 'Run cancelled during verification' : check.evidence });
      } catch (error) {
        result.verification.push({ name: verifier.name, status: signal.aborted ? 'skipped' : 'failed', evidence: String(error) });
      } finally { rmSync(verifyDir, { recursive: true, force: true }); }
    }
    writeFileSync(path.join(output, 'run.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    writeFileSync(path.join(output, 'harness-error.json'), `${JSON.stringify({ error: String(error) }, null, 2)}\n`);
    throw error;
  } finally {
    recording = false;
    rmSync(scratch, { recursive: true, force: true });
  }
}
