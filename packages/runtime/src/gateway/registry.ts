import {
  scopePatternMatches,
  validateOperationIntentForRegistration,
  validateToolRegistration,
  type OperationIntent,
  type Scope,
  type ToolRegistration,
} from '../../../contracts/src/index.js';
import { GatewayError } from './errors.js';

export interface ResolvedToolRegistration {
  readonly registration: ToolRegistration;
  readonly registrationLimit: Scope;
}

function scopeFromPattern(registration: ToolRegistration, intent: OperationIntent): Scope {
  const pattern = registration.acceptedScopes.find((candidate) => scopePatternMatches(candidate, intent.requestedScope));
  if (!pattern) {
    throw new GatewayError(
      'route-not-found',
      `operation requested scope is outside registration limits for tool ${registration.toolName}`,
    );
  }
  return {
    organId: pattern.organId ?? intent.requestedScope.organId,
    ...(pattern.taskId ?? intent.requestedScope.taskId
      ? { taskId: pattern.taskId ?? intent.requestedScope.taskId }
      : {}),
    ...(pattern.cycleId ?? intent.requestedScope.cycleId
      ? { cycleId: pattern.cycleId ?? intent.requestedScope.cycleId }
      : {}),
    ...(pattern.operationId ?? intent.requestedScope.operationId
      ? { operationId: pattern.operationId ?? intent.requestedScope.operationId }
      : {}),
  };
}

function assertRegistration(registration: ToolRegistration): void {
  try {
    validateToolRegistration(registration);
  } catch (error) {
    throw new GatewayError(
      'invalid-registration',
      error instanceof Error ? error.message : 'tool registration is invalid',
      { ownerRef: registration.owner, cause: error },
    );
  }
}

export class ToolRegistry {
  private readonly registrations = new Map<string, ToolRegistration>();
  private readonly routes = new Map<string, string>();

  load(registrations: readonly ToolRegistration[]): void {
    const nextRegistrations = new Map<string, ToolRegistration>();
    const nextRoutes = new Map<string, string>();
    for (const registration of registrations) {
      assertRegistration(registration);
      if (nextRegistrations.has(registration.toolName)) {
        throw new GatewayError(
          'invalid-registration',
          `duplicate tool registration: ${registration.toolName}`,
          { ownerRef: registration.owner },
        );
      }
      if (nextRoutes.has(registration.routeId)) {
        throw new GatewayError(
          'invalid-registration',
          `duplicate route registration: ${registration.routeId}`,
          { ownerRef: registration.owner },
        );
      }
      nextRegistrations.set(registration.toolName, registration);
      nextRoutes.set(registration.routeId, registration.toolName);
    }

    this.registrations.clear();
    this.routes.clear();
    for (const [toolName, registration] of nextRegistrations) {
      this.registrations.set(toolName, registration);
    }
    for (const [routeId, toolName] of nextRoutes) {
      this.routes.set(routeId, toolName);
    }
  }

  register(registration: ToolRegistration): void {
    assertRegistration(registration);
    if (this.registrations.has(registration.toolName)) {
      throw new GatewayError(
        'invalid-registration',
        `duplicate tool registration: ${registration.toolName}`,
        { ownerRef: registration.owner },
      );
    }
    if (this.routes.has(registration.routeId)) {
      throw new GatewayError(
        'invalid-registration',
        `duplicate route registration: ${registration.routeId}`,
        { ownerRef: registration.owner },
      );
    }
    this.registrations.set(registration.toolName, registration);
    this.routes.set(registration.routeId, registration.toolName);
  }

  get(toolName: string): ToolRegistration | undefined {
    return this.registrations.get(toolName);
  }

  list(): readonly ToolRegistration[] {
    return [...this.registrations.values()];
  }

  resolve(intent: OperationIntent): ResolvedToolRegistration {
    const registration = this.registrations.get(intent.toolName);
    if (!registration) {
      throw new GatewayError(
        'route-not-found',
        `no registered route for tool ${intent.toolName}`,
        { ownerRef: 'tool-registry' },
      );
    }
    try {
      validateOperationIntentForRegistration(intent, registration);
    } catch (error) {
      throw new GatewayError(
        'route-not-found',
        error instanceof Error ? error.message : 'operation does not match the registered route',
        { ownerRef: registration.owner, cause: error },
      );
    }
    return {
      registration,
      registrationLimit: scopeFromPattern(registration, intent),
    };
  }
}
