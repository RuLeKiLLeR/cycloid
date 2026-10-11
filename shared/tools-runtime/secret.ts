import type { ToolExecutionEnv } from "./methods.js";

export class MissingToolSecretError extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`required tool secret '${secretName}' is not set`);
    this.name = "MissingToolSecretError";
    this.secretName = secretName;
  }
}

export function secret(name: string, env: ToolExecutionEnv): string {
  const value = env[name];
  if (!value) throw new MissingToolSecretError(name);
  return value;
}
