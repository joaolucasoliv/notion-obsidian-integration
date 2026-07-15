import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
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

function nodeProcessAdapter() {
  return {
    run(executable, args, options) {
      return new Promise((resolveResult, rejectResult) => {
        let settled = false;
        let totalBytes = 0;
        let stdout = "";
        let stderr = "";
        const child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const failForOutput = () => {
          if (!settled) {
            settled = true;
            child.kill("SIGTERM");
            rejectResult(runnerError("Local subprocess output exceeded the safety limit"));
          }
        };
        const append = (target, chunk) => {
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
          if (!settled) {
            settled = true;
            rejectResult(runnerError("Local subprocess could not start"));
          }
        });
        child.once("close", (code) => {
          if (!settled) {
            settled = true;
            resolveResult({ code: code ?? 1, stdout, stderr });
          }
        });
      });
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
  assertSafeEnvironment(environment);
  const filters = assertSafeFilters(argv, cwd);
  const configToml = options.configToml ?? await readFile(join(cwd, "relay", "supabase", "config.toml"), "utf8");
  assertLocalConfiguration(configToml);
  const localBinaries = options.localBinaries ?? {
    supabase: await resolveLocalBinary(cwd, "supabase"),
    vitest: await resolveLocalBinary(cwd, "vitest"),
  };
  const adapter = options.adapter ?? nodeProcessAdapter();
  const commandOptions = Object.freeze({ cwd, shell: false, maxOutputBytes: MAX_SUBPROCESS_OUTPUT_BYTES });
  let startedHere = false;
  let startAttemptedHere = false;
  let stopPromise = null;
  let receivedSignal = null;

  const stopIfOwned = async () => {
    if (!startedHere && !startAttemptedHere) {
      return;
    }
    stopPromise ??= runChecked(
      adapter,
      localBinaries.supabase,
      ["--workdir", "relay", "stop", "--no-backup"],
      commandOptions,
      "Local Supabase stop",
    );
    await stopPromise;
  };
  const throwIfSignalled = () => {
    if (receivedSignal) {
      throw runnerError(`Local integration tests interrupted by ${receivedSignal}`);
    }
  };
  const removers = ["SIGINT", "SIGTERM"].map((signal) => adapter.onSignal(signal, () => {
    receivedSignal = signal;
    void stopIfOwned();
  }));

  let primaryError = null;
  try {
    let status = await adapter.run(
      localBinaries.supabase,
      ["--workdir", "relay", "status", "--output", "env"],
      commandOptions,
    );
    throwIfSignalled();
    if (status.code !== 0) {
      startAttemptedHere = true;
      await runChecked(adapter, localBinaries.supabase, ["--workdir", "relay", "start"], commandOptions, "Local Supabase start");
      startedHere = true;
      throwIfSignalled();
      status = await runChecked(
        adapter,
        localBinaries.supabase,
        ["--workdir", "relay", "status", "--output", "env"],
        commandOptions,
        "Local Supabase status",
      );
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
    try {
      await stopIfOwned();
    } catch (error) {
      if (!primaryError) {
        throw error;
      }
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
