// Serves test/fixture over HTTP so Firefox grants <all_urls> for the fixture.
import { join } from 'node:path';

const root = join(import.meta.dir, '.');
const port = Number(process.env.FIXTURE_PORT || 8787);

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(root, path === '/' ? 'index.html' : path));
    return file.size ? new Response(file) : new Response('not found', { status: 404 });
  },
});

console.log(`fixture: http://127.0.0.1:${port}/`);
