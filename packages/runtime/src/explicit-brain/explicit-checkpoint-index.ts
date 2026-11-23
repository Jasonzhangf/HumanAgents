import { ContractError, type EvidenceRef, type OrganId } from '../../../contracts/src/index.js';
import {
  buildExplicitTurnCheckpointIndexDirectory,
  planExplicitCheckpointGroups,
  explicitTurnCheckpointLeafNode,
  readExplicitTurnCheckpointIndex,
  type ExplicitTurnCheckpointIndexDirectory,
  type ExplicitTurnCheckpointIndexNode,
  type ExplicitTurnCheckpointLeaf,
} from './explicit-turn-end.js';
import type { InteractionParentTurnRawJournalPort } from './interaction-parent-turn-raw.js';
import type {
  ExplicitTurnCheckpointIndexJournalPort,
  InteractionSemanticCheckpointJournalPort,
} from './interaction-turn-session.js';

export interface ExplicitTurnCheckpointIndexScope {
  readonly organId: OrganId;
  readonly interactionScopeId: string;
}

/** The standard model seam. It receives ordered child index labels only. */
export interface ExplicitTurnCheckpointIndexLabelPort {
  readonly label: (input: {
    readonly scope: ExplicitTurnCheckpointIndexScope;
    readonly childIndexes: readonly string[];
  }) => Promise<string>;
}

export type ExplicitTurnCheckpointIndexStore = Pick<InteractionSemanticCheckpointJournalPort,
  'readScopeSemanticCheckpoints' | 'readSemanticCheckpointExact'>
  & Pick<ExplicitTurnCheckpointIndexJournalPort, 'appendCheckpointIndex' | 'readScopeCheckpointIndexes'>;

/** Read committed leaves in one organ and interaction scope. Legacy checkpoints without leaf records stay outside this index. */
export async function readExplicitScopeCheckpointLeaves(input: {
  readonly parentJournal: InteractionParentTurnRawJournalPort;
  readonly checkpointJournal: Pick<InteractionSemanticCheckpointJournalPort, 'readScopeSemanticCheckpoints' | 'readSemanticCheckpointExact'>;
  readonly scope: ExplicitTurnCheckpointIndexScope;
}): Promise<readonly ExplicitTurnCheckpointLeaf[]> {
  const leaves: ExplicitTurnCheckpointLeaf[] = [];
  for (const commit of await input.checkpointJournal.readScopeSemanticCheckpoints(input.scope)) {
    leaves.push(...await readExplicitTurnCheckpointIndex({
      journal: input.parentJournal,
      checkpoints: input.checkpointJournal,
      turn: commit.checkpoint,
    }));
  }
  return leaves;
}

/** Build a directory with one standard label call per prospective group. No Journal write happens before all labels return. */
export async function buildExplicitScopeCheckpointIndex(input: {
  readonly leaves: readonly ExplicitTurnCheckpointLeaf[];
  readonly scope: ExplicitTurnCheckpointIndexScope;
  readonly groupSize: number;
  readonly windowLimit: number;
  readonly labelPort: ExplicitTurnCheckpointIndexLabelPort;
  readonly savedLabels?: ReadonlyMap<string, string>;
}): Promise<ExplicitTurnCheckpointIndexDirectory> {
  const { leafNodes, groups, roots } = planExplicitCheckpointGroups(input.leaves, input.groupSize, input.windowLimit);
  const labelsById = new Map(leafNodes.map(node => [node.id, node.label]));
  const nodes = [...leafNodes];
  for (const { id, children } of groups) {
    const childIndexes = children.map(child => labelsById.get(child)!);
    const label = input.savedLabels?.get(id) ?? await input.labelPort.label({ scope: input.scope, childIndexes });
    if (typeof label !== 'string' || !label.trim()) throw new ContractError('checkpoint index model label is empty');
    labelsById.set(id, label);
    nodes.push({ id, children, kind: 'group', label });
  }
  return { roots, nodes };
}

/** Persist the exact model label and ordered membership before a caller may replace its active window. */
export async function buildDurableExplicitScopeCheckpointIndex(input: {
  readonly parentJournal: InteractionParentTurnRawJournalPort;
  readonly indexStore: ExplicitTurnCheckpointIndexStore;
  readonly scope: ExplicitTurnCheckpointIndexScope;
  readonly groupSize: number;
  readonly windowLimit: number;
  readonly labelPort: ExplicitTurnCheckpointIndexLabelPort;
}): Promise<ExplicitTurnCheckpointIndexDirectory> {
  const leaves = await readExplicitScopeCheckpointLeaves({
    parentJournal: input.parentJournal, checkpointJournal: input.indexStore, scope: input.scope,
  });
  const saved = await input.indexStore.readScopeCheckpointIndexes(input.scope);
  const savedLabels = new Map(saved.map(ref => [ref.id, ref.label]));
  const directory = await buildExplicitScopeCheckpointIndex({
    leaves, scope: input.scope, groupSize: input.groupSize,
    windowLimit: input.windowLimit, labelPort: input.labelPort,
    savedLabels,
  });
  const groups = directory.nodes.filter(node => node.kind === 'group');
  const latest = saved.filter(ref => ref.root).at(-1);
  const published = latest?.directoryRoots ?? (latest ? [latest.id] : []);
  if (published.length === directory.roots.length && published.every((id, i) => id === directory.roots[i])) return directory;
  for (const node of groups) {
    const root = node === groups.at(-1);
    if (!root && savedLabels.has(node.id)) continue;
    await input.indexStore.appendCheckpointIndex({
      ...input.scope, id: node.id, kind: 'group', label: node.label,
      children: node.children, root,
      ...(root ? { directoryRoots: directory.roots, revision: (latest?.revision ?? 0) + 1 } : {}),
    });
  }
  return directory;
}

/** Read the newest complete persisted directory. Incomplete trees stay unreadable while leaves remain separately readable. */
export async function readDurableExplicitScopeCheckpointIndex(input: {
  readonly parentJournal: InteractionParentTurnRawJournalPort;
  readonly indexStore: ExplicitTurnCheckpointIndexStore;
  readonly scope: ExplicitTurnCheckpointIndexScope;
  readonly windowLimit?: number;
}): Promise<ExplicitTurnCheckpointIndexDirectory> {
  const leaves = await readExplicitScopeCheckpointLeaves({
    parentJournal: input.parentJournal, checkpointJournal: input.indexStore, scope: input.scope,
  });
  const leafNodes = leaves.map(explicitTurnCheckpointLeafNode);
  if (input.windowLimit !== undefined && leaves.length <= input.windowLimit) {
    return buildExplicitTurnCheckpointIndexDirectory({ leaves, groupSize: 2, windowLimit: input.windowLimit, labels: [] });
  }
  const refs = await input.indexStore.readScopeCheckpointIndexes(input.scope);
  if (refs.length === 0) {
    if (leaves.length <= (input.windowLimit ?? 1)) {
      return buildExplicitTurnCheckpointIndexDirectory({ leaves, groupSize: 2, windowLimit: input.windowLimit ?? 1, labels: [] });
    }
    throw new ContractError('checkpoint index has no complete directory for the committed leaves');
  }

  const refsById = new Map(refs.map(ref => [ref.id, ref]));
  const knownLeafIds = new Set(leafNodes.map(node => node.id));
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const candidate = refs[index]!;
    if (!candidate.root) continue;
    const groupNodes: ExplicitTurnCheckpointIndexNode[] = [];
    const visiting = new Set<string>();
    const usedLeaves = new Set<string>();
    const collect = (id: string): void => {
      if (knownLeafIds.has(id)) {
        if (usedLeaves.has(id)) throw new ContractError('checkpoint index uses a leaf more than once');
        usedLeaves.add(id);
        return;
      }
      const ref = refsById.get(id);
      if (!ref) throw new ContractError(`checkpoint index group is missing: ${id}`);
      if (visiting.has(id)) throw new ContractError('checkpoint index contains a cycle');
      visiting.add(id);
      groupNodes.push({ id: ref.id, kind: 'group', label: ref.label, children: ref.children });
      for (const child of ref.children) collect(child);
      visiting.delete(id);
    };
    try {
      for (const root of candidate.directoryRoots ?? [candidate.id]) collect(root);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      continue;
    }
    if (usedLeaves.size > 0) {
      const uncovered = leafNodes.filter(node => !usedLeaves.has(node.id)).map(node => node.id);
      return { roots: [...(candidate.directoryRoots ?? [candidate.id]), ...uncovered], nodes: [...leafNodes, ...groupNodes] };
    }
  }
  throw new ContractError('checkpoint index has no complete directory for the committed leaves');
}

/** Read the immutable evidence cited by one leaf. The caller supplies the existing evidence store port. */
export async function readExplicitTurnCheckpointLeafEvidence(input: {
  readonly leaf: ExplicitTurnCheckpointLeaf;
  readonly readEvidence: (ref: EvidenceRef) => Promise<Uint8Array>;
}): Promise<readonly { readonly ref: EvidenceRef; readonly content: Uint8Array }[]> {
  const refs = [...input.leaf.evidenceRefs, ...input.leaf.semanticAssetRefs];
  const seen = new Set<string>();
  const output: { readonly ref: EvidenceRef; readonly content: Uint8Array }[] = [];
  for (const ref of refs) {
    const key = `${ref.evidenceId.scope}:${ref.evidenceId.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ref, content: await input.readEvidence(ref) });
  }
  return output;
}
