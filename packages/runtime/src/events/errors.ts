export class EventBusError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EventBusError';
  }
}

export class EventPublisherError extends EventBusError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EventPublisherError';
  }
}

export class EventConsumerError extends EventBusError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EventConsumerError';
  }
}
