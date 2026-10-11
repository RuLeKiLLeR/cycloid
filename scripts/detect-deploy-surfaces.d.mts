export type DeploySurfaces = {
  ui: boolean;
  control: boolean;
  sandbox: boolean;
  ssm: boolean;
};

export type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

export type DetectDeploySurfacesOptions = {
  markerRef?: string;
  sha: string | undefined;
  git?: (args: string[]) => GitResult;
};

export function detectSurfacesFromFiles(files: string[], options?: { failOpen?: boolean }): DeploySurfaces;

export function detectDeploySurfaces(options: DetectDeploySurfacesOptions): {
  baseSha: string;
  changedFiles: string[];
  failOpen: boolean;
  skip: boolean;
  surfaces: DeploySurfaces;
};
