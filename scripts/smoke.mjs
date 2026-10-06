import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'humanagent-smoke-'));
const workspace = join(root, 'workspace');
const controlRoot = join(root, 'control');
await mkdir(workspace);
await mkdir(controlRoot);
const canonicalControlRoot = await realpath(controlRoot);
const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
const env = { ...process.env, HUMANAGENT_HOME: controlRoot };
const doctor = execFileSync(process.execPath, [cli, 'doctor', '--workspace', workspace, '--control-root', controlRoot], { encoding: 'utf8', env });
const run = execFileSync(process.execPath, [cli, 'run', '--workspace', workspace, '--control-root', controlRoot, '--plan', 'default', '--session', 'smoke-1', '--prompt', 'smoke'], { encoding: 'utf8', env });
let resume = '';
try {
  resume = execFileSync(process.execPath, [cli, 'resume', '--workspace', workspace, '--control-root', controlRoot, '--session', 'smoke-1', '--prompt', 'resume smoke', '--json'], { encoding: 'utf8', env });
} catch (error) {
  resume = error.stderr;
}
const sessionList = execFileSync(process.execPath, [cli, 'session', 'list', '--workspace', workspace, '--control-root', controlRoot], { encoding: 'utf8', env });
const sessionInspect = execFileSync(process.execPath, [cli, 'session', 'inspect', '--workspace', workspace, '--control-root', controlRoot, '--session', 'smoke-1'], { encoding: 'utf8', env });
const parsedDoctor = JSON.parse(doctor);
const parsedRun = JSON.parse(run);
const parsedResume = JSON.parse(resume);
const parsedList = JSON.parse(sessionList);
const parsedInspect = JSON.parse(sessionInspect);
if (parsedDoctor.controlRoot !== canonicalControlRoot || parsedDoctor.agentCwd !== canonicalControlRoot) throw new Error('smoke: explicit agent cwd escaped control root');
if (parsedRun.state !== 'stopped' || parsedInspect.state !== 'stopped' || parsedList[0]?.sessionId !== 'smoke-1') throw new Error('smoke: terminal session was not persisted and inspectable');
if (parsedResume.error?.code !== 'session-terminal' || parsedResume.error?.ownerId !== 'session-store' || typeof parsedResume.error?.nextAction !== 'string') throw new Error('smoke: terminal resume did not return structured lifecycle evidence');
console.log(JSON.stringify({ doctor: parsedDoctor, run: parsedRun, resumeError: parsedResume.error, sessionList: parsedList, sessionInspect: { sessionId: parsedInspect.sessionId, state: parsedInspect.state, recoverableTail: parsedInspect.recoverableTail } }, null, 2));
