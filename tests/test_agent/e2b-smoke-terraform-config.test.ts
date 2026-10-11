import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CONFIG_DIR = resolve("infra/e2b-smoke");
const SOURCE = resolve("infra/e2b-smoke/source.json");
const TARGET = resolve("infra/e2b-smoke/target.json");
const BACKEND = resolve("infra/e2b-smoke/backend.hcl");
const TFVARS = resolve("infra/e2b-smoke/cycloid-lean.tfvars");
const SSM = resolve("infra/ssm.tf");
const WRAPPER = resolve("scripts/e2b-smoke-terraform.mjs");

function readTfvars(): string {
  return readFileSync(TFVARS, "utf-8");
}

describe("E2B smoke Terraform config", () => {
  it("pins the org-owned E2B infra fork separately from target state", () => {
    const source = JSON.parse(readFileSync(SOURCE, "utf-8")) as {
      repository: string;
      ref: string;
      providerAwsPath: string;
    };

    expect(source.repository).toBe("trycycloid/infra");
    expect(source.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(source.providerAwsPath).toBe("iac/provider-aws");
    expect(source).not.toHaveProperty("stateBucket");
    expect(source).not.toHaveProperty("stateKey");
  });

  it("keeps the Cycloid smoke target wiring in repo-owned metadata", () => {
    const target = JSON.parse(readFileSync(TARGET, "utf-8")) as {
      name: string;
      awsAccountId: string;
      awsRegion: string;
      domainName: string;
      prefix: string;
      backendConfig: string;
      varFile: string;
      planFile: string;
      destroyPlanFile: string;
    };

    expect(target.name).toBe("cycloid-smoke");
    expect(target.awsAccountId).toBe("666177270058");
    expect(target.awsRegion).toBe("us-east-1");
    expect(target.domainName).toBe("cycloid-e2b-dev.com");
    expect(target.prefix).toBe("arc-e2b-smoke-");
    expect(existsSync(resolve(CONFIG_DIR, target.backendConfig))).toBe(true);
    expect(existsSync(resolve(CONFIG_DIR, target.varFile))).toBe(true);
    expect(target.planFile).toBe("/tmp/e2b-smoke-lean.tfplan");
    expect(target.destroyPlanFile).toBe("/tmp/e2b-smoke-lean-destroy.tfplan");
    expect(target.destroyPlanFile).not.toBe(target.planFile);
  });

  it("keeps the existing E2B smoke backend in a Terraform backend config file", () => {
    const backend = readFileSync(BACKEND, "utf-8");

    expect(backend).toContain('bucket = "666177270058-terraform-state"');
    expect(backend).toContain('key    = "terraform/orchestration/state"');
    expect(backend).toContain('region = "us-east-1"');
  });

  it("keeps the materialized upstream checkout out of git", () => {
    const gitignore = readFileSync(".gitignore", "utf-8");

    expect(gitignore).toContain("infra/e2b-smoke/.source/");
  });

  it("keeps the lean Cycloid smoke stack sizing in repo-owned tfvars", () => {
    const tfvars = readTfvars();

    expect(tfvars).toContain('prefix        = "arc-e2b-smoke-"');
    expect(tfvars).toContain('domain_name   = "cycloid-e2b-dev.com"');
    expect(tfvars).toContain("control_server_cluster_size = 1");
    expect(tfvars).toContain('api_server_machine_type  = "t3.large"');
    expect(tfvars).toContain("api_cpu_count            = 0.5");
    expect(tfvars).toContain("ingress_cpu_count        = 0.5");
    expect(tfvars).toContain("client_proxy_cpu_count   = 0.5");
    expect(tfvars).toContain("loki_cpu_count           = 0.5");
    expect(tfvars).toContain("otel_collector_cpu_count = 0.25");
    expect(tfvars).toContain('client_server_machine_type = "m8i.2xlarge"');
    expect(tfvars).toContain("build_cluster_size        = 0");
    expect(tfvars).toContain('clickhouse_server_machine_type = "t3.medium"');
    expect(tfvars).toContain("clickhouse_cpu_count           = 1");
    expect(tfvars).toContain("clickhouse_memory_mb           = 2048");
    expect(tfvars).toContain("db_max_open_connections      = 20");
    expect(tfvars).toContain("auth_db_max_open_connections = 10");
  });

  it("keeps force-destroy as a destroy-time wrapper override", () => {
    const tfvars = readTfvars();
    const wrapper = readFileSync(WRAPPER, "utf-8");

    expect(tfvars).not.toContain("allow_force_destroy");
    expect(wrapper).toContain('"-var=allow_force_destroy=true"');
  });

  it("does not require the retired smoke Secrets Manager key in root infra", () => {
    const ssm = readFileSync(SSM, "utf-8");

    expect(ssm).not.toContain("aws_secretsmanager_secret_version");
    expect(ssm).not.toContain("arc-e2b-smoke-team-api-key");
  });

  it("no longer provisions self-hosted E2B SSM parameters", () => {
    const ssm = readFileSync(SSM, "utf-8");

    // Self-hosted E2B runtime was removed; the only SandboxRuntimeBackend is
    // e2b_cloud, so these parameters have no consumer.
    expect(ssm).not.toMatch(/^\s*SELF_HOSTED_E2B_\w+\s*=/m);
    expect(ssm).not.toContain('aws_ssm_parameter" "self_hosted_e2b_runtime"');
  });
});
