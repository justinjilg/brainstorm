export class BrainstormError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BrainstormError';
  }
}

export class ConfigError extends BrainstormError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class ProviderError extends BrainstormError {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'ProviderError';
  }
}

export class RoutingError extends BrainstormError {
  constructor(message: string) {
    super(message, 'ROUTING_ERROR');
    this.name = 'RoutingError';
  }
}

export class BudgetExceededError extends BrainstormError {
  constructor(
    public readonly limit: string,
    public readonly used: number,
    public readonly max: number,
  ) {
    super(`Budget exceeded: ${limit} — used $${used.toFixed(4)} of $${max.toFixed(2)}`, 'BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}

export class ToolPermissionDenied extends BrainstormError {
  constructor(public readonly toolName: string) {
    super(`Permission denied for tool: ${toolName}`, 'TOOL_PERMISSION_DENIED');
    this.name = 'ToolPermissionDenied';
  }
}
