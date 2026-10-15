import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import { createJsonlNativeSaveProgressPort } from '../../../packages/adapters/jsonl/src/native-save-progress.js';
import type { NativeSaveKey } from '../../../packages/runtime/src/checkpoints/native-save-contract.js';

const journal = new JsonlOrganJournal(process.argv[2]);
const port = createJsonlNativeSaveProgressPort({ journal });
const keys: NativeSaveKey[] = JSON.parse(process.argv[3]);
const readbacks = await Promise.all(keys.map((key) => port.readExact(key)));
const verification = await journal.verify();
console.log(JSON.stringify({ readbacks, verification }));
