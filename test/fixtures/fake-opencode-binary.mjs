// Fake `opencode` CLI used to test OpencodeProvider's real spawn path
// (`spawnOpencodeServer`) without a real opencode install. Reuses the fake
// HTTP server fixture for request handling, then — after printing the
// "listening" line the real CLI prints — writes a bit more to stdout/stderr,
// mimicking the post-startup log chatter (tool calls, crashes, etc.) a real
// `opencode serve` process would produce during a session.
import { createFakeOpencodeServer } from "./fake-opencode-server.mjs";

const server = await createFakeOpencodeServer();
process.stdout.write(`opencode server listening on ${server.url}\n`);

setTimeout(() => {
  process.stdout.write("post-startup stdout line\n");
  process.stderr.write("post-startup stderr line\n");
}, 50);
