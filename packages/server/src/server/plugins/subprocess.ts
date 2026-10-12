import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A forked subprocess entry ships beside the module that forks it: TypeScript from source, built
 * JavaScript from the installed package. The plugin subprocess and the compiler subprocess both
 * launch this way, so a missing build output fails in one place.
 */
export function resolveSubprocessEntryUrl(entryName: string, parentUrl: string): URL {
  return new URL(`${entryName}${parentUrl.endsWith(".ts") ? ".ts" : ".js"}`, parentUrl);
}

/**
 * Source runs need the type stripper and the loader that maps relative `.js` specifiers onto the
 * TypeScript files beside them. The built package forks plain JavaScript and needs neither.
 */
export function resolveSubprocessExecArgv(parentUrl: string): string[] {
  if (!parentUrl.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", parentUrl).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

/**
 * A file entry rejects `--input-type`, which the parent may carry when a probe starts it with
 * `node --input-type=module -e`. Entries are always forked as files, so the flag is dropped here
 * instead of reaching the child.
 */
function withoutInputType(execArgv: string[]): string[] {
  return execArgv.filter(
    (argument) => argument !== "--input-type" && !argument.startsWith("--input-type="),
  );
}

/** Fork a subprocess entry with advanced serialization and an IPC channel for its requests. */
export function forkSubprocess(
  entryName: string,
  parentUrl: string,
  options: ForkOptions = {},
): ChildProcess {
  return fork(fileURLToPath(resolveSubprocessEntryUrl(entryName, parentUrl)), [], {
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    ...options,
    execArgv: withoutInputType(options.execArgv ?? resolveSubprocessExecArgv(parentUrl)),
  });
}

/** The parts of a forked subprocess a parent closes: `ChildProcess` and test fakes both satisfy it. */
export interface TerminableSubprocess {
  connected: boolean;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  disconnect(): void;
}

/** Close a subprocess channel and signal it, so a settled request leaves no process behind. */
export function terminateSubprocess(child: TerminableSubprocess): void {
  if (child.connected) child.disconnect();
  if (!child.killed) child.kill();
}
