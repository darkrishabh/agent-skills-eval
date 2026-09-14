import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkill, runEval, evaluateSkills, normalizeConfig, createStaticProvider } from '../dist/index.js';

function fixture(t, evalCase = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-integration-'));
  const dir = path.join(root, 'sample');
  mkdirSync(path.join(dir, 'evals'), { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: sample\ndescription: Test skill\n---\nSecret instructions.');
  writeFileSync(path.join(dir, 'data.csv'), 'Jan,12');
  writeFileSync(path.join(dir, 'evals/evals.json'), JSON.stringify({evals:[{id:'one',prompt:'Analyze data.csv',files:['data.csv'],...evalCase}]}));
  return {root,dir,skill:loadSkill(dir)};
}

test('baseline receives identical input files and only removes skill context', async t => {
  const {root,skill}=fixture(t);
  const prompts=[];
  const provider={...createStaticProvider('ok'),async complete(prompt){ prompts.push(prompt); return createStaticProvider('ok').complete(prompt); }};
  await runEval({skill,eval:skill.evals[0],modes:['with_skill','without_skill'],target:{model:'static',provider},judge:{model:'static',provider},workspace:path.join(root,'out'),iteration:1});
  assert.match(prompts[0],/Jan,12/);
  assert.match(prompts[1],/Jan,12/);
  assert.doesNotMatch(prompts[1],/Secret instructions/);
});

test('provider errors fail an otherwise empty eval instead of passing', async t => {
  const {root,skill}=fixture(t);
  const p=createStaticProvider('',{error:'credentials expired'});
  const result=await runEval({skill,eval:skill.evals[0],modes:['with_skill'],target:{model:'static',provider:p},workspace:path.join(root,'out'),iteration:1});
  assert.ok(result.modes.with_skill.grading.summary.failed>0);
});

test('runtime config validates options and preserves deterministic-only judging', () => {
  const config=normalizeConfig({runtime:'claude',judgeRuntime:'none',runtimeOptions:{allowWrites:true,timeoutMs:1200,allowedTools:['Read']}});
  assert.equal(config.runtime,'claude');
  assert.equal(config.judgeRuntime,'none');
  assert.equal(config.runtimeOptions.timeoutMs,1200);
  assert.throws(()=>normalizeConfig({runtime:'typo'}),/runtime/);
  assert.throws(()=>normalizeConfig({runtimeOptions:{timeoutMs:0}}),/timeoutMs/);
});

test('runtime eval schema validates checks instead of silently dropping them', t => {
  const {skill}=fixture(t,{should_trigger:false,runtime_checks:{maxCommands:2,requiredFiles:['report.txt']},verification:[{name:'build',command:'node',args:['--version']}],captured_files:['report.txt']});
  assert.equal(skill.evals[0].should_trigger,false);
  assert.deepEqual(skill.evals[0].runtime_checks.requiredFiles,['report.txt']);
  assert.throws(()=>fixture(t,{runtime_checks:{maxCommands:-1}}),/maxCommands/);
  assert.throws(()=>fixture(t,{runtime_checks:{unknown:true}}),/unknown/);
  assert.throws(()=>fixture(t,{captured_files:['../secret']}),/path|relative/);
});

test('provider mode rejects native runtime checks before any model call', async t => {
  const {root}=fixture(t,{should_trigger:true});
  let calls=0;
  const provider={...createStaticProvider('ok'),async complete(){calls++;return createStaticProvider('ok').complete('');}};
  await assert.rejects(evaluateSkills({root,workspace:path.join(root,'out'),target:{model:'mock',provider},report:false,onEvent:()=>{}}),/runtime/);
  assert.equal(calls,0);
});

test('empty discovered suite and duplicate eval slugs fail before artifacts overwrite', async t => {
  const {root,dir}=fixture(t);
  const provider=createStaticProvider('ok');
  writeFileSync(path.join(dir,'evals/evals.json'),JSON.stringify({evals:[{id:'a',name:'same',prompt:'a'},{id:'b',name:'same',prompt:'b'}]}));
  await assert.rejects(evaluateSkills({root,workspace:path.join(root,'out'),target:{model:'mock',provider},report:false,onEvent:()=>{}}),/duplicate|collision/i);
  await assert.rejects(evaluateSkills({root:path.join(root,'empty'),workspace:path.join(root,'out'),target:{model:'mock',provider},report:false,onEvent:()=>{}}),/No .*eval/i);
});
