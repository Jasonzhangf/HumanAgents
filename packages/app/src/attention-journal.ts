import { join } from 'node:path';
import { JsonlOrganJournal } from '../../adapters/jsonl/src/index.js';
import type { Attention } from '../../contracts/src/index.js';
import type { AttentionPort, AttentionReceipt } from '../../runtime/src/index.js';
import type { RuntimePaths } from '../../config/src/index.js';
import { AppLifecycleError } from './errors.js';

/**
 * Durable Attention journal.
 *
 * Attention is HumanAgent control state, so it is appended to the authoritative
 * Organ Journal chain rather than mirrored into task payloads or DSH logs. The
 * port is deliberately small: publish/resolve append one event each and return
 * an acknowledgement bound to the attention id.
 */
export function createJsonlAttentionPort(input: {
  readonly paths: RuntimePaths;
  readonly filePath?: string;
}): AttentionPort {
  const filePath = input.filePath ?? join(input.paths.journalRoot, 'attention.jsonl');
  const journal = new JsonlOrganJournal(filePath);
  let queue: Promise<unknown> = Promise.resolve();

  function append(attention: Attention): Promise<AttentionReceipt> {
    const operation = queue.then(async () => {
      await journal.append({
        kind: 'event',
        scope: attention.scope,
        payload: { kind: 'attention', attention: structuredClone(attention) as unknown as Record<string, unknown> },
      });
      return { attentionId: attention.attentionId, delivered: true as const };
    });
    queue = operation.catch(() => undefined);
    return operation;
  }

  return {
    publish(attention) {
      return append(attention);
    },
    resolve(attention) {
      if (attention.state !== 'resolved') {
        throw new AppLifecycleError(
          'attention-resolution-invalid',
          'attention resolution requires resolved state',
          'publish a resolved attention through the stop control owner',
          'app-attention-journal',
        );
      }
      return append(attention);
    },
  };
}
