#!/usr/bin/env node

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TARGETS = Object.freeze({
  production: "cycloid-control-plane-production",
  qa: "cycloid-control-plane-qa",
});

const EXCLUDED_KEYS = Object.freeze({
  production: new Set([
    "CONTROL_PLANE_URL",
    "JIRA_OAUTH_CALLBACK_URL",
    "LINEAR_OAUTH_CALLBACK_URL",
    "NOTION_OAUTH_CALLBACK_URL",
    "SLACK_OAUTH_CALLBACK_URL",
    "SLACK_INSTALL_CALLBACK_URL",
    "OTEL_COLLECTOR_URL",
    "COLLECTOR_AUTH_KEY",
  ]),
  qa: new Set([
    "CONTROL_PLANE_URL",
    "JIRA_OAUTH_CALLBACK_URL",
    "LINEAR_OAUTH_CALLBACK_URL",
    "NOTION_OAUTH_CALLBACK_URL",
    "SLACK_OAUTH_CALLBACK_URL",
    "SLACK_INSTALL_CALLBACK_URL",
  ]),
});

function fail(message) {
  throw new Error(message.replace(/[\r\n]+/g, " ").slice(0, 1000));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeParameters(raw, environment) {
  if (!Array.isArray(raw)) fail("SSM response must be an array");
  const excluded = EXCLUDED_KEYS[environment];
  const result = {};
  const metadata = {};
  for (const parameter of raw) {
    if (!parameter || typeof parameter !== "object" || typeof parameter.Name !== "string") {
      fail("SSM response contains a malformed parameter");
    }
    const key = parameter.Name.split("/").pop();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || excluded.has(key)) continue;
    if (typeof parameter.Value !== "string") fail(`SSM parameter ${key} has no string value`);
    if (!Number.isInteger(parameter.Version) && typeof parameter.LastModifiedDate !== "string") {
      fail(`SSM parameter ${key} has no trustworthy version fingerprint`);
    }
    result[key] = parameter.Value;
    metadata[key] = {
      version: Number.isInteger(parameter.Version) ? parameter.Version : null,
      lastModifiedDate: typeof parameter.LastModifiedDate === "string" ? parameter.LastModifiedDate : null,
    };
  }
  return { result, metadata };
}

function normalizeProviderNames(raw) {
  if (!Array.isArray(raw)) fail("Cloudflare secret list response must be an array");
  const names = new Set();
  for (const entry of raw) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))
      fail("Cloudflare secret list contains a malformed name");
    names.add(name);
  }
  return [...names].sort();
}

function normalizeFingerprints(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Fingerprint state must be an object");
  const fingerprints = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (
      !value ||
      typeof value !== "object" ||
      (!Number.isInteger(value.version) && typeof value.lastModifiedDate !== "string")
    ) {
      fail(`Fingerprint for ${key} is not trustworthy`);
    }
    fingerprints[key] = {
      version: Number.isInteger(value.version) ? value.version : null,
      lastModifiedDate: typeof value.lastModifiedDate === "string" ? value.lastModifiedDate : null,
    };
  }
  return fingerprints;
}

function sameFingerprint(a, b) {
  return a?.version === b?.version && a?.lastModifiedDate === b?.lastModifiedDate;
}

export function reconcileControlPlaneSecrets({
  environment,
  workerName,
  ssmParameters,
  generatedSecrets,
  fingerprints,
  providerNames,
}) {
  if (!Object.hasOwn(TARGETS, environment) || TARGETS[environment] !== workerName) {
    fail(`Refusing to reconcile ${environment} secrets into unexpected Worker ${workerName}`);
  }
  const { result: allSecrets, metadata } = normalizeParameters(ssmParameters, environment);
  const validated = generatedSecrets && typeof generatedSecrets === "object" ? generatedSecrets : allSecrets;
  const provider = normalizeProviderNames(providerNames);
  const prior = fingerprints === null ? null : normalizeFingerprints(fingerprints);
  const missingProviderKeys = Object.keys(allSecrets).filter((key) => !provider.includes(key));
  const changedKeys = Object.keys(allSecrets)
    .filter((key) => prior === null || !sameFingerprint(prior[key], metadata[key]))
    .concat(missingProviderKeys)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort();
  const changed = Object.fromEntries(changedKeys.map((key) => [key, validated[key] ?? allSecrets[key]]));
  const removedKeys = provider.filter((key) => !Object.hasOwn(allSecrets, key) && !EXCLUDED_KEYS[environment].has(key));
  const nextFingerprints = Object.fromEntries(
    Object.keys(metadata)
      .sort()
      .map((key) => [key, metadata[key]]),
  );
  return {
    environment,
    workerName,
    changedKeys,
    changedSecrets: changed,
    removedKeys,
    fingerprints: nextFingerprints,
    secretsChangedCount: changedKeys.length,
    fullSync: prior === null,
  };
}

function parseArgs(argv) {
  const args = Object.fromEntries(
    argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || true];
    }),
  );
  for (const key of ["environment", "worker", "ssm", "secrets", "provider-names", "fingerprints", "output"]) {
    if (!args[key]) fail(`Missing --${key}`);
  }
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv);
    const ssmParameters = readJson(args.ssm, "SSM parameters");
    if (!Array.isArray(ssmParameters)) fail("SSM parameters must be an array");
    // Values are masked immediately after SSM read and before validation or any
    // provider-facing operation. The generated file remains runner-local.
    for (const parameter of ssmParameters) {
      if (typeof parameter?.Value === "string") process.stdout.write(`::add-mask::${parameter.Value}\n`);
    }
    const output = reconcileControlPlaneSecrets({
      environment: args.environment,
      workerName: args.worker,
      ssmParameters,
      generatedSecrets: readJson(args.secrets, "generated secrets"),
      fingerprints: readJson(args.fingerprints, "fingerprints"),
      providerNames: readJson(args["provider-names"], "provider secret names"),
    });
    writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
    chmodSync(args.output, 0o600);
    process.stdout.write(`changed=${output.secretsChangedCount}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Secret reconciliation failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
