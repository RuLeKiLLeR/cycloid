export type SecretParameter = {
  Name: string;
  Value: string;
  Version?: number;
  LastModifiedDate?: string;
};

export type SecretFingerprint = {
  version: number | null;
  lastModifiedDate: string | null;
};

export declare function reconcileControlPlaneSecrets(input: {
  environment: "production" | "qa";
  workerName: string;
  ssmParameters: SecretParameter[];
  generatedSecrets: Record<string, string>;
  fingerprints: Record<string, SecretFingerprint> | null;
  providerNames: Array<string | Record<string, unknown>>;
}): {
  environment: "production" | "qa";
  workerName: string;
  changedKeys: string[];
  changedSecrets: Record<string, string>;
  removedKeys: string[];
  fingerprints: Record<string, SecretFingerprint>;
  secretsChangedCount: number;
  fullSync: boolean;
};
