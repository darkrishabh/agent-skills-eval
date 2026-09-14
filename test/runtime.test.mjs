import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeTrace, gradeRuntime } from "../dist/runtime.js";

const jsonl = (...events) => events.map(event => JSON.stringify(event)).join("\n");
const done = { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } };
const command = (id, text, exitCode = 0) => ({ type: "item.completed", item: { id, type: "command_execution", command: text, exit_code: exitCode, status: "completed" } });
const assistant = (...content) => ({ type: "assistant", message: { content, usage: { input_tokens: 999, output_tokens: 999 } } });
const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (id, is_error = false, content = "ok") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content }] } });
const claudeDone = { type: "result", subtype: "success", is_error: false, result: "Finished", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.02 };
const execution = (trace, workDir = os.tmpdir(), extra = {}) => ({ trace, workDir, stdout: "", stderr: "", exitCode: 0, outputFiles: [], changedFiles: [], verification: [], ...extra });
const find = (results, text) => results.find(result => result.text.includes(text));

test("Codex deduplicates command lifecycle and records final status, text, usage", () => {
  const trace = normalizeTrace("codex", jsonl(
    { type: "item.started", item: { id: "one", type: "command_execution", command: "npm test", status: "in_progress" } },
    command("one", "npm test"), command("one", "npm test"),
    command("two", "npm run build", 1),
    { type: "item.completed", item: { id: "msg", type: "agent_message", text: "Done" } }, done,
  ), { durationMs: 123 });
  assert.equal(trace.complete, true);
  assert.equal(trace.commands.length, 2);
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.commands[0].status, "completed");
  assert.equal(trace.commands[1].status, "failed");
  assert.equal(trace.output, "Done");
  assert.equal(trace.inputTokens, 12);
  assert.equal(trace.durationMs, 123);
  assert.equal(trace.costUsd, undefined);
});

test("Claude correlates requests/results and trusts final usage without double counting", () => {
  const trace = normalizeTrace("claude", jsonl(
    assistant(tool("a", "Bash", { command: "npm test" })),
    assistant(tool("a", "Bash", { command: "npm test" })), result("a"),
    assistant(tool("b", "Bash", { command: "rm secret" })), result("b", true, "Permission denied"),
    assistant(tool("c", "Bash", { command: "npm run pending" })), claudeDone,
  ));
  assert.equal(trace.commands.length, 3);
  assert.deepEqual(trace.commands.map(item => item.status), ["completed", "failed", "unknown"]);
  assert.equal(trace.inputTokens, 35);
  assert.equal(trace.outputTokens, 7);
  assert.equal(trace.costUsd, 0.02);
  assert.equal(trace.output, "Finished");
  assert.equal(trace.permissionDenials.length, 1);
});

test("malformed, nonobject, unknown-only and unfinished streams fail closed", () => {
  for (const stdout of ["not json", "[]", "null", '{"type":"thread.started"}', "", jsonl(done) + "\nnot json"]) {
    const trace = normalizeTrace("codex", stdout);
    assert.equal(trace.complete, false, stdout);
    assert.ok(trace.errors.length > 0, stdout);
    const grades = gradeRuntime(execution(trace), {}, { skillName: "sample", shouldTrigger: false });
    assert.equal(find(grades, "trigger").passed, false);
  }
});

test("terminal errors and Claude result errors are not successful complete traces", () => {
  for (const [runtime, event] of [["codex", { type: "turn.failed", error: { message: "failed" } }], ["claude", { type: "result", subtype: "error_max_turns", is_error: true, errors: ["turn limit"] }]]) {
    const trace = normalizeTrace(runtime, jsonl(event));
    assert.equal(trace.complete, false);
    assert.ok(trace.errors.length > 0);
  }
});

test("skill trigger requires successful selected file read, not mentions, listing or grep", () => {
  const selected = ".agents/skills/sample/SKILL.md";
  for (const text of [`echo 'cat ${selected}'`, `ls ${selected}`, `rg test ${selected}`, "cat .agents/skills/other/SKILL.md", `cat ${selected} || true`]) {
    assert.deepEqual(normalizeTrace("codex", jsonl(command("a", text), done), { skillName: "sample", skillPath: selected }).skillInvocations, [], text);
  }
  for (const text of [`cat ${selected}`, `sed -n '1,200p' ${selected}`, `powershell -Command "Get-Content '${selected}'"`]) {
    assert.equal(normalizeTrace("codex", jsonl(command("a", text), done), { skillName: "sample", skillPath: selected }).skillInvocations.length, 1, text);
  }
  assert.equal(normalizeTrace("codex", jsonl(command("a", `cat ${selected}`, 1), done), { skillName: "sample", skillPath: selected }).skillInvocations.length, 0);
});

test("Claude Skill and Read evidence requires a successful matching tool result", () => {
  const options = { skillName: "sample", skillPath: ".claude/skills/sample/SKILL.md" };
  assert.equal(normalizeTrace("claude", jsonl(assistant(tool("a", "Skill", { skill: "sample" })), claudeDone), options).skillInvocations.length, 0);
  assert.equal(normalizeTrace("claude", jsonl(assistant(tool("a", "Skill", { skill: "other" })), result("a"), claudeDone), options).skillInvocations.length, 0);
  for (const input of [tool("a", "Skill", { skill: "sample" }), tool("a", "Read", { file_path: options.skillPath })]) {
    assert.equal(normalizeTrace("claude", jsonl(assistant(input), result("a"), claudeDone), options).skillInvocations.length, 1);
    assert.equal(normalizeTrace("claude", jsonl(assistant(input), result("a", true), claudeDone), options).skillInvocations.length, 0);
  }
});

test("checks use successful command evidence, attempted forbidden commands, order, repeats and unknown budgets", () => {
  const trace = normalizeTrace("codex", jsonl(command("a", "npm install"), command("b", "npm test", 1), command("c", "npm test"), done), { durationMs: 50 });
  const grades = gradeRuntime(execution(trace), { requiredCommands: ["npm install", "missing"], forbiddenCommands: ["npm test"], commandOrder: ["npm install", "npm test"], maxCommands: 2, maxRepeatedCommands: 0, maxTokens: 20, maxDurationMs: 100, maxCostUsd: 100 });
  assert.equal(find(grades, "required command: npm install").passed, true);
  assert.equal(find(grades, "required command: missing").passed, false);
  assert.equal(find(grades, "forbidden command").passed, false);
  assert.equal(find(grades, "command order").passed, true);
  assert.equal(find(grades, "maxCommands").passed, false);
  assert.equal(find(grades, "maxRepeatedCommands").passed, false);
  assert.equal(find(grades, "maxTokens").passed, true);
  assert.equal(find(grades, "maxDurationMs").passed, true);
  assert.equal(find(grades, "maxCostUsd").passed, false);
  assert.match(find(grades, "maxCostUsd").evidence, /unknown/i);
  assert.ok(grades.every(grade => grade.evidence && grade.category));
});

test("filesystem checks inspect real files, reject traversal/symlink escapes and apply allowlists", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trace-grade-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, "work");
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  fs.writeFileSync(path.join(work, "src", "out.txt"), "verified output");
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(base, "outside", "secret.txt"), "verified output");
  fs.symlinkSync(path.join(base, "outside"), path.join(work, "escape"), "junction");
  const grades = gradeRuntime(execution(normalizeTrace("codex", jsonl(done)), work, { changedFiles: ["src/out.txt", "escape/secret.txt", "unexpected.txt"] }), {
    requiredFiles: ["src/out.txt", "src", "../outside/secret.txt", "escape/secret.txt"],
    forbiddenFiles: ["missing.txt", "../outside/secret.txt"],
    fileContents: [{ path: "src/out.txt", contains: "verified" }, { path: "escape/secret.txt", contains: "verified" }],
    allowedChanges: ["src/**", "escape/**"],
  });
  assert.equal(find(grades, "required file: src/out.txt").passed, true);
  assert.equal(grades.find(grade => grade.text === "required file: src").passed, false);
  assert.equal(find(grades, "required file: ../outside").passed, false);
  assert.equal(find(grades, "required file: escape").passed, false);
  assert.equal(find(grades, "forbidden file: missing").passed, true);
  assert.equal(find(grades, "forbidden file: ../outside").passed, false);
  assert.equal(find(grades, "file content: src").passed, true);
  assert.equal(find(grades, "file content: escape").passed, false);
  assert.equal(find(grades, "allowed changes").passed, false);
});

test("valid complete non-trigger run passes negative; failed runtime and permission denial have evidence", () => {
  const trace = normalizeTrace("claude", jsonl({ ...claudeDone, permission_denials: [{ tool_name: "Bash", tool_input: { command: "write" } }] }));
  const grades = gradeRuntime(execution(trace, os.tmpdir(), { exitCode: 1, stderr: "CLI failed" }), { noPermissionDenials: true }, { skillName: "sample", shouldTrigger: false });
  assert.equal(find(grades, "trigger").passed, false);
  assert.equal(find(grades, "runtime execution").passed, false);
  assert.equal(find(grades, "permission denials").passed, false);
  assert.equal(find(gradeRuntime(execution(normalizeTrace("claude", jsonl(claudeDone))), {}, { skillName: "sample", shouldTrigger: false }), "trigger").passed, true);
});

test("pending tools and commands make negative trigger evidence incomplete despite terminal success", () => {
  const traces = [
    normalizeTrace("claude", jsonl(assistant(tool("a", "Read", { file_path: ".claude/skills/sample/SKILL.md" })), claudeDone), { skillName: "sample" }),
    normalizeTrace("codex", jsonl({ type: "item.started", item: { id: "a", type: "command_execution", command: "cat .agents/skills/sample/SKILL.md" } }, done), { skillName: "sample" }),
  ];
  for (const trace of traces) {
    assert.equal(trace.complete, false);
    assert.match(trace.errors.join(" "), /incomplete|result|pending/i);
    assert.equal(find(gradeRuntime(execution(trace), {}, { skillName: "sample", shouldTrigger: false }), "trigger").passed, false);
  }
});

test("Claude schema-constrained output is preserved for a runtime judge", () => {
  const structured = { assertion_results: [{ text: "correct", passed: true, evidence: "yes" }] };
  const trace = normalizeTrace("claude", jsonl({ ...claudeDone, result: "", structured_output: structured }));
  assert.deepEqual(JSON.parse(trace.output), structured);
});

test("tool help/version requests do not count as reading a skill", () => {
  const trace = normalizeTrace("codex", jsonl(command("a", "cat --help .agents/skills/sample/SKILL.md"), done), { skillName: "sample" });
  assert.equal(trace.skillInvocations.length, 0);
});

test("unknown exit status and interrupted Claude tools do not claim successful reads", () => {
  const codex = normalizeTrace("codex", jsonl({ type: "item.completed", item: { id: "a", type: "command_execution", command: "cat .agents/skills/sample/SKILL.md", status: "completed", exit_code: null } }, done), { skillName: "sample" });
  assert.equal(codex.complete, false);
  const claude = normalizeTrace("claude", jsonl(assistant(tool("a", "Bash", { command: "cat .claude/skills/sample/SKILL.md" })), { ...result("a"), tool_use_result: { interrupted: true, stdout: "", stderr: "" } }, claudeDone), { skillName: "sample" });
  assert.equal(claude.commands[0].status, "failed");
  assert.equal(claude.skillInvocations.length, 0);
});

test("Windows absolute and relative selected skill paths match with case-insensitive drive semantics", () => {
  const trace = normalizeTrace("codex", jsonl(command("a", 'powershell.exe -Command "Get-Content C:\\Temp\\run\\.agents\\skills\\sample\\SKILL.md"'), done), { skillName: "sample", skillPath: ".agents/skills/sample/SKILL.md" });
  assert.equal(trace.skillInvocations.length, 1);
});
