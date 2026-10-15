/**
 * Presentation-only grouping for scoped public task rows.
 *
 * The helper reads the committed TaskFlow binding that the public row already
 * carries on `row.task.taskFlow`. It does not classify, validate or execute
 * anything, and it never infers a type from title, trigger, schedule,
 * frequency, timestamps, role or lifecycle. The supported kinds and their
 * definitions stay owned by contracts/Core. The table below only fixes the
 * display order and the product labels.
 *
 * Input rows are the existing scoped wrapper
 * `{ scope: { kind: 'task', projectKey, mode, taskId }, task, basis }`.
 *
 * `groupTaskFlowRows(rows, { lifecycle })` returns:
 *   { sections: [{ kind, label, rows }], unclassified: { kind, label, rows } }
 * The three type sections always exist, in presentation order, and keep the
 * original wrapper references. Rows without a binding or with an unsupported
 * kind stay visible in `unclassified`; they are never defaulted into a type
 * section. `lifecycle` is an optional state filter applied inside every
 * section. It may hide nonmatching rows, but it does not change the section
 * structure and does not mutate or discard the input rows.
 *
 * `unclassifiedTaskFlowReason(row)` returns `'missing'` or `'unsupported'`
 * for an unclassified row, or `null` for a row that carries a supported kind.
 */

// Presentation table only. The kind strings mirror the public contract shape,
// and the consumer test binds this order to the actual TASK_FLOW_KINDS.
export const TASK_FLOW_GROUPS = Object.freeze([
  Object.freeze({ kind: 'one-shot', label: '单次' }),
  Object.freeze({ kind: 'inspection', label: '巡检' }),
  Object.freeze({ kind: 'long-running', label: '长程' }),
]);

export const UNCLASSIFIED_KIND = 'unclassified';
export const UNCLASSIFIED_LABEL = '未分类';
export const UNCLASSIFIED_REASON_LABELS = Object.freeze({
  missing: '未声明',
  unsupported: '暂不支持',
});

function taskFlowKind(row) {
  return row?.task?.taskFlow?.kind;
}

export function unclassifiedTaskFlowReason(row) {
  const kind = taskFlowKind(row);
  if (kind === undefined || kind === null) return 'missing';
  return TASK_FLOW_GROUPS.some((group) => group.kind === kind) ? null : 'unsupported';
}

export function groupTaskFlowRows(rows, { lifecycle } = {}) {
  const sections = TASK_FLOW_GROUPS.map(({ kind, label }) => ({ kind, label, rows: [] }));
  const sectionByKind = new Map(sections.map((section) => [section.kind, section]));
  const unclassified = { kind: UNCLASSIFIED_KIND, label: UNCLASSIFIED_LABEL, rows: [] };

  for (const row of rows ?? []) {
    const section = sectionByKind.get(taskFlowKind(row));
    (section ?? unclassified).rows.push(row);
  }

  if (lifecycle !== undefined && lifecycle !== null) {
    for (const section of [...sections, unclassified]) {
      section.rows = section.rows.filter((row) => row?.task?.state === lifecycle);
    }
  }

  return { sections, unclassified };
}
