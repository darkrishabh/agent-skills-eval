import fs from 'node:fs';
import path from 'node:path';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
if (args.includes('hang')) {
  process.stdout.write('partial output\n');
  setInterval(() => {}, 1000);
} else if (args.includes('overflow')) {
  process.stdout.write('x'.repeat(100000));
} else {
  const runtime = args.includes('exec') ? 'codex' : 'claude';
  const root = runtime === 'codex' ? '.agents' : '.claude';
  const skill = path.join(root, 'skills', 'demo', 'SKILL.md');
  const result = { args, prompt, cwd: process.cwd(), skill: fs.existsSync(skill) ? fs.readFileSync(skill, 'utf8') : null,
    fixture: fs.existsSync('input.txt') ? fs.readFileSync('input.txt', 'utf8') : null,
    evalsExposed: fs.existsSync(path.join(root, 'skills', 'demo', 'evals')) };
  if (fs.existsSync('input.txt')) {
    fs.writeFileSync('output.txt', 'verified result');
    fs.appendFileSync('input.txt', '\nchanged');
  }
  if (runtime === 'codex') {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }));
  } else {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 20 } }));
  }
  if (args.includes('fail')) { process.stderr.write('fake failure'); process.exitCode = 7; }
}
