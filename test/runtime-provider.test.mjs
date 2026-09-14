import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeProvider } from '../dist/runtime-provider.js';
import { runProcess } from '../dist/runtime-process.js';

const fake = fileURLToPath(new URL('./fixtures/runtime-fake-cli.mjs', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'skill');
  fs.mkdirSync(path.join(dir, 'evals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\nKeep frontmatter');
  fs.writeFileSync(path.join(dir, 'input.txt'), 'same fixture');
  fs.writeFileSync(path.join(dir, 'evals', 'evals.json'), 'secret rubric');
  return { root, skill: { name: 'demo', dir, skillMd: 'Keep frontmatter', references: [], scripts: [], evals: [] } };
}
for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: native staging, identical fixtures, stdin, and preserved artifacts`, async t => {
    const { root, skill } = setup(t);
    const provider = new RuntimeProvider({ runtime, executable: process.execPath, executableArgs: [fake] });
    const prompt = 'quotes " \' $() `danger` & | 中文';
    for (const mode of ['with_skill', 'without_skill']) {
      const result = await provider.runAgent({ skill, eval: { prompt, files: ['input.txt'], captured_files: ['output.txt'] }, mode, runDir: path.join(root, mode) });
      assert.equal(result.error, undefined);
      const body = JSON.parse(result.output);
      assert.equal(body.prompt, prompt);
      assert.equal(body.fixture, 'same fixture');
      assert.equal(body.evalsExposed, false);
      assert.equal(body.skill?.startsWith('---') ?? false, mode === 'with_skill');
      assert.ok(!body.cwd.startsWith(skill.dir));
      assert.ok(!body.args.includes(prompt));
      assert.ok(!body.args.some(x => x.includes('dangerously')));
      assert.equal(body.args[body.args.indexOf(runtime === 'codex' ? '--sandbox' : '--permission-mode') + 1], runtime === 'codex' ? 'read-only' : 'dontAsk');
      assert.deepEqual(result.execution.changedFiles, ['input.txt', 'output.txt']);
      assert.equal(result.execution.outputFiles[0].content, 'verified result');
      assert.equal(fs.readFileSync(path.join(result.execution.workDir, 'output.txt'), 'utf8'), 'verified result');
    }
    assert.equal(fs.readFileSync(path.join(skill.dir, 'input.txt'), 'utf8'), 'same fixture');
  });
  test(`${runtime}: judge isolated, schemas and explicit writes supported`, async t => {
    const { root, skill } = setup(t);
    const provider = new RuntimeProvider({ runtime, executable: process.execPath, executableArgs: [fake], allowWrites: true, allowedTools: ['Read', 'Edit'] });
    const judged = await provider.completeChat({ system: 'Judge only', user: 'hello', outputSchema: { type: 'object' } });
    const body = JSON.parse(judged.output);
    assert.equal(body.skill, null);
    assert.ok(body.args.includes(runtime === 'codex' ? '--output-schema' : '--json-schema'));
    if (runtime === 'claude') assert.equal(body.args[body.args.indexOf('--tools') + 1], '');
    const result = await provider.runAgent({ skill, eval: { prompt: 'hello' }, mode: 'without_skill', runDir: path.join(root, 'write') });
    const args = JSON.parse(result.output).args;
    assert.ok(args.includes(runtime === 'codex' ? 'workspace-write' : 'acceptEdits'));
  });
}
test('subprocess preserves failures, partial timeouts, and bounds output', async () => {
  const base = { command: process.execPath, cwd: os.tmpdir(), stdin: 'hello' };
  const failure = await runProcess({ ...base, args: [fake, 'fail'] });
  assert.equal(failure.exitCode, 7);
  assert.match(failure.stderr, /fake failure/);
  const timeout = await runProcess({ ...base, args: [fake, 'hang'], timeoutMs: 500 });
  assert.match(timeout.error, /timed out/i);
  assert.match(timeout.stdout, /partial output/);
  const overflow = await runProcess({ ...base, args: [fake, 'overflow'], maxOutputBytes: 1024 });
  assert.match(overflow.error, /output limit/i);
  assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);
});

test('verification runs in workspace and its generated files are captured', async t => {
  const { root, skill } = setup(t);
  const provider = new RuntimeProvider({ runtime: 'codex', executable: process.execPath, executableArgs: [fake] });
  const result = await provider.runAgent({ skill, mode: 'without_skill', runDir: path.join(root, 'verify'), eval: {
    prompt: 'hello', captured_files: ['checked.txt'], verification: [
      { name: 'build', command: process.execPath, args: ['-e', 'require("fs").writeFileSync("checked.txt", "built"); console.log("build passed")'] },
      { name: 'failing check', command: process.execPath, args: ['-e', 'console.error("broken"); process.exit(2)'] },
    ],
  } });
  assert.equal(result.execution.verification[0].passed, true);
  assert.equal(result.execution.verification[1].passed, false);
  assert.match(result.execution.verification[1].stderr, /broken/);
  assert.equal(result.execution.outputFiles[0].content, 'built');
});

test('nonzero CLI exit retains output, stderr, and captured artifacts', async t => {
  const { root, skill } = setup(t);
  const provider = new RuntimeProvider({ runtime: 'codex', executable: process.execPath, executableArgs: [fake, 'fail'] });
  const result = await provider.runAgent({ skill, mode: 'without_skill', runDir: path.join(root, 'failed'), eval: { prompt: 'hello', files: ['input.txt'], captured_files: ['output.txt'] } });
  assert.match(result.error, /code 7/);
  assert.equal(result.execution.exitCode, 7);
  assert.match(result.execution.stderr, /fake failure/);
  assert.equal(result.execution.outputFiles[0].content, 'verified result');
  assert.equal(JSON.parse(result.output).prompt, 'hello');
});

test('change tracking includes agent commits and installed skill modifications', async t => {
  const { root, skill } = setup(t);
  const provider = new RuntimeProvider({ runtime: 'codex', executable: process.execPath, executableArgs: [fake] });
  const code = `const fs = require('fs'); const cp = require('child_process'); fs.appendFileSync('.agents/skills/demo/SKILL.md', '\\nmodified'); cp.execFileSync('git', ['add', '--all']); cp.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Agent commit']);`;
  const result = await provider.runAgent({ skill, mode: 'with_skill', runDir: path.join(root, 'committed'), eval: { prompt: 'hello', verification: [{ name: 'commit', command: process.execPath, args: ['-e', code] }] } });
  assert.equal(result.execution.verification[0].passed, true);
  assert.deepEqual(result.execution.changedFiles, ['.agents/skills/demo/SKILL.md']);
});

test('unsafe and missing fixture paths fail before invoking CLI', async t => {
  const { root, skill } = setup(t);
  const provider = new RuntimeProvider({ runtime: 'codex', executable: process.execPath, executableArgs: [fake] });
  for (const file of ['../escape.txt', '.agents/skills/other/SKILL.md', 'missing.txt']) {
    await assert.rejects(provider.runAgent({ skill, mode: 'without_skill', runDir: path.join(root, 'unsafe'), eval: { prompt: 'hello', files: [file] } }), /fixture/i);
  }
});

test('reruns preserve previous artifacts without leaking stale files into new grading', async t => {
  const { root, skill } = setup(t);
  const provider = new RuntimeProvider({ runtime: 'codex', executable: process.execPath, executableArgs: [fake] });
  const runDir = path.join(root, 'rerun');
  const first = await provider.runAgent({ skill, mode: 'without_skill', runDir, eval: { prompt: 'hello', files: ['input.txt'] } });
  const second = await provider.runAgent({ skill, mode: 'without_skill', runDir, eval: { prompt: 'hello' } });
  assert.notEqual(first.execution.workDir, second.execution.workDir);
  assert.equal(fs.existsSync(path.join(first.execution.workDir, 'output.txt')), true);
  assert.equal(fs.existsSync(path.join(second.execution.workDir, 'output.txt')), false);
});

test('server smoke check polls HTTP and stops its process', async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const result = await runProcess({ command: process.execPath, args: ['-e', `require('http').createServer((q,s)=>s.end('ok')).listen(${port}, '127.0.0.1')`], cwd: os.tmpdir(), readyUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
});

test('Windows npm native and Node shims resolve without invoking cmd.exe', { skip: process.platform !== 'win32' }, async t => {
  const { resolveExecutable } = await import('../dist/runtime-process.js');
  const { root } = setup(t);
  const nodeEntry = path.join(root, 'node_modules', 'fake', 'cli.js');
  fs.mkdirSync(path.dirname(nodeEntry), { recursive: true });
  fs.writeFileSync(nodeEntry, '');
  fs.writeFileSync(path.join(root, 'shim.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\fake\\cli.js" %*\r\n');
  assert.deepEqual(resolveExecutable(path.join(root, 'shim.cmd')), { command: process.execPath, args: [nodeEntry] });
});
