import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runStages } from './checkpoint-runner.mjs';
import { checkpointStages } from './checkpoint-stages.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const projectRoot = resolve(option(process.argv.slice(2), '--project-root', process.cwd()));
const controlRoot = process.env.HUMANAGENT_HOME || join(homedir(), '.humanagent');
const result = await runStages({
  projectRoot,
  checkpointRoot: join(controlRoot, 'build', 'checkpoints', 'ci'),
  lockRoot: join(controlRoot, 'build', 'locks'),
  stages: checkpointStages(),
});
console.log(JSON.stringify(result, null, 2));
if (result.overall !== 'pass') process.exitCode = 1;
