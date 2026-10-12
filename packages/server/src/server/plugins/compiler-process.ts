import { compilePlugin } from "./compiler.js";
import type { PluginCompileRequest, PluginCompileResponse } from "./compiler-isolation.js";

/** Report the compiler's outcome, then exit once the message is written to the IPC channel. */
function respond(message: PluginCompileResponse): void {
  const send = process.send?.bind(process);
  if (!send) {
    process.exit(0);
    return;
  }
  send(message, undefined, undefined, () => process.exit(0));
}

function compileFailure(error: unknown): PluginCompileResponse {
  if (error instanceof Error) {
    return { ok: false, error: { name: error.name, message: error.message, stack: error.stack } };
  }
  return { ok: false, error: { name: "Error", message: String(error) } };
}

process.on("message", (rawMessage: unknown) => {
  const request = rawMessage as PluginCompileRequest;
  void compilePlugin(request.entryPaths).then(
    (bundles) => respond({ ok: true, bundles }),
    (error: unknown) => respond(compileFailure(error)),
  );
});

// The parent forks this process for one request and signals it when that request settles. Losing the
// channel means nobody is waiting for the result, so exit instead of idling.
process.on("disconnect", () => process.exit(0));
