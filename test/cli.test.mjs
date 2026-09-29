import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-skills-eval-cli-"));
}

function writeSkill(root) {
  const dir = path.join(root, "basic-skill");
  mkdirSync(path.join(dir, "evals", "files"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      "name: basic-skill",
      "description: Summarize revenue CSV files.",
      "---",
      "",
      "Identify the highest revenue month.",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "evals", "files", "revenue.csv"), "month,revenue\nJanuary,12\nFebruary,18\n");
  writeFileSync(
    path.join(dir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "basic-skill",
      evals: [
        {
          id: "top",
          name: "top month",
          prompt: "Find the top revenue month.",
          files: ["evals/files/revenue.csv"],
          assertions: ["The output names February.", "The output includes 18."],
        },
        {
          id: "bottom",
          name: "bottom month",
          prompt: "Find the bottom revenue month.",
          files: ["evals/files/revenue.csv"],
          assertions: ["The output names January.", "The output includes 12."],
        },
      ],
    }),
  );
}

function startOpenAiMock() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const user = parsed.messages?.at(-1)?.content ?? "";
      const isJudge = user.includes("Return STRICT JSON only") || user.includes("Assertions:");
      const content = isJudge
        ? JSON.stringify({
            assertion_results: [
              { text: "The output names February.", passed: true, evidence: "February is named." },
              { text: "The output includes 18.", passed: true, evidence: "18 is included." },
            ],
            summary: { passed: 2, failed: 0, total: 2, pass_rate: 1 },
          })
        : "February has the highest revenue with 18.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: parsed.model,
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("CLI runs from YAML config and writes JSONL logs plus report artifacts", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const logFile = path.join(root, "events.jsonl");
  const configPath = path.join(root, "agent-skills-eval.yaml");
  const mock = await startOpenAiMock();

  try {
    writeFileSync(configPath, [
      `root: ${JSON.stringify(root)}`,
      `workspace: ${JSON.stringify(workspace)}`,
      "baseline: true",
      "target: mock-target",
      "judge: mock-judge",
      `baseUrl: ${JSON.stringify(mock.url)}`,
      "apiKeyEnv: MOCK_OPENAI_KEY",
      "layout: iteration",
      "strict: true",
      "report:",
      "  enabled: true",
      "  title: CLI Test Report",
      "logging:",
      "  format: jsonl",
      `  file: ${JSON.stringify(logFile)}`,
    ].join("\n"));

    const { stdout } = await execFileAsync(
      process.execPath,
      ["dist/cli.js", "--config", configPath],
      {
        cwd: path.resolve("."),
        env: { ...process.env, MOCK_OPENAI_KEY: "test-key" },
      },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.failed, 0);
    assert.equal(result.iteration, 1);
    assert.equal(result.skills.length, 1);
    assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-month", "with_skill", "grading.json")));
    assert.ok(existsSync(path.join(workspace, "iteration-1", "report", "index.html")));

    const events = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "suite-start");
    assert.ok(events.some((event) => event.type === "eval-end" && event.mode === "with_skill"));
    assert.ok(mock.requests.length >= 4, "baseline run should call target and judge for both modes");
  } finally {
    await mock.close();
  }
});

test("CLI filters eval cases by id", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const mock = await startOpenAiMock();

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "dist/cli.js",
        root,
        "--workspace",
        workspace,
        "--target",
        "mock-target",
        "--judge",
        "mock-judge",
        "--base-url",
        mock.url,
        "--api-key-env",
        "MOCK_OPENAI_KEY",
        "--layout",
        "iteration",
        "--strict",
        "--no-report",
        "--log-format",
        "silent",
        "--eval-id",
        "bottom",
      ],
      {
        cwd: path.resolve("."),
        env: { ...process.env, MOCK_OPENAI_KEY: "test-key" },
      },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.failed, 0);
    assert.equal(result.skills[0].evals, 1);
    assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-bottom-month", "with_skill", "grading.json")));
    assert.equal(existsSync(path.join(workspace, "iteration-1", "eval-top-month", "with_skill", "grading.json")), false);
    assert.equal(mock.requests.length, 2, "one selected eval should call target and judge once");
    assert.ok(JSON.stringify(mock.requests).includes("Find the bottom revenue month."));
    assert.equal(JSON.stringify(mock.requests).includes("Find the top revenue month."), false);
  } finally {
    await mock.close();
  }
});
