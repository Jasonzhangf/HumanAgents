export class JournalIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JournalIntegrityError';
  }
}
