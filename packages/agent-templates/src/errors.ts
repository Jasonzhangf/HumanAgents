export class AgentTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTemplateError';
  }
}
