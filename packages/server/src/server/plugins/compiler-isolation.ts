import type { ChildProcess } from "node:child_process";
import type { PluginBundles } from "./compiler.js";
import { forkSubprocess, terminateSubprocess } from "./subprocess.js";

export interface PluginCompileRequest {
  entryPaths: { client: string | null; server: string | null };
}

export interface PluginCompileFailure {
  name: string;
  message: string;
  stack?: string;
}

export type PluginCompileResponse =
  | { ok: true; bundles: PluginBundles }
  | { ok: false; error: PluginCompileFailure };

const SUBPROCESS_OUTPUT_LIMIT = 4_000;

/**
 * Compile through the compiler subprocess. Boundary traversal parses every reachable file with the
 * TypeScript compiler and resolves each import through synchronous file system calls, so running it
 * on the daemon's loop stalls every connected client until a plugin build finishes. The subprocess
 * owns that work and reports either the bundles or the compiler's own error message.
 */
export async function compilePluginIsolated(
  entryPaths: { client: string | null; server: string | null },
  dependencies: { fork?: () => ChildProcess } = {},
): Promise<PluginBundles> {
  const child = dependencies.fork?.() ?? forkSubprocess("compiler-process", import.meta.url);
  return await new Promise<PluginBundles>((resolve, reject) => {
    let settled = false;
    let output = "";
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const onOutput = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-SUBPROCESS_OUTPUT_LIMIT);
    };
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      child.stderr?.off("data", onOutput);
      finish();
      terminateSubprocess(child);
    };
    const onMessage = (rawMessage: unknown): void => {
      const message = rawMessage as PluginCompileResponse;
      if (message.ok) {
        settle(() => resolve(message.bundles));
        return;
      }
      settle(() => reject(reviveCompileFailure(message.error)));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitStatus = { code, signal };
    };
    // `close` follows the exit and the closed stdio pipes, so the output tail is complete here.
    const onClose = (): void => {
      const { code, signal } = exitStatus ?? { code: null, signal: null };
      settle(() =>
        reject(
          new Error(
            `Plugin compiler subprocess exited before reporting (code=${code}, signal=${signal})${describeOutput(output)}`,
          ),
        ),
      );
    };
    const onError = (error: Error): void =>
      settle(() =>
        reject(
          new Error(`Plugin compiler subprocess could not start: ${error.message}`, {
            cause: error,
          }),
        ),
      );
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onError);
    child.stderr?.on("data", onOutput);
    child.send({ entryPaths } satisfies PluginCompileRequest, (error) => {
      if (error) {
        settle(() =>
          reject(
            new Error(`Plugin compiler subprocess could not receive the request: ${error.message}`),
          ),
        );
      }
    });
  });
}

/** Rebuild the compiler's error in this process, so callers read the message they would see inline. */
function reviveCompileFailure(failure: PluginCompileFailure): Error {
  const error = new Error(failure.message);
  error.name = failure.name;
  if (failure.stack) error.stack = failure.stack;
  return error;
}

function describeOutput(output: string): string {
  const tail = output.trim();
  return tail ? `\n${tail}` : "";
}
