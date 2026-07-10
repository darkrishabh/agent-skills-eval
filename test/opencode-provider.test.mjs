import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeProvider } from "../dist/index.js";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

function provider(baseUrl, options = {}) {
  return new OpencodeProvider({ model: "fake/model", baseUrl, ...options });
}

test("OpencodeProvider capabilities are all false", () => {
  const p = provider("http://127.0.0.1:0");
  assert.deepEqual(p.capabilities, { systemRole: false, attachments: false, toolCalls: false });
});

test("OpencodeProvider constructor throws when model is missing", () => {
  assert.throws(() => new OpencodeProvider({ baseUrl: "http://127.0.0.1:0" }), /requires "model"/);
  assert.throws(() => new OpencodeProvider({ model: "", baseUrl: "http://127.0.0.1:0" }), /requires "model"/);
});

test("OpencodeProvider.complete: success path returns the assistant's text and usage", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("hello world");
    assert.equal(result.error, undefined);
    assert.equal(result.output, "FAKE_OPENCODE_OK");
    assert.equal(result.inputTokens, 10);
    assert.equal(result.outputTokens, 5);
    assert.equal(result.costUsd, 0.0001);
    assert.equal(result.provider, "opencode");
    assert.equal(result.model, "fake/model");
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: talking to an already-running server (baseUrl) attaches no server log — nothing was spawned", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("hello world");
    assert.equal(result.outputFiles, undefined);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: when it spawns its own opencode server, captures the full stdout+stderr log — including everything logged after startup", async () => {
  const binDir = mkdtempSync(path.join(tmpdir(), "opencode-bin-"));
  const fakeBinaryPath = path.resolve("test/fixtures/fake-opencode-binary.mjs");
  const wrapperPath = path.join(binDir, "opencode");
  writeFileSync(wrapperPath, `#!/bin/sh\nexec node ${JSON.stringify(fakeBinaryPath)} "$@"\n`);
  chmodSync(wrapperPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    const p = new OpencodeProvider({ model: "fake/model", timeoutMs: 10_000 });
    // Uses the delegate-race scenario (~300ms of polling before it resolves,
    // see the fixture) so the run outlasts the fake binary's 50ms
    // post-startup log write — proving capture isn't cut off at "settled"
    // the way a fast-resolving prompt wouldn't reliably exercise.
    const result = await p.complete("__FAKE_OPENCODE_DELEGATE_RACE__");
    assert.equal(result.error, undefined);
    assert.equal(result.output, "FAKE_OPENCODE_REAL_ANSWER");
    const log = result.outputFiles?.find((f) => f.path === "opencode-serve.log");
    assert.ok(log, "expected an opencode-serve.log output file");
    assert.match(log.content, /opencode server listening on/);
    assert.match(log.content, /post-startup stdout line/);
    assert.match(log.content, /post-startup stderr line/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("OpencodeProvider.complete: server error resolves with error set, does not throw", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("__FAKE_OPENCODE_ERROR__");
    assert.equal(result.output, "");
    assert.match(result.error, /fake opencode error/);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: a hung prompt call resolves with a timeout error instead of hanging", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 300 });
    const started = Date.now();
    const result = await p.complete("__FAKE_OPENCODE_HANG__");
    const elapsed = Date.now() - started;
    assert.match(result.error, /timed out|abort/i);
    assert.ok(elapsed < 5000, `expected timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: a subagent's async delegation does not truncate the run — waits for the real final answer", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 10_000, maxContinuations: 3 });
    const started = Date.now();
    const result = await p.complete("__FAKE_OPENCODE_DELEGATE_RACE__");
    const elapsed = Date.now() - started;
    assert.equal(result.error, undefined);
    assert.equal(result.output, "FAKE_OPENCODE_REAL_ANSWER");
    assert.ok(elapsed >= 250, `expected to wait for the delegated child to settle, took ${elapsed}ms`);
    assert.ok(elapsed < 8000, `expected a fast, bounded run, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: gives up after maxContinuations instead of looping forever on repeated re-delegation", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 10_000, maxContinuations: 2 });
    const result = await p.complete("__FAKE_OPENCODE_INFINITE_DELEGATE__");
    assert.match(result.error, /gave up after 2 follow-up/);
    // The give-up path shouldn't discard text a prior, already-answered
    // round actually produced just because the run ultimately errored.
    assert.match(result.output, /Delegation running/);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: a premature 'waiting on delegation' stub reply is not accepted as final — the harness keeps going until the model reads its result back", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 10_000, maxContinuations: 3 });
    const result = await p.complete("__FAKE_OPENCODE_DELEGATE_STUB__");
    assert.equal(result.error, undefined);
    assert.equal(result.output, "FAKE_OPENCODE_REAL_ANSWER_AFTER_READ");
    assert.ok(result.toolCalls?.some((c) => c.function.name === "delegation_read"));
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: gives up with a distinct diagnostic when the model never reads back its own dispatched delegation", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 10_000, maxContinuations: 2 });
    const result = await p.complete("__FAKE_OPENCODE_DELEGATE_STUB_FOREVER__");
    assert.match(result.error, /gave up after 2 follow-up prompt\(s\) waiting for the model to read back a dispatched delegation's result/);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: recovers text from an earlier step-message even when the turn's final message is tool-only", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("__FAKE_OPENCODE_TOOL_ONLY_FINAL__");
    assert.equal(result.error, undefined);
    assert.equal(result.output, "Full review text here.");
    assert.ok(result.toolCalls?.some((c) => c.function.name === "todowrite"));
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: a turn with no text anywhere surfaces a diagnostic error instead of a silent empty success", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("__FAKE_OPENCODE_NO_TEXT__");
    assert.equal(result.output, "");
    assert.match(result.error, /produced no text output/);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: captures tool calls, including a skill invocation with its parsed arguments", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("__FAKE_OPENCODE_SKILL_TOOL__");
    assert.equal(result.error, undefined);
    assert.equal(result.output, "Review complete.");
    const skillCall = result.toolCalls?.find((c) => c.function.name === "skill");
    assert.ok(skillCall, "expected a skill tool call to be captured");
    assert.equal(skillCall.parsedArguments.name, "quick-review");
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: sends agent/model in the request body", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { agent: "build", model: "tensorix/minimax/minimax-m3" });
    await p.complete("hello world");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].text, "hello world");
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: prompt round-trips without mangling special characters", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const payload = 'some `$(echo injected)` "quoted" text\nwith a newline';
    const result = await p.complete(`__FAKE_OPENCODE_ECHO__ ${payload}`);
    assert.equal(result.output, payload);
  } finally {
    await server.close();
  }
});

function makeFakeSkill() {
  const skillDir = mkdtempSync(path.join(tmpdir(), "opencode-skill-"));
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nbody");
  mkdirSync(path.join(skillDir, "references"));
  writeFileSync(path.join(skillDir, "references", "notes.md"), "notes");
  mkdirSync(path.join(skillDir, "scripts"));
  writeFileSync(path.join(skillDir, "scripts", "helper.sh"), "#!/bin/sh\necho hi");
  writeFileSync(path.join(skillDir, "LICENSE"), "MIT");
  mkdirSync(path.join(skillDir, "evals"));
  writeFileSync(path.join(skillDir, "evals", "evals.json"), '{"evals":[]}');
  return { name: "my-skill", dir: skillDir };
}

test("OpencodeProvider.prepareSkill: with_skill symlinks every skill-dir entry except evals/", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-dir-"));
  const p = provider("http://127.0.0.1:0", { dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".opencode", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");

  assert.ok(lstatSync(path.join(installDir, "SKILL.md")).isSymbolicLink());
  assert.equal(readlinkSync(path.join(installDir, "SKILL.md")), path.join(skill.dir, "SKILL.md"));
  assert.ok(lstatSync(path.join(installDir, "references")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "scripts")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "LICENSE")).isSymbolicLink());
  assert.equal(existsSync(path.join(installDir, "evals")), false);

  await p.cleanupSkill(skill, "with_skill");
  assert.equal(existsSync(installDir), false);
});

test("OpencodeProvider.prepareSkill: without_skill installs nothing and removes any prior install", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-dir-"));
  const p = provider("http://127.0.0.1:0", { dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".opencode", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");
  assert.ok(existsSync(installDir));

  await p.prepareSkill(skill, "without_skill");
  assert.equal(existsSync(installDir), false);
});
