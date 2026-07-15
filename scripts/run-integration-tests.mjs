import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SUBPROCESS_OUTPUT_BYTES = 1024 * 1024;
const LOCAL_ENVIRONMENT_NAMES = Object.freeze({
  apiUrl: ["API_URL", "SUPABASE_URL"],
  anonKey: ["ANON_KEY", "SUPABASE_ANON_KEY"],
  serviceRoleKey: ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
  jwtSecret: ["JWT_SECRET", "SUPABASE_JWT_SECRET"],
});
const UNSAFE_ENVIRONMENT_NAMES = Object.freeze([
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_REMOTE_URL",
]);
const SAFE_LOCAL_TEMPORARY_STATE = new Set(["cli-latest"]);
const REQUIRED_LOCAL_SERVICE_NAMES = Object.freeze([
  "supabase_auth_relay",
  "supabase_db_relay",
  "supabase_edge_runtime_relay",
  "supabase_kong_relay",
  "supabase_rest_relay",
]);
const LOCAL_STATUS_POLL_INTERVAL_MS = 250;
const LOCAL_STATUS_TIMEOUT_MS = 10_000;
const EDGE_FUNCTIONS_READY_TIMEOUT_MS = 20_000;
const EDGE_FUNCTION_REQUEST_TIMEOUT_MS = 1_000;
const EDGE_FUNCTIONS_READY_PATH = "/functions/v1/bridge-api/v1/graph/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EDGE_WEBHOOK_READY_PATH = "/functions/v1/notion-webhook";
const LOCAL_EDGE_RUNTIME_ENVIRONMENT = Object.freeze({
  RELAY_TOKEN_PEPPER: "edge-local-fixture-pepper",
  RELAY_WEBHOOK_TOKENS_JSON: JSON.stringify({
    "11111111-1111-4111-8111-111111111111": "edge-local-fixture-webhook-token",
  }),
});

export class IntegrationRunnerError extends Error {}

function runnerError(message) {
  return new IntegrationRunnerError(message);
}

function isDescendant(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function assertSafeFilters(argv, cwd) {
  if (!Array.isArray(argv)) {
    throw runnerError("Integration test arguments must be an argv array");
  }
  const integrationRoot = resolve(cwd, "tests", "integration");
  const filters = [];
  for (const value of argv) {
    if (value === "--") {
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
      throw runnerError("Only local integration test-file filters are allowed");
    }
    const resolved = resolve(cwd, value);
    if (!isDescendant(integrationRoot, resolved) || !value.endsWith(".test.ts")) {
      throw runnerError("Integration filters must be local tests/integration/*.test.ts files");
    }
    filters.push(value);
  }
  return filters;
}

function assertLocalConfiguration(configToml) {
  if (typeof configToml !== "string") {
    throw runnerError("Missing local Supabase configuration");
  }
  if (/\b(project_id|project_ref|access_token|db_url|remote_url)\b/i.test(configToml) || /^\s*\[\s*remotes?\s*\]/im.test(configToml)) {
    throw runnerError("Linked or remote Supabase configuration is not allowed");
  }
}

function assertSafeEnvironment(environment) {
  for (const name of UNSAFE_ENVIRONMENT_NAMES) {
    if (environment[name]) {
      throw runnerError("Linked or remote Supabase environment is not allowed");
    }
  }
}

function nodeFileSystem() {
  return {
    readText(path) {
      return readFile(path, "utf8");
    },
    async readDirectory(path) {
      try {
        return await readdir(path);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
  };
}

async function createLocalEdgeRuntimeEnvironment(values = LOCAL_EDGE_RUNTIME_ENVIRONMENT) {
  const directory = await mkdtemp(join(tmpdir(), "grandbox-bridge-edge-"));
  const path = join(directory, "functions.env");
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`);
  try {
    await writeFile(path, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    async remove() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function assertNoLinkedLocalState(cwd, filesystem) {
  const entries = await filesystem.readDirectory(join(cwd, "relay", "supabase", ".temp"));
  if (!Array.isArray(entries)) {
    throw runnerError("Unable to verify repository-local Supabase state");
  }
  for (const entry of entries) {
    if (typeof entry !== "string" || !SAFE_LOCAL_TEMPORARY_STATE.has(entry)) {
      throw runnerError("Repository-local Supabase temporary or linked state is not allowed");
    }
  }
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStatusEnvironment(output) {
  const values = Object.create(null);
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match) {
      values[match[1]] = unquote(match[2]);
    }
  }
  return values;
}

function statusValue(values, names) {
  for (const name of names) {
    if (values[name]) {
      return values[name];
    }
  }
  throw runnerError("Local Supabase status did not provide the required test environment");
}

function hasRequiredLocalEnvironment(statusOutput) {
  const values = parseStatusEnvironment(statusOutput);
  return Object.values(LOCAL_ENVIRONMENT_NAMES).every((names) => names.some((name) => typeof values[name] === "string" && values[name].length > 0));
}

function stoppedLocalServices(status) {
  const services = new Set();
  const output = `${status.stdout}\n${status.stderr}`;
  const matches = output.matchAll(/Stopped services:\s*\[([^\]]*)\]/giu);
  for (const match of matches) {
    for (const service of match[1].trim().split(/\s+/u)) {
      if (service) services.add(service);
    }
  }
  return services;
}

function hasMissingRequiredLocalService(status) {
  const output = `${status.stdout}\n${status.stderr}`;
  return REQUIRED_LOCAL_SERVICE_NAMES.some((service) => output.includes(`No such container: ${service}`));
}

function isHealthyLocalStatus(status) {
  if (status.code !== 0 || !hasRequiredLocalEnvironment(status.stdout) || hasMissingRequiredLocalService(status)) return false;
  const stopped = stoppedLocalServices(status);
  return REQUIRED_LOCAL_SERVICE_NAMES.every((service) => !stopped.has(service));
}

function isFullyStoppedLocalStatus(status) {
  if (status.code !== 0) return true;
  const stopped = stoppedLocalServices(status);
  return REQUIRED_LOCAL_SERVICE_NAMES.every((service) => stopped.has(service));
}

function isStoppedLocalStatus(status) {
  return isFullyStoppedLocalStatus(status)
    || `${status.stdout}\n${status.stderr}`.includes("No such container: supabase_db_relay");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function localVitestEnvironment(statusOutput, environment) {
  const values = parseStatusEnvironment(statusOutput);
  return {
    ...environment,
    SUPABASE_URL: statusValue(values, LOCAL_ENVIRONMENT_NAMES.apiUrl),
    SUPABASE_ANON_KEY: statusValue(values, LOCAL_ENVIRONMENT_NAMES.anonKey),
    SUPABASE_SERVICE_ROLE_KEY: statusValue(values, LOCAL_ENVIRONMENT_NAMES.serviceRoleKey),
    SUPABASE_JWT_SECRET: statusValue(values, LOCAL_ENVIRONMENT_NAMES.jwtSecret),
  };
}

function localEdgeRuntimeEnvironment(statusOutput) {
  const values = parseStatusEnvironment(statusOutput);
  return {
    ...LOCAL_EDGE_RUNTIME_ENVIRONMENT,
    RELAY_SERVICE_ROLE_KEY: statusValue(values, LOCAL_ENVIRONMENT_NAMES.serviceRoleKey),
  };
}

function localApiUrl(statusOutput) {
  const value = statusValue(parseStatusEnvironment(statusOutput), LOCAL_ENVIRONMENT_NAMES.apiUrl);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw runnerError("Local Supabase status returned an invalid API URL");
  }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
    throw runnerError("Local Supabase status returned a non-local API URL");
  }
  return parsed.origin;
}

function functionRoutesReady(bridge, webhook) {
  return bridge.status === 404
    && webhook.status === 405;
}

async function requestWithTimeout(request, url, timeoutMilliseconds) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("Local Edge Function readiness request timed out"));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([request(url, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForLocalFunctionRoutes(options) {
  const deadline = Date.now() + (options.readyTimeoutMilliseconds ?? EDGE_FUNCTIONS_READY_TIMEOUT_MS);
  let lastFailure = null;
  let exited = null;
  if (options.processResult !== null) {
    void options.processResult.then((result) => { exited = result; });
  }
  while (Date.now() < deadline) {
    try {
      const [bridge, webhook] = await Promise.all([
        requestWithTimeout(options.request, options.apiUrl + EDGE_FUNCTIONS_READY_PATH, options.requestTimeoutMilliseconds ?? EDGE_FUNCTION_REQUEST_TIMEOUT_MS),
        requestWithTimeout(options.request, options.apiUrl + EDGE_WEBHOOK_READY_PATH, options.requestTimeoutMilliseconds ?? EDGE_FUNCTION_REQUEST_TIMEOUT_MS),
      ]);
      if (functionRoutesReady(bridge, webhook)) {
        return;
      }
      lastFailure = `bridge=${bridge.status}, webhook=${webhook.status}`;
    } catch {
      lastFailure = "request failed";
    }
    if (options.isSignalled?.() || exited !== null) {
      throw runnerError("Local Edge Functions process exited before its routes became ready");
    }
    await options.waitForPoll(LOCAL_STATUS_POLL_INTERVAL_MS);
  }
  throw runnerError(`Timed out waiting for local Edge Function routes (${lastFailure ?? "unavailable"})`);
}

async function resolveLocalBinary(cwd, name) {
  const nodeModules = resolve(cwd, "node_modules");
  const expected = join(nodeModules, ".bin", name);
  let binary;
  try {
    binary = await realpath(expected);
  } catch {
    throw runnerError(`Missing checked-in local ${name} binary`);
  }
  if (!isDescendant(nodeModules, binary)) {
    throw runnerError(`Unsafe ${name} binary path`);
  }
  return binary;
}

async function resolveLocalSupabaseNativeBinary(cwd) {
  const nodeModules = resolve(cwd, "node_modules");
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const architecture = process.arch;
  const packageName = `cli-${platform}-${architecture}`;
  const executable = process.platform === "win32" ? "supabase.exe" : "supabase";
  const expected = join(nodeModules, "@supabase", packageName, "bin", executable);
  let binary;
  try {
    binary = await realpath(expected);
  } catch {
    throw runnerError("Missing checked-in local Supabase native binary");
  }
  if (!isDescendant(nodeModules, binary)) {
    throw runnerError("Unsafe Supabase native binary path");
  }
  return binary;
}

function nodeProcessAdapter() {
  let activeChildSettled = Promise.resolve();
  return {
    run(executable, args, options) {
      return new Promise((resolveResult, rejectResult) => {
        let settled = false;
        let totalBytes = 0;
        let stdout = "";
        let stderr = "";
        let outputLimitError = null;
        let resolveChildSettled;
        activeChildSettled = new Promise((resolve) => { resolveChildSettled = resolve; });
        const child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const failForOutput = () => {
          if (!outputLimitError) {
            outputLimitError = runnerError("Local subprocess output exceeded the safety limit");
            child.kill("SIGTERM");
          }
        };
        const append = (target, chunk) => {
          if (outputLimitError) {
            return target;
          }
          totalBytes += chunk.byteLength;
          if (totalBytes > options.maxOutputBytes) {
            failForOutput();
            return target;
          }
          return target + chunk.toString("utf8");
        };
        child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        child.once("error", () => {
          resolveChildSettled();
          if (!settled) {
            settled = true;
            rejectResult(outputLimitError ?? runnerError("Local subprocess could not start"));
          }
        });
        child.once("close", (code) => {
          resolveChildSettled();
          if (!settled) {
            settled = true;
            if (outputLimitError) {
              rejectResult(outputLimitError);
            } else {
              resolveResult({ code: code ?? 1, stdout, stderr });
            }
          }
        });
      });
    },
    start(executable, args, options) {
      return new Promise((resolveStarted, rejectStarted) => {
        let totalBytes = 0;
        let stdout = "";
        let stderr = "";
        let outputLimitError = null;
        let started = false;
        let settled = false;
        let resolveChildSettled;
        let resolveResult;
        activeChildSettled = new Promise((resolve) => { resolveChildSettled = resolve; });
        const result = new Promise((resolve) => { resolveResult = resolve; });
        const child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const failForOutput = () => {
          if (!outputLimitError) {
            outputLimitError = runnerError("Local subprocess output exceeded the safety limit");
            child.kill("SIGTERM");
          }
        };
        const append = (target, chunk) => {
          if (outputLimitError) {
            return target;
          }
          totalBytes += chunk.byteLength;
          if (totalBytes > options.maxOutputBytes) {
            failForOutput();
            return target;
          }
          return target + chunk.toString("utf8");
        };
        const settle = (code) => {
          if (settled) return;
          settled = true;
          resolveChildSettled();
          resolveResult({ code: code ?? 1, stdout, stderr });
        };
        const stop = async () => {
          if (!settled) {
            child.kill("SIGTERM");
          }
          const ended = await result;
          if (outputLimitError) {
            throw outputLimitError;
          }
          if (ended.code !== 0 && !settled) {
            throw runnerError("Local Edge Functions process could not stop");
          }
        };
        child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        child.once("spawn", () => {
          started = true;
          resolveStarted({ stop, result });
        });
        child.once("error", () => {
          settle(1);
          if (!started) {
            rejectStarted(outputLimitError ?? runnerError("Local Edge Functions process could not start"));
          }
        });
        child.once("close", (code) => {
          settle(code);
          if (!started) {
            rejectStarted(outputLimitError ?? runnerError("Local Edge Functions process could not start"));
          }
        });
      });
    },
    waitForActiveChild() {
      return activeChildSettled;
    },
    onSignal(signal, handler) {
      process.once(signal, handler);
      return () => process.removeListener(signal, handler);
    },
  };
}

async function runChecked(adapter, executable, args, options, action) {
  const result = await adapter.run(executable, args, options);
  if (result.code !== 0) {
    throw runnerError(`${action} failed`);
  }
  return result;
}

/**
 * Runs only the repository-local Supabase stack. `adapter` is injectable so
 * unit tests can cover all cleanup paths without Docker or a CLI installation.
 */
export async function runIntegrationTests(argv = [], options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const filesystem = options.filesystem ?? nodeFileSystem();
  assertSafeEnvironment(environment);
  const filters = assertSafeFilters(argv, cwd);
  const configToml = options.configToml ?? await filesystem.readText(join(cwd, "relay", "supabase", "config.toml"));
  assertLocalConfiguration(configToml);
  await assertNoLinkedLocalState(cwd, filesystem);
  const localBinaries = options.localBinaries ?? {
    supabase: await resolveLocalBinary(cwd, "supabase"),
    supabaseNative: await resolveLocalSupabaseNativeBinary(cwd),
    tsc: await resolveLocalBinary(cwd, "tsc"),
    vitest: await resolveLocalBinary(cwd, "vitest"),
  };
  const adapter = options.adapter ?? nodeProcessAdapter();
  const waitForPoll = options.waitForPoll ?? wait;
  const request = options.request ?? fetch;
  const createRuntimeEnvironment = options.createRuntimeEnvironment ?? createLocalEdgeRuntimeEnvironment;
  const commandOptions = Object.freeze({ cwd, shell: false, maxOutputBytes: MAX_SUBPROCESS_OUTPUT_BYTES });
  let startedHere = false;
  let startAttemptedHere = false;
  let stopPromise = null;
  let functionStopPromise = null;
  let functionsProcess = null;
  let runtimeEnvironment = null;
  let receivedSignal = null;

  const readLocalStatus = () => adapter.run(
    localBinaries.supabase,
    ["--workdir", "relay", "status", "--output", "env"],
    commandOptions,
  );
  const waitForLocalStatus = async (description, predicate) => {
    const deadline = Date.now() + LOCAL_STATUS_TIMEOUT_MS;
    let status = await readLocalStatus();
    while (!predicate(status)) {
      if (Date.now() >= deadline) {
        throw runnerError(`Timed out waiting for local Supabase ${description}`);
      }
      await waitForPoll(LOCAL_STATUS_POLL_INTERVAL_MS);
      status = await readLocalStatus();
    }
    return status;
  };

  const stopFunctionsIfOwned = async () => {
    if (functionsProcess === null) {
      return;
    }
    functionStopPromise ??= functionsProcess.stop();
    await functionStopPromise;
  };
  const removeRuntimeEnvironment = async () => {
    if (runtimeEnvironment === null) {
      return;
    }
    const environmentFile = runtimeEnvironment;
    runtimeEnvironment = null;
    await environmentFile.remove();
  };
  const stopIfOwned = async () => {
    await stopFunctionsIfOwned();
    if (!startedHere && !startAttemptedHere) {
      return;
    }
    stopPromise ??= (async () => {
      if (typeof adapter.waitForActiveChild === "function") {
        await adapter.waitForActiveChild();
      }
      await runChecked(
        adapter,
        localBinaries.supabase,
        ["--workdir", "relay", "stop", "--no-backup"],
        commandOptions,
        "Local Supabase stop",
      );
      await waitForLocalStatus("to stop", isStoppedLocalStatus);
    })();
    await stopPromise;
  };
  const throwIfSignalled = () => {
    if (receivedSignal) {
      throw runnerError(`Local integration tests interrupted by ${receivedSignal}`);
    }
  };
  const removers = ["SIGINT", "SIGTERM"].map((signal) => adapter.onSignal(signal, () => {
    receivedSignal = signal;
    void stopIfOwned().catch(() => undefined);
  }));

  let primaryError = null;
  try {
    await runChecked(
      adapter,
      localBinaries.tsc,
      ["-b", "shared", "relay"],
      commandOptions,
      "Canonical relay build",
    );
    throwIfSignalled();
    let status = await readLocalStatus();
    throwIfSignalled();
    if (!isHealthyLocalStatus(status)) {
      startAttemptedHere = true;
      await runChecked(
        adapter,
        localBinaries.supabase,
        ["--workdir", "relay", "stop", "--no-backup"],
        commandOptions,
        "Local Supabase recovery stop",
      );
      await waitForLocalStatus("to stop before restart", isStoppedLocalStatus);
      throwIfSignalled();
      await runChecked(
        adapter,
        localBinaries.supabase,
        ["--workdir", "relay", "start", "--ignore-health-check", "--exclude", "vector,logflare"],
        commandOptions,
        "Local Supabase start",
      );
      startedHere = true;
      throwIfSignalled();
      status = await waitForLocalStatus("to become healthy", isHealthyLocalStatus);
      throwIfSignalled();
    }
    const vitestEnvironment = localVitestEnvironment(status.stdout, environment);
    await runChecked(
      adapter,
      localBinaries.supabase,
      ["--workdir", "relay", "db", "reset", "--local"],
      commandOptions,
      "Local Supabase database reset",
    );
    throwIfSignalled();
    runtimeEnvironment = await createRuntimeEnvironment(localEdgeRuntimeEnvironment(status.stdout));
    if (typeof adapter.start !== "function") {
      throw runnerError("Local process adapter cannot start Edge Functions");
    }
    functionsProcess = await adapter.start(
      localBinaries.supabaseNative ?? localBinaries.supabase,
      ["--workdir", "relay", "functions", "serve", "--no-verify-jwt", "--env-file", runtimeEnvironment.path],
      commandOptions,
    );
    const waitForFunctionRoutes = options.waitForFunctionRoutes ?? waitForLocalFunctionRoutes;
    await waitForFunctionRoutes({
      apiUrl: localApiUrl(status.stdout),
      isSignalled: () => receivedSignal !== null,
      processResult: functionsProcess.result ?? null,
      request,
      readyTimeoutMilliseconds: options.edgeFunctionsReadyTimeoutMs,
      requestTimeoutMilliseconds: options.edgeFunctionsRequestTimeoutMs,
      waitForPoll,
    });
    throwIfSignalled();
    await runChecked(
      adapter,
      localBinaries.vitest,
      ["run", "--config", "vitest.integration.config.ts", ...filters],
      { ...commandOptions, env: vitestEnvironment },
      "Integration tests",
    );
    throwIfSignalled();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const remove of removers) {
      remove();
    }
    let cleanupError = null;
    try {
      await stopIfOwned();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await removeRuntimeEnvironment();
    } catch (error) {
      cleanupError ??= error;
    }
    if (!primaryError && cleanupError) {
      throw cleanupError;
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  runIntegrationTests(process.argv.slice(2)).catch((error) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
    }
  });
}
