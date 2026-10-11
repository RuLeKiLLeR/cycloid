import type {
  DockerRuntimeEntry,
  PreviewContractAuthConfig,
  PreviewContractE2EConfig,
  PreviewContractGeneratedComposeEnv,
} from "./sandbox.js";

export type AppRuntimeE2EConfig = PreviewContractE2EConfig;
export type AppRuntimeAuthConfig = PreviewContractAuthConfig;

export type AppRuntimeProfileConfig = {
  cwd?: string;
  kind?: string;
  runner?: string;
  entry?: DockerRuntimeEntry;
  url?: {
    hostPort?: number;
    path?: string;
  };
  portMapping?: {
    containerPort?: number;
  };
  additionalPorts?: Array<{
    service?: string;
    hostPort?: number;
    containerPort?: number;
  }>;
  composeEnv?: Record<string, string>;
  generatedComposeEnv?: PreviewContractGeneratedComposeEnv;
  env?: Record<string, string>;
  ready?: {
    path?: string;
    timeoutSeconds?: number;
  };
  open?: {
    path?: string;
  };
  /** Optional runtime auth setup used for authenticated visual evidence. */
  auth?: AppRuntimeAuthConfig;
  /** Optional E2E runtime declaration. Populated activates `cycloid-app run/seed/reset` + agent prompt. */
  e2e?: AppRuntimeE2EConfig;
};
