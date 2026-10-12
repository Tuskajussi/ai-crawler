import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile: 'dist-server/index.js' });
// The PDF parser runs in its own bounded worker, including in the compiled server.
await copyFile('server/knowledge-pdf-worker.cjs', 'dist-server/knowledge-pdf-worker.cjs');
