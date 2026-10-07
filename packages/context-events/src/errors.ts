/**
 * Context Events —— 唯一错误类型（阶段 0）。
 *
 * 设计契约：docs/architecture/context-events.md §5 / §11 / §14。
 * 本模块所有校验失败与非法输入都抛此错误，不静默失败、不降级。
 */

export class ContextEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextEventError';
  }
}
