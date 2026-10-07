/**
 * Context Events —— 唯一公开导出面（§5 / §13 阶段 2，Lead 所有）。
 *
 * 本模块是「发生事件」的共享事实层：UI 叙述、Memory 摘要与 Context Compaction
 * 都从同一批 canonical 事件派生，不各自解读原始流水账。
 *
 * 依赖上限（硬约束）：本包只允许 import packages/contracts。
 * packages/ui 只依赖 contracts，一旦本包引入 packages/runtime，UI 将无法消费。
 *
 * 消费顺序（唯一合法顺序）：`normalize*` / `createContextEvent` → `applyPairingOutcome`
 * → `toUserNarrative` / `toMemoryDigest` / `compactContextEvents`。
 * 投影与 compact 只读 `event.status` 与 `event.pairing`，不 import `pairing.ts`。
 */

export * from './errors.js';
export * from './types.js';
export * from './taxonomy.js';
export * from './validation.js';
export * from './normalize.js';
export * from './pairing.js';
export * from './projector.js';
export * from './compact.js';
