export class RuntimeError extends Error {
  code: string;
  constructor(message: string, code: string = 'WALLET_ERROR') { super(message); this.name = 'RuntimeError'; this.code = code; }
}
export function requireCondition(condition: unknown, message: string, code = 'INVALID_PARAMS'): asserts condition {
  if (!condition) throw new RuntimeError(message, code);
}
