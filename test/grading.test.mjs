import test from "node:test";
import assert from "node:assert/strict";
import { gradeOutputs, RUBRIC_SCHEMA } from "../dist/grade.js";
import { OpenAICompatibleProvider } from "../dist/openai-compatible-provider.js";

function judgeWith(result) {
  return { model: "test", provider: { name: "test", model: "test", async complete() {
    return { output: JSON.stringify(result), latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  } } };
}
const row = (text, passed = true, evidence = "Quoted output evidence") => ({ text, passed, evidence });

test("rubric grading matches exact identities even when judge reorders rows", async () => {
  const result = await gradeOutputs({ modelOutput: "answer", assertions: ["first", "second"],
    judge: judgeWith({ assertion_results: [row("second", false), row("first")] }) });
  assert.deepEqual(result.grading.assertion_results.map(r => [r.text, r.passed, r.category]),
    [["first", true, "style"], ["second", false, "style"]]);
});

test("rubric grading fails closed on duplicate, missing, unknown, nonboolean or empty-evidence rows", async () => {
  for (const rows of [[row("first"), row("first")], [], [row("unknown")],
    [row("first", "true")], [row("first", true, " ")]]) {
    let calls = 0;
    const judge = judgeWith({ assertion_results: rows });
    const complete = judge.provider.complete;
    judge.provider.complete = async () => { calls++; return complete(); };
    const result = await gradeOutputs({ modelOutput: "answer", assertions: ["first"], judge });
    assert.equal(result.grading.summary.passed, 0);
    assert.equal(calls, 2);
  }
});

test("judge errors and thrown requests cannot become passes and retain failure evidence", async () => {
  for (const throws of [false, true]) {
    const judge = judgeWith({ assertion_results: [row("first")] });
    const complete = judge.provider.complete;
    judge.provider.complete = async () => {
      if (throws) throw new Error("judge unavailable");
      return { ...await complete(), error: "judge unavailable" };
    };
    const result = await gradeOutputs({ modelOutput: "answer", assertions: ["first"], judge });
    assert.equal(result.grading.summary.passed, 0);
    assert.match(result.grading.assertion_results[0].evidence, /judge unavailable/);
  }
});

test("custom grading prompt retains file evidence, contract and retry guidance", async () => {
  const prompts = [];
  const judge = judgeWith({ assertion_results: [row("first")] });
  const complete = judge.provider.complete;
  judge.provider.complete = async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? { output: "bad JSON" } : complete();
  };
  const result = await gradeOutputs({ modelOutput: "answer", assertions: ["first"], judge,
    gradingPrompt: "Use our custom rubric", outputFiles: [{path: "proof.txt", kind: "text", content: "file evidence"}] });
  assert.equal(result.grading.summary.passed, 1);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /Use our custom rubric/);
    assert.match(prompt, /proof.txt/);
    assert.match(prompt, /file evidence/);
    assert.match(prompt, /verbatim/);
  }
  assert.match(prompts[1], /Previous response/);
});

test("structured judges receive the rubric schema without requiring systemRole", async () => {
  let received;
  const judge = judgeWith({ assertion_results: [row("first")] });
  judge.provider.capabilities = { structuredOutput: true };
  judge.provider.completeChat = async args => { received = args; return judge.provider.complete(); };
  const result = await gradeOutputs({ modelOutput: "answer", assertions: ["first"], judge });
  assert.equal(result.grading.summary.passed, 1);
  assert.deepEqual(received.outputSchema, RUBRIC_SCHEMA);
  assert.equal(received.system, undefined);
});

test("deterministic assertions need no judge; rubric requires a judge and unique identities", async () => {
  const result = await gradeOutputs({ modelOutput: "", assertions: [],
    toolAssertions: [{type: "tool-not-called", name: "danger"}] });
  assert.equal(result.grading.summary.passed, 1);
  assert.equal(result.grading.assertion_results[0].category, "process");
  assert.equal(result.judgePrompt, "");
  await assert.rejects(gradeOutputs({ modelOutput: "", assertions: ["first"] }), /judge.*required/i);
  await assert.rejects(gradeOutputs({ modelOutput: "", assertions: ["first", "first"],
    judge: judgeWith({}) }), /duplicate/i);
});

test("OpenAI adapter sends strict json_schema and permits explicit compatibility opt-out", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{message: {content: "{}"}}] }) };
  });
  const provider = new OpenAICompatibleProvider({baseUrl: "https://example.invalid/v1", apiKey: "", model: "test"});
  await provider.completeChat({ user: "grade", outputSchema: RUBRIC_SCHEMA,
    params: { response_format: { type: "text" } } });
  assert.deepEqual(requests[0].response_format, {type: "json_schema", json_schema: {name: "evaluation_result", strict: true, schema: RUBRIC_SCHEMA}});
  const legacy = new OpenAICompatibleProvider({baseUrl: "https://example.invalid/v1", apiKey: "", structuredOutput: false});
  assert.equal(legacy.capabilities.structuredOutput, false);
  await legacy.completeChat({user: "grade", outputSchema: RUBRIC_SCHEMA});
  assert.equal(requests[1].response_format, undefined);
});
