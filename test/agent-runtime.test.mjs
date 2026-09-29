import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAgentRun } from '../dist/agent-runtime.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-contract-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureDir = path.join(root, 'fixture');
  const dir = path.join(root, 'skill');
  fs.mkdirSync(fixtureDir);
  fs.mkdirSync(path.join(dir, 'evals'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'input.txt'), 'original input');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'Use helper.mjs');
  fs.writeFileSync(path.join(dir, 'helper.mjs'), 'console.log("helper")');
  fs.writeFileSync(path.join(dir, 'evals', 'answers.json'), 'secret rubric');
  return { root, fixtureDir, skill: { name: 'demo', dir }, mode: 'with_skill', prompt: 'perform task', outputDir: path.join(root, 'out') };
}
function adapter(run = async () => completed()) {
  return {
    async probe() {
      return { name: 'fake', version: 'fixture-v1', adapterVersion: 'test-v1', model: null, configuration: 'explicit', skillDirectory: '.fake/skills', capabilities: { toolOutcomes: true, skillLoading: true }, limitations: ['Fixture adapter; global configuration and MCP state are not isolated'] };
    },
    run,
  };
}
function completed(extra = {}) {
  return { status: 'completed', output: 'done', toolEvents: [], skillLoading: { status: 'unknown', evidence: [] }, ...extra };
}

test('parallel modes start from matching task bytes and preserve source payloads', async t => {
  const args = setup(t);
  const directories = [];
  const runtime = adapter(async ({ workDir, skillPath, mode, recordEvent }) => {
    directories.push(workDir);
    assert.equal(fs.readFileSync(path.join(workDir, 'input.txt'), 'utf8'), 'original input');
    if (mode === 'with_skill') {
      assert.equal(fs.readFileSync(path.join(skillPath, 'helper.mjs'), 'utf8'), 'console.log("helper")');
      assert.equal(fs.existsSync(path.join(skillPath, 'evals')), false);
      fs.writeFileSync(path.join(skillPath, 'helper.mjs'), 'mutated copy');
    } else assert.equal(fs.existsSync(path.join(workDir, '.fake')), false);
    fs.writeFileSync(path.join(workDir, 'input.txt'), mode);
    recordEvent({ type: 'native', mode });
    await new Promise(resolve => setTimeout(resolve, 5));
    return completed();
  });
  const [withSkill, without] = await Promise.all(['with_skill', 'without_skill'].map(mode => executeAgentRun({ ...args, runtime, mode, outputDir: path.join(args.root, mode) })));
  assert.notEqual(directories[0], directories[1]);
  assert.deepEqual(withSkill.taskFiles, without.taskFiles);
  for (const result of [withSkill, without]) {
    assert.equal(result.baselineComparability, 'unverified');
    assert.equal(fs.readFileSync(path.join(result.snapshotPath, 'input.txt'), 'utf8'), result.mode);
    assert.equal(JSON.parse(fs.readFileSync(result.tracePath, 'utf8')).mode, result.mode);
  }
  assert.ok(directories.every(dir => !fs.existsSync(dir)));
  assert.equal(fs.readFileSync(path.join(args.fixtureDir, 'input.txt'), 'utf8'), 'original input');
  assert.equal(fs.readFileSync(path.join(args.skill.dir, 'helper.mjs'), 'utf8'), 'console.log("helper")');
});

test('verifier-created files cannot appear in target evidence or another verifier', async t => {
  const args = setup(t);
  const seen = [];
  const result = await executeAgentRun({ ...args, runtime: adapter(), verification: [
    { name: 'build', async run(dir) { seen.push(dir); fs.writeFileSync(path.join(dir, 'report.txt'), 'verifier output'); return { passed: true, evidence: 'build finished' }; } },
    { name: 'required target file', async run(dir) { seen.push(dir); return { passed: fs.existsSync(path.join(dir, 'report.txt')), evidence: 'report.txt presence' }; } },
  ] });
  assert.deepEqual(result.changedFiles, []);
  assert.equal(fs.existsSync(path.join(result.snapshotPath, 'report.txt')), false);
  assert.deepEqual(result.verification.map(r => r.status), ['passed', 'failed']);
  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen.every(dir => !fs.existsSync(dir)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(args.outputDir, 'run.json'), 'utf8')).targetFiles.some(f => f.path === 'report.txt'), false);
});

test('target errors retain partial events and files, skip verification, and clean scratch', async t => {
  const args = setup(t);
  let work;
  const result = await executeAgentRun({ ...args, runtime: adapter(async ({ workDir, recordEvent }) => {
    work = workDir;
    recordEvent({ type: 'started' });
    fs.writeFileSync(path.join(workDir, 'partial.txt'), 'partial evidence');
    throw new Error('agent failed');
  }), verification: [{ name: 'must not run', async run() { assert.fail('verification ran'); } }] });
  assert.equal(result.execution.status, 'failed');
  assert.match(result.execution.error, /agent failed/);
  assert.deepEqual(result.changedFiles, ['partial.txt']);
  assert.equal(result.verification[0].status, 'skipped');
  assert.equal(fs.existsSync(work), false);
  assert.equal(fs.readFileSync(path.join(result.snapshotPath, 'partial.txt'), 'utf8'), 'partial evidence');
});

test('cooperative cancellation retains evidence and prevents verification', async t => {
  const args = setup(t);
  const controller = new AbortController();
  const result = await executeAgentRun({ ...args, signal: controller.signal, runtime: adapter(async ({ recordEvent }, signal) => {
    recordEvent({ type: 'partial' });
    controller.abort();
    signal.throwIfAborted();
  }), verification: [{ name: 'check', async run() { assert.fail('cancelled'); } }] });
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.verification[0].status, 'skipped');
  assert.match(fs.readFileSync(result.tracePath, 'utf8'), /partial/);
});

test('failed tool/skill outcomes remain failed and unknown usage stays absent', async t => {
  const args = setup(t);
  const result = await executeAgentRun({ ...args, runtime: adapter(async () => completed({
    toolEvents: [{ id: '1', name: 'skill', arguments: { name: 'demo' }, status: 'failed', result: 'permission denied' }],
    skillLoading: { status: 'failed', evidence: ['permission denied'] },
  })) });
  const saved = JSON.parse(fs.readFileSync(path.join(args.outputDir, 'run.json'), 'utf8'));
  assert.equal(saved.execution.toolEvents[0].status, 'failed');
  assert.equal(saved.execution.skillLoading.status, 'failed');
  assert.equal('usage' in saved.execution, false);
  assert.equal(result.runtime.version, 'fixture-v1');
});

test('existing artifact directories and directories overlapping inputs are rejected', async t => {
  const args = setup(t);
  fs.mkdirSync(args.outputDir);
  fs.writeFileSync(path.join(args.outputDir, 'keep.txt'), 'keep');
  await assert.rejects(executeAgentRun({ ...args, runtime: adapter() }), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(args.outputDir, 'keep.txt'), 'utf8'), 'keep');
  for (const outputDir of [args.root, path.join(args.fixtureDir, 'output'), path.join(args.skill.dir, 'output')]) {
    await assert.rejects(executeAgentRun({ ...args, outputDir, runtime: adapter() }), /disjoint/);
  }
});

test('rejects native skill/config fixtures, invalid discovery paths, and symlink resources', async t => {
  const args = setup(t);
  fs.mkdirSync(path.join(args.fixtureDir, '.agents'));
  await assert.rejects(executeAgentRun({ ...args, runtime: adapter() }), /reserved/);
  fs.rmSync(path.join(args.fixtureDir, '.agents'), { recursive: true });
  const runtime = adapter();
  runtime.probe = async () => ({ skillDirectory: '../outside' });
  await assert.rejects(executeAgentRun({ ...args, runtime }), /relative/);
  fs.symlinkSync(path.join(args.fixtureDir, 'input.txt'), path.join(args.skill.dir, 'link'));
  await assert.rejects(executeAgentRun({ ...args, runtime: adapter() }), /Symlink/);
  assert.equal(fs.readFileSync(path.join(args.fixtureDir, 'input.txt'), 'utf8'), 'original input');
  assert.ok(fs.existsSync(path.join(args.outputDir, 'harness-error.json')));
});

test('unsafe target artifacts retain trace and terminal evidence without following links', async t => {
  const args = setup(t);
  let work;
  await assert.rejects(executeAgentRun({ ...args, runtime: adapter(async ({ workDir, recordEvent }) => {
    work = workDir;
    recordEvent({ type: 'before-snapshot' });
    fs.symlinkSync(args.fixtureDir, path.join(workDir, 'outside'));
    return completed();
  }) }), /Symlink/);
  assert.ok(fs.existsSync(path.join(args.outputDir, 'execution.json')));
  assert.match(fs.readFileSync(path.join(args.outputDir, 'trace.jsonl'), 'utf8'), /before-snapshot/);
  assert.equal(fs.existsSync(work), false);
});

test('verifier failure does not mutate frozen target and subsequent checks still run', async t => {
  const args = setup(t);
  const result = await executeAgentRun({ ...args, runtime: adapter(), verification: [
    { name: 'throw', async run(dir) { fs.unlinkSync(path.join(dir, 'input.txt')); throw new Error('test process failed'); } },
    { name: 'fresh copy', async run(dir) { return { passed: fs.readFileSync(path.join(dir, 'input.txt'), 'utf8') === 'original input', evidence: 'original input preserved' }; } },
  ] });
  assert.deepEqual(result.verification.map(v => v.status), ['failed', 'passed']);
  assert.equal(fs.readFileSync(path.join(result.snapshotPath, 'input.txt'), 'utf8'), 'original input');
});

test('sequential reruns do not inherit previous target edits', async t => {
  const args = setup(t);
  const runtime = adapter(async ({ workDir, mode }) => {
    assert.equal(fs.existsSync(path.join(workDir, 'leftover.txt')), false);
    assert.equal(fs.readFileSync(path.join(workDir, 'input.txt'), 'utf8'), 'original input');
    fs.writeFileSync(path.join(workDir, 'leftover.txt'), mode);
    return completed();
  });
  await executeAgentRun({ ...args, runtime });
  const second = await executeAgentRun({ ...args, runtime, mode: 'without_skill', outputDir: path.join(args.root, 'second') });
  assert.deepEqual(second.changedFiles, ['leftover.txt']);
});

test('pre-aborted runs create no artifacts and timeout outcomes stay distinct', async t => {
  const args = setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeAgentRun({ ...args, runtime: adapter(), signal: controller.signal }), /abort/i);
  assert.equal(fs.existsSync(args.outputDir), false);
  const result = await executeAgentRun({ ...args, runtime: adapter(async () => completed({ status: 'timed_out', error: 'session deadline exceeded' })) });
  assert.equal(result.execution.status, 'timed_out');
});

test('output aliases cannot bypass input overlap checks', async t => {
  const args = setup(t);
  const alias = path.join(args.root, 'alias');
  fs.symlinkSync(args.fixtureDir, alias, 'dir');
  await assert.rejects(executeAgentRun({ ...args, runtime: adapter(), outputDir: path.join(alias, 'out') }), /disjoint/);
  assert.equal(fs.existsSync(path.join(args.fixtureDir, 'out')), false);
});
