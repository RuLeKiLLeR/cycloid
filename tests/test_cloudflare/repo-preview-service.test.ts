import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetFileContent = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockTracedFetch = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  githubHeaders: () => ({ authorization: "Bearer test-token" }),
}));

vi.mock("../../apps/control-plane-worker/src/memory/github", () => ({
  getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) => mockTracedFetch(...args),
}));

import { resolveAppRuntimeProfile as resolveRepoPreviewSupport } from "../../apps/control-plane-worker/src/services/repo-preview";

function mockRootTree(paths: string[]): void {
  mockTracedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      tree: paths.map((path) => ({ path, type: "blob" })),
    }),
  });
}

function composeProfile(overrides: Record<string, unknown> = {}) {
  return {
    kind: "web",
    runner: "docker",
    entry: {
      type: "compose",
      files: ["docker-compose.yml"],
      service: "web",
    },
    url: {
      hostPort: 5173,
      path: "/",
    },
    ready: {
      path: "healthz",
    },
    open: {
      path: "app",
    },
    ...overrides,
  };
}

describe("resolveRepoPreviewSupport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns none without fetching repo tree when no explicit config exists", async () => {
    mockGetFileContent.mockResolvedValue(null);

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result).toEqual({
      dockerEnabled: false,
      previewContract: null,
      source: "none",
      diagnostics: [
        expect.objectContaining({
          code: "no_runtime_profile",
          severity: "info",
          message: expect.stringContaining("Add .cycloid.json"),
        }),
      ],
    });
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockGetFileContent).toHaveBeenCalledOnce();
  });

  it("uses explicit structured Compose runtime config from .cycloid.json", async () => {
    mockRootTree(["docker-compose.yml", "README.md"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({ appRuntime: composeProfile() });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result).toEqual({
      dockerEnabled: true,
      source: "config_docker",
      diagnostics: [],
      previewContract: {
        cwd: "/workspace/repo",
        kind: "web",
        runner: "docker",
        entry: {
          type: "compose",
          files: ["docker-compose.yml"],
          service: "web",
        },
        url: {
          hostPort: 5173,
        },
        ready: {
          path: "/healthz",
        },
        open: {
          path: "/app",
        },
      },
    });
  });

  it("preserves additional browser-reachable ports in structured Compose runtime config", async () => {
    mockRootTree(["docker-compose.yml", "README.md"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            url: { hostPort: 3001 },
            additionalPorts: [{ service: "server", hostPort: 3000, containerPort: 3000 }],
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.previewContract).toMatchObject({
      url: { hostPort: 3001 },
      additionalPorts: [{ service: "server", hostPort: 3000, containerPort: 3000 }],
    });
  });

  it("preserves generated compose env specs in structured runtime config", async () => {
    mockRootTree(["docker-compose.yml", "README.md"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            generatedComposeEnv: {
              DOGFOOD_SESSION_TOKEN: { type: "hex", bytes: 32 },
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.previewContract?.generatedComposeEnv).toEqual({
      DOGFOOD_SESSION_TOKEN: { type: "hex", bytes: 32 },
    });
  });

  it("rejects generated compose env keys that use reserved platform names", async () => {
    mockRootTree(["docker-compose.yml", "README.md"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            generatedComposeEnv: {
              GITHUB_TOKEN: { type: "hex", bytes: 32 },
              ARCANIST_LOGIN_USERNAME: { type: "hex", bytes: 32 },
              PORT: { type: "hex", bytes: 32 },
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(false);
    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_env",
        severity: "error",
        field: "appRuntime.generatedComposeEnv.GITHUB_TOKEN",
        value: "GITHUB_TOKEN",
        message: expect.stringContaining("reserved prefix"),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_env",
        severity: "error",
        field: "appRuntime.generatedComposeEnv.ARCANIST_LOGIN_USERNAME",
        value: "ARCANIST_LOGIN_USERNAME",
        message: expect.stringContaining("reserved prefix"),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_env",
        severity: "error",
        field: "appRuntime.generatedComposeEnv.PORT",
        value: "PORT",
        message: expect.stringContaining("reserved name"),
      }),
    );
  });

  it("fails closed when an additional browser port duplicates the primary host port", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            url: { hostPort: 3000 },
            additionalPorts: [{ service: "server", hostPort: 3000, containerPort: 3000 }],
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(false);
    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_port_mapping",
          field: "appRuntime.additionalPorts[0].hostPort",
        }),
      ]),
    );
  });

  it("reports duplicate additional host ports even when the first entry has an invalid service", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            additionalPorts: [
              { service: "", hostPort: 3000, containerPort: 3000 },
              { service: "server", hostPort: 3000, containerPort: 3000 },
            ],
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(false);
    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_port_mapping",
          field: "appRuntime.additionalPorts[0].service",
        }),
        expect.objectContaining({
          code: "invalid_port_mapping",
          field: "appRuntime.additionalPorts[1].hostPort",
          value: 3000,
          message: "App Runtime Profile additionalPorts[].hostPort 3000 duplicates another exposed host port.",
        }),
      ]),
    );
  });

  it("reports duplicate additional host ports even when the first entry has an invalid container port", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            additionalPorts: [
              { service: "server", hostPort: 3000, containerPort: 0 },
              { service: "server", hostPort: 3000, containerPort: 3000 },
            ],
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(false);
    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_port_mapping",
          field: "appRuntime.additionalPorts[0].containerPort",
        }),
        expect.objectContaining({
          code: "invalid_port_mapping",
          field: "appRuntime.additionalPorts[1].hostPort",
          value: 3000,
          message: "App Runtime Profile additionalPorts[].hostPort 3000 duplicates another exposed host port.",
        }),
      ]),
    );
  });

  it("uses explicit structured Dockerfile runtime config from .cycloid.json", async () => {
    mockRootTree(["Dockerfile"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: {
            kind: "web",
            runner: "docker",
            entry: {
              type: "dockerfile",
              context: ".",
              dockerfile: "Dockerfile",
              service: "app",
            },
            url: { hostPort: 5000 },
            portMapping: { containerPort: 5000 },
          },
        });
      }
      if (path === "Dockerfile") return "FROM python:3.12-alpine";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toEqual({
      cwd: "/workspace/repo",
      kind: "web",
      runner: "docker",
      entry: {
        type: "dockerfile",
        context: ".",
        dockerfile: "Dockerfile",
        service: "app",
      },
      url: { hostPort: 5000 },
      portMapping: { containerPort: 5000 },
    });
    expect(result.dockerEnabled).toBe(true);
  });

  it("reports non-Docker App Runtime Profile config as an unsupported runner", async () => {
    mockGetFileContent.mockResolvedValue(
      JSON.stringify({
        appRuntime: {
          kind: "web",
          runner: "native",
          ready: { path: "/api/health" },
        },
      }),
    );

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result).toEqual({
      dockerEnabled: false,
      source: "none",
      previewContract: null,
      diagnostics: [
        expect.objectContaining({
          code: "unsupported_runner",
          severity: "error",
          field: "appRuntime.runner",
          value: "native",
        }),
      ],
    });
  });

  it("fails closed on malformed compose profiles", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            entry: {
              type: "compose",
              files: ["docker-compose.yml"],
              service: "web",
              profiles: ["seed", ""],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(false);
    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_entry",
          severity: "error",
          field: "appRuntime.entry.profiles",
        }),
      ]),
    );
  });

  it("requires Dockerfile runtime config to include container port mapping", async () => {
    mockRootTree(["Dockerfile"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: {
            kind: "web",
            runner: "docker",
            entry: {
              type: "dockerfile",
              context: ".",
              dockerfile: "Dockerfile",
              service: "app",
            },
            url: { hostPort: 5000 },
          },
        });
      }
      if (path === "Dockerfile") return "FROM python:3.12-alpine";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result).toEqual({
      dockerEnabled: false,
      source: "config_docker",
      previewContract: null,
      diagnostics: [
        expect.objectContaining({
          code: "invalid_port_mapping",
          field: "appRuntime.portMapping.containerPort",
        }),
      ],
    });
  });

  it("uses a root Compose file when entry.files is omitted and one is obvious", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            entry: {
              type: "compose",
              service: "web",
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract?.entry).toEqual({
      type: "compose",
      files: ["docker-compose.yml"],
      service: "web",
    });
  });

  it("reports a missing Compose profile when entry.files is omitted and no root Compose file exists", async () => {
    mockRootTree(["README.md"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            entry: {
              type: "compose",
              service: "web",
            },
          }),
        });
      }
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result).toEqual({
      dockerEnabled: false,
      source: "config_docker",
      previewContract: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "docker_compose_missing",
          severity: "error",
          field: "appRuntime.entry.files",
        }),
      ]),
    });
  });

  it("fails closed on invalid Compose file paths", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockResolvedValueOnce(
      JSON.stringify({
        appRuntime: composeProfile({
          entry: {
            type: "compose",
            files: ["../docker-compose.yml"],
            service: "web",
          },
        }),
      }),
    );

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result).toEqual({
      dockerEnabled: false,
      source: "config_docker",
      previewContract: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_compose_file",
          severity: "error",
          field: "appRuntime.entry.files",
          value: "../docker-compose.yml",
        }),
      ]),
    });
  });

  it("accepts non-reserved positive host ports", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({ appRuntime: composeProfile({ url: { hostPort: 8000 } }) });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.previewContract?.url.hostPort).toBe(8000);
  });

  it("passes through a valid e2e block on the preview contract", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            e2e: {
              testCommand: "npm run test:e2e",
              seedCommand: "npm run db:seed:test",
              resetCommand: "npm run db:reset",
              credentials: [
                { name: "test_user_email", envVar: "E2E_USER_EMAIL" },
                { name: "test_user_password", envVar: "E2E_USER_PASSWORD" },
              ],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.dockerEnabled).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.previewContract?.e2e).toEqual({
      testCommand: "npm run test:e2e",
      seedCommand: "npm run db:seed:test",
      resetCommand: "npm run db:reset",
      credentials: [
        { name: "test_user_email", envVar: "E2E_USER_EMAIL" },
        { name: "test_user_password", envVar: "E2E_USER_PASSWORD" },
      ],
    });
  });

  it("preserves a valid credentials[].source and rejects unknown sources", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            auth: {
              command: "npm run cycloid:auth",
              credentials: [
                { name: "mia-openai-api-key", envVar: "MIA_OPENAI_API_KEY", source: "business_openai_key" },
                { name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" },
              ],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const valid = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");
    expect(valid.previewContract).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          credentials: [
            { name: "mia-openai-api-key", envVar: "MIA_OPENAI_API_KEY", source: "business_openai_key" },
            { name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" },
          ],
        }),
      }),
    );
    expect(valid.diagnostics).toEqual([]);

    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            auth: {
              command: "npm run cycloid:auth",
              credentials: [{ name: "bad-source", envVar: "SOME_KEY", source: "user_openai_key" }],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const invalid = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        field: "appRuntime.auth.credentials[0].source",
      }),
    );
  });

  it("rejects an e2e block that is missing testCommand", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({ e2e: { seedCommand: "npm run db:seed" } }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "missing_e2e_test_command",
        severity: "error",
        field: "appRuntime.e2e.testCommand",
      }),
    );
  });

  it("preserves generic runtime auth config in structured Compose runtime config", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            auth: {
              command: "npm run cycloid:auth",
              validatePath: "/dashboard",
              credentials: [{ name: "login_user", envVar: "E2E_LOGIN_USER" }],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toEqual(
      expect.objectContaining({
        auth: {
          command: "npm run cycloid:auth",
          validatePath: "/dashboard",
          credentials: [{ name: "login_user", envVar: "E2E_LOGIN_USER" }],
        },
      }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects runtime auth config with an external validatePath", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            auth: {
              command: "npm run cycloid:auth",
              validatePath: "https://example.com/dashboard",
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_auth_config",
        severity: "error",
        field: "appRuntime.auth.validatePath",
      }),
    );
  });

  it.each(["/dashboard?redirect=https://example.com", "/dashboard?next=/foo", "/dashboard#done", "/dashboard\u0000"])(
    "rejects runtime auth config with non-pathname validatePath %s",
    async (validatePath) => {
      mockRootTree(["docker-compose.yml"]);
      mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
        if (path === ".cycloid.json") {
          return JSON.stringify({
            appRuntime: composeProfile({
              auth: {
                command: "npm run cycloid:auth",
                validatePath,
              },
            }),
          });
        }
        if (path === "docker-compose.yml") return "services: {}";
        return null;
      });

      const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

      expect(result.previewContract).toBeNull();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "invalid_auth_config",
          severity: "error",
          field: "appRuntime.auth.validatePath",
        }),
      );
    },
  );

  it("rejects runtime auth credentials whose envVar uses a reserved platform prefix", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            auth: {
              command: "npm run cycloid:auth",
              credentials: [{ name: "shadow", envVar: "ARCANIST_TOKEN" }],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_auth_config",
        severity: "error",
        field: "appRuntime.auth.credentials[0].envVar",
        value: "ARCANIST_TOKEN",
      }),
    );
  });

  it("rejects runtime auth credentials whose envVar collides with an agent-child allowlist name", async () => {
    // A customer credential declared under an allowlisted operational name
    // (NODE_OPTIONS, or any exact allowlist entry) would otherwise survive into
    // the agent child env; NODE_OPTIONS can also preload code into Node agents.
    for (const envVar of ["NODE_OPTIONS", "CONTROL_PLANE_URL", "SANDBOX_ID"]) {
      mockRootTree(["docker-compose.yml"]);
      mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
        if (path === ".cycloid.json") {
          return JSON.stringify({
            appRuntime: composeProfile({
              auth: {
                command: "npm run cycloid:auth",
                credentials: [{ name: "shadow", envVar }],
              },
            }),
          });
        }
        if (path === "docker-compose.yml") return "services: {}";
        return null;
      });

      const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");
      expect(result.previewContract, envVar).toBeNull();
      expect(result.diagnostics, envVar).toContainEqual(
        expect.objectContaining({
          code: "invalid_auth_config",
          severity: "error",
          field: "appRuntime.auth.credentials[0].envVar",
          value: envVar,
        }),
      );
    }
  });

  it("allows legacy dummy-app CYCLOID_LOGIN auth credential env vars", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            auth: {
              command: "npm run cycloid:auth",
              credentials: [
                { name: "dummy_login_username", envVar: "ARCANIST_LOGIN_USERNAME" },
                { name: "dummy_login_password", envVar: "ARCANIST_LOGIN_PASSWORD" },
              ],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          credentials: [
            { name: "dummy_login_username", envVar: "ARCANIST_LOGIN_USERNAME" },
            { name: "dummy_login_password", envVar: "ARCANIST_LOGIN_PASSWORD" },
          ],
        }),
      }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects e2e credentials with malformed envVar names", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            e2e: {
              testCommand: "npm test",
              credentials: [{ name: "ok_name", envVar: "lowercase_envVar" }],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_e2e_credential",
        severity: "error",
        field: "appRuntime.e2e.credentials[0].envVar",
      }),
    );
  });

  it("rejects e2e credentials whose envVar uses a reserved platform prefix", async () => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            e2e: {
              testCommand: "npm test",
              credentials: [{ name: "shadow", envVar: "GITHUB_TOKEN" }],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_e2e_credential",
        severity: "error",
        field: "appRuntime.e2e.credentials[0].envVar",
        value: "GITHUB_TOKEN",
      }),
    );
  });

  it.each([
    ["GH_TOKEN", "GH_ prefix"],
    ["SANDBOX_AUTH_TOKEN", "SANDBOX_ prefix"],
    ["PORT", "exact reserved name"],
    ["HOST", "exact reserved name"],
    ["NODE_ENV", "exact reserved name"],
  ])("rejects e2e credential with reserved envVar %s (%s)", async (envVar, _reason) => {
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            e2e: {
              testCommand: "npm test",
              credentials: [{ name: "shadow", envVar }],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_e2e_credential",
        severity: "error",
        field: "appRuntime.e2e.credentials[0].envVar",
        value: envVar,
      }),
    );
  });

  it("rejects e2e credentials with duplicate envVar values", async () => {
    // Two distinct names sharing the same envVar would silently clobber one
    // another at session start (Object.fromEntries map, last one wins).
    // Validation must reject the ambiguity so the customer renames or merges.
    mockRootTree(["docker-compose.yml"]);
    mockGetFileContent.mockImplementation(async (_token, _owner, _repo, path) => {
      if (path === ".cycloid.json") {
        return JSON.stringify({
          appRuntime: composeProfile({
            e2e: {
              testCommand: "npm test",
              credentials: [
                { name: "first", envVar: "E2E_TOKEN" },
                { name: "second", envVar: "E2E_TOKEN" },
              ],
            },
          }),
        });
      }
      if (path === "docker-compose.yml") return "services: {}";
      return null;
    });

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "main");

    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_e2e_credential",
        severity: "error",
        field: "appRuntime.e2e.credentials[1].envVar",
        value: "E2E_TOKEN",
      }),
    );
  });

  it("fails closed on invalid .cycloid.json instead of falling back to docker detection", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRootTree(["Dockerfile", "docker-compose.yaml"]);
    mockGetFileContent.mockResolvedValue("{not-json");

    const result = await resolveRepoPreviewSupport("tok", "acme", "widgets", "feat/docker");

    expect(result.source).toBe("none");
    expect(result.dockerEnabled).toBe(false);
    expect(result.previewContract).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_config_json",
        severity: "error",
        field: ".cycloid.json",
      }),
    ]);
    expect(mockTracedFetch).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
