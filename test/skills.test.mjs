import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildBenchmark,
  discoverSkills,
  ensureIterationDir,
  evaluateSkills,
  gradeOutputs,
  jsonlReporter,
  loadConfigFile,
  loadSkill,
  runEval,
} from "../dist/index.js";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-skills-eval-"));
}

function writeSkill(root, name = "csv-analyzer") {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "references"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "evals", "files"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Analyze CSV files.\n---\n\nUse CSV-specific checks.\n`);
  writeFileSync(path.join(dir, "references", "REFERENCE.md"), "Reference details");
  writeFileSync(path.join(dir, "scripts", "helper.sh"), "#!/usr/bin/env bash\necho helper\n");
  writeFileSync(path.join(dir, "evals", "files", "data.csv"), "month,revenue\nJan,10\n");
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "top-months",
      prompt: "Find top revenue months.",
      expected_output: "A summary of the top months.",
      files: ["evals/files/data.csv", "evals/files/missing.csv"],
      assertions: ["The output mentions top revenue months."]
    }]
  }));
  return dir;
}

function provider(output, extra = {}) {
  return {
    name: "mock",
    model: "mock-model",
    prompts: [],
    async complete(prompt) {
      this.prompts.push(prompt);
      return { provider: "mock", model: "mock-model", output, latencyMs: 25, inputTokens: 3, outputTokens: 4, costUsd: 0 };
    },
    ...extra,
  };
}

function judgeProvider(passed = true) {
  return provider("", { async complete(prompt) {
    this.prompts.push(prompt);
    const assertions = JSON.parse(prompt.match(/Assertions:\s*(\[[\s\S]*?\])\s*\n/)[1]);
    return { provider:"mock", model:"mock-model", latencyMs:25, inputTokens:3, outputTokens:4, costUsd:0,
      output:JSON.stringify({assertion_results:assertions.map(text => ({text,passed,evidence:passed?"Output contains the required phrase.":"Missing required phrase."}))}) };
  }});
}

test("loadSkill reads spec files and safe attachment states", () => {
  const root = tempRoot();
  const dir = writeSkill(root);
  const skill = loadSkill(dir);
  assert.equal(skill.name, "csv-analyzer");
  assert.equal(skill.references[0].kind, "text");
  assert.equal(skill.scripts[0].content, "#!/usr/bin/env bash");
  assert.equal(skill.evals.length, 1);
});

test("discoverSkills finds nested skills and plugin names", () => {
  const root = tempRoot();
  const plugin = path.join(root, "domain", "plugin");
  mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
  writeSkill(path.join(plugin, "skills"), "csv-analyzer");
  const refs = discoverSkills(root);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].pluginName, "demo-plugin");
  assert.equal(refs[0].hasEvals, true);
});

test("gradeOutputs returns spec grading JSON and fails closed", async () => {
  const good = await gradeOutputs({
    modelOutput: "Top revenue months: Jan",
    assertions: ["The output mentions top revenue months."],
    judge: { model: "judge", provider: judgeProvider(true) },
  });
  assert.deepEqual(good.grading.summary, { passed: 1, failed: 0, total: 1, pass_rate: 1 });

  const badJudge = provider("not json");
  const bad = await gradeOutputs({
    modelOutput: "x",
    assertions: ["Must pass"],
    judge: { model: "judge", provider: badJudge },
  });
  assert.equal(bad.grading.summary.failed, 1);
  assert.match(bad.grading.assertion_results[0].evidence, /unparseable/);
});

test("buildBenchmark and ensureIterationDir follow spec shapes", () => {
  const benchmark = buildBenchmark([
    { mode: "with_skill", passRate: 1, durationMs: 1000, tokens: 10 },
    { mode: "without_skill", passRate: 0.5, durationMs: 2000, tokens: 5 },
  ]);
  assert.equal(benchmark.run_summary.delta.pass_rate, 0.5);
  assert.equal(benchmark.run_summary.with_skill.time_seconds.mean, 1);

  const root = tempRoot();
  assert.equal(ensureIterationDir(root).iteration, 1);
  assert.equal(ensureIterationDir(root).iteration, process.env.CI === "true" ? 1 : 2);
});

test("runEval supports complete-only provider fallback and writes artifacts", async () => {
  const root = tempRoot();
  const skill = loadSkill(writeSkill(root));
  const workspace = path.join(root, "workspace");
  const target = provider("Top revenue months: Jan");
  const result = await runEval({
    skill,
    eval: skill.evals[0],
    modes: ["with_skill", "without_skill"],
    target: { model: "target", provider: target },
    judge: { model: "judge", provider: judgeProvider(true) },
    workspace,
    iteration: 1,
  });
  assert.ok(target.prompts[0].includes("---USER REQUEST---"));
  assert.ok(target.prompts[0].includes("<file path=\"evals/files/data.csv\""));
  assert.ok(existsSync(path.join(workspace, "iteration-1", result.slug, "with_skill", "grading.json")));
  assert.ok(existsSync(path.join(workspace, "iteration-1", result.slug, "without_skill", "timing.json")));
});

test("evaluateSkills produces spec workspace layout and summary", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "bench-workspace");
  const result = await evaluateSkills({
    root,
    workspace,
    baseline: true,
    target: { model: "target", provider: provider("Top revenue months: Jan") },
    judge: { model: "judge", provider: judgeProvider(true) },
  });
  assert.equal(result.failed, 0);
  assert.equal(result.skills.length, 1);
  const benchmark = JSON.parse(readFileSync(result.skills[0].benchmarkPath, "utf8"));
  assert.ok(benchmark.run_summary.with_skill);
  assert.ok(benchmark.run_summary.without_skill);
  assert.ok(existsSync(path.join(workspace, "csv-analyzer", "eval-top-months", "with_skill", "outputs")));
});

test("loadSkill normalizes mixed-shape assertions to strings", () => {
  const root = tempRoot();
  const name = "mixed-assertions";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Mixed-shape assertions test.\n---\n\nBody.\n`);
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "mixed",
      prompt: "Do the thing.",
      assertions: [
        "plain string assertion",
        { text: "object form text" },
        { value: "object form value" },
        { criterion: "object form criterion" },
      ],
    }],
  }));
  const skill = loadSkill(dir);
  assert.equal(skill.evals.length, 1);
  assert.deepEqual(skill.evals[0].assertions, [
    "plain string assertion",
    "object form text",
    "object form value",
    "object form criterion",
  ]);
});

test("loadSkill throws with path-aware message on malformed assertion entry", () => {
  const root = tempRoot();
  const name = "bad-assertions";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Bad assertion test.\n---\n\nBody.\n`);
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "bad",
      prompt: "Do the thing.",
      assertions: ["ok", { foo: "bar" }],
    }],
  }));
  assert.throws(
    () => loadSkill(dir),
    (err) => /evals\[0\]\.assertions\[1\]/.test(err.message) && /text\|value\|criterion/.test(err.message),
  );
});

test("evaluateSkills runs eval cases in parallel under concurrency", async () => {
  const root = tempRoot();
  const name = "concurrent-skill";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Concurrency test.\n---\n\nBody.\n`,
  );
  writeFileSync(
    path.join(dir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: name,
      evals: [
        { id: 1, name: "case-a", prompt: "do A", assertions: ["mentions A"] },
        { id: 2, name: "case-b", prompt: "do B", assertions: ["mentions B"] },
        { id: 3, name: "case-c", prompt: "do C", assertions: ["mentions C"] },
      ],
    }),
  );

  // Slow stub provider — every call sleeps 200ms before returning. Used for
  // both target and judge so each eval = 1 target + 1 judge = ~400ms serial.
  function slowProvider(output) {
    return {
      name: "slow",
      model: "slow-model",
      async complete() {
        await new Promise((r) => setTimeout(r, 200));
        return {
          provider: "slow",
          model: "slow-model",
          output,
          latencyMs: 200,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
      async completeChat() {
        await new Promise((r) => setTimeout(r, 200));
        return {
          provider: "slow",
          model: "slow-model",
          output,
          latencyMs: 200,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
    };
  }

  const judgeOutput = JSON.stringify({
    assertion_results: [{ text: "mentions thing", passed: true, evidence: "ok" }],
    summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
  });

  const workspace = path.join(root, "bench-workspace");
  const t0 = Date.now();
  const result = await evaluateSkills({
    root,
    workspace,
    target: { model: "target", provider: slowProvider("ok response") },
    judge: { model: "judge", provider: slowProvider(judgeOutput) },
    concurrency: 3,
    report: false,
  });
  const elapsed = Date.now() - t0;

  // Sequentially: 3 evals × (200ms target + 200ms judge) = ~1200ms.
  // With concurrency:3 the whole batch should finish in ~400ms; allow slack
  // for CI jitter / Node startup but still well under the serial floor.
  assert.ok(
    elapsed < 800,
    `expected concurrent run to finish in <800ms, got ${elapsed}ms`,
  );

  assert.equal(result.skills.length, 1);
  const slug = result.skills[0].slug;
  for (const evalSlug of ["eval-case-a", "eval-case-b", "eval-case-c"]) {
    assert.ok(
      existsSync(path.join(workspace, slug, evalSlug, "with_skill", "grading.json")),
      `missing grading.json for ${evalSlug}`,
    );
    assert.ok(
      existsSync(path.join(workspace, slug, evalSlug, "with_skill", "timing.json")),
      `missing timing.json for ${evalSlug}`,
    );
  }
  assert.ok(existsSync(result.skills[0].benchmarkPath), "benchmark.json should be written");
});

test("strict loadSkill validates required agentskills.io frontmatter", () => {
  const root = tempRoot();
  const dir = path.join(root, "bad-name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: BadName\ndescription: Valid description.\n---\n\nBody.\n`);
  assert.throws(
    () => loadSkill(dir, { strict: true }),
    (err) =>
      /frontmatter\.name/.test(err.message) &&
      /lowercase/.test(err.message),
  );
});

test("expected_output becomes a judge assertion when assertions are omitted", async () => {
  const root = tempRoot();
  const dir = path.join(root, "expected-output");
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: expected-output\ndescription: Tests expected output fallback.\n---\n\nBody.\n`,
  );
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: "expected-output",
    evals: [{
      id: 1,
      prompt: "Summarize the revenue.",
      expected_output: "A concise revenue summary.",
    }],
  }));

  const judge = judgeProvider(true);
  const skill = loadSkill(dir, { strict: true });
  const result = await runEval({
    skill,
    eval: skill.evals[0],
    modes: ["with_skill"],
    target: { model: "target", provider: provider("Concise revenue summary") },
    judge: { model: "judge", provider: judge },
    workspace: path.join(root, "workspace"),
    iteration: 1,
  });

  assert.equal(result.modes.with_skill.grading.summary.passed, 1);
  assert.match(result.modes.with_skill.judgePrompt, /A concise revenue summary/);
});

test("evaluateSkills can write the official iteration-N agentskills workspace layout", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const result = await evaluateSkills({
    root,
    workspace,
    baseline: true,
    workspaceLayout: "iteration",
    strict: true,
    report: false,
    target: { model: "target", provider: provider("Top revenue months: Jan") },
    judge: { model: "judge", provider: judgeProvider(true) },
  });

  assert.equal(result.iteration, 1);
  assert.equal(result.workspaceRoot, path.join(workspace, "iteration-1"));
  assert.equal(result.skills[0].benchmarkPath, path.join(workspace, "iteration-1", "benchmark.json"));
  assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-months", "with_skill", "outputs")));
  assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-months", "without_skill", "grading.json")));
});

test("loadConfigFile accepts YAML config for evaluator options", () => {
  const root = tempRoot();
  const configPath = path.join(root, "agent-skills-eval.yaml");
  writeFileSync(configPath, [
    "root: ./skills",
    "workspace: ./workspace",
    "baseline: true",
    "target: gpt-4o-mini",
    "judge: gpt-4.1-mini",
    "baseUrl: https://api.example.test/v1",
    "apiKeyEnv: TEST_API_KEY",
    "include:",
    "  - skills/**",
    "concurrency: 2",
    "layout: iteration",
    "strict: true",
    "report:",
    "  enabled: true",
    "  title: Skills Report",
    "logging:",
    "  format: jsonl",
    "  file: ./events.jsonl",
    "targetParams:",
    "  temperature: 0",
  ].join("\n"));

  const config = loadConfigFile(configPath);
  assert.equal(config.root, "./skills");
  assert.equal(config.workspace, "./workspace");
  assert.equal(config.baseline, true);
  assert.equal(config.target, "gpt-4o-mini");
  assert.equal(config.judge, "gpt-4.1-mini");
  assert.deepEqual(config.include, ["skills/**"]);
  assert.equal(config.concurrency, 2);
  assert.equal(config.layout, "iteration");
  assert.equal(config.strict, true);
  assert.deepEqual(config.report, { enabled: true, title: "Skills Report", output: undefined });
  assert.deepEqual(config.logging, {
    format: "jsonl",
    verbose: undefined,
    color: undefined,
    snippetLength: undefined,
    file: "./events.jsonl",
  });
  assert.deepEqual(config.targetParams, { temperature: 0 });
});

test("jsonlReporter emits machine-readable event logs", async () => {
  const lines = [];
  const reporter = jsonlReporter({ out: (line) => lines.push(line) });
  reporter.onEvent({
    type: "suite-start",
    skill: "demo",
    relPath: "demo",
    evalsCount: 1,
    modes: ["with_skill"],
    target: "target",
    judge: "judge",
  });
  await reporter.close();

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "suite-start");
  assert.equal(event.skill, "demo");
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
});
