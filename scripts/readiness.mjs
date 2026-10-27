#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Use the built server artifact; no development runtime is needed in a container.
const modulePath = resolve("dist-server/readiness.js");
if (!existsSync(modulePath)) {
  process.stderr.write("Build the server with npm run build before checking readiness.\n");
  process.exitCode = 1;
} else {
  try {
    const { readinessReport } = await import(pathToFileURL(modulePath).href);
    const report = readinessReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.startup_allowed ? 0 : 1;
  } catch (error) {
    // The configuration helpers expose fixed messages without raw input values.
    const recognized = error && ["CEVRALI_RUNTIME_CONFIG", "CEVRALI_STARTUP_BLOCKED"].includes(error.code);
    process.stderr.write(`${recognized ? error.message : "Readiness inspection failed. Check the runtime configuration and mounted files."}\n`);
    process.exitCode = 1;
  }
}
