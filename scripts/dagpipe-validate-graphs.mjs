import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphDir = join(projectRoot, 'docs', 'dagpipe');
const graphs = readdirSync(graphDir)
  .filter((file) => file.endsWith('.graph.json'))
  .sort();

if (graphs.length === 0) {
  throw new Error(`no *.graph.json files found under ${graphDir}`);
}

for (const file of graphs) {
  execFileSync('dagpipe', ['graph', 'validate', join(graphDir, file)], { stdio: 'inherit' });
}

console.log(`validated ${graphs.length} DAGpipe graph(s)`);
