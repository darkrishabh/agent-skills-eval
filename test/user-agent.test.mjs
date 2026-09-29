import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { OpenAICompatibleProvider } from '../dist/openai-compatible-provider.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('HTTP requests identify the installed package, including retries and explicit overrides', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    req.resume();
    requests.push(req.headers);
    if (requests.length === 1) {
      res.writeHead(503);
      res.end('retry');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'test-key', retry: { attempts: 2, backoffMs: 0 },
  };
  assert.equal((await new OpenAICompatibleProvider(options).complete('hello')).output, 'ok');
  const expected = `agent-skills-eval/${version} (+https://github.com/darkrishabh/agent-skills-eval; node/${process.versions.node})`;
  assert.equal(requests[0]['user-agent'], expected);
  assert.equal(requests[1]['user-agent'], expected);
  assert.equal(requests[1].authorization, 'Bearer test-key');
  for (const name of ['User-Agent', 'user-agent', 'USER-AGENT']) {
    const result = await new OpenAICompatibleProvider({ ...options, extraHeaders: { [name]: 'custom-eval-client' } }).complete('hello');
    assert.equal(result.output, 'ok');
    assert.equal(requests.at(-1)['user-agent'], 'custom-eval-client');
  }
});
