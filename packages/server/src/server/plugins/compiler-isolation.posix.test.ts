import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePlugin } from "./compiler.js";
import { compilePluginIsolated } from "./compiler-isolation.js";
import { forkSubprocess } from "./subprocess.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** A plugin whose client bundle carries a literal bigger than one process pipe buffer. */
async function createSplitPlugin(): Promise<{ client: string; server: string }> {
  const directory = await createTemporaryDirectory("paseo-plugin-compile-");
  const client = path.join(directory, "index.client.tsx");
  const server = path.join(directory, "index.server.ts");
  const filler = "filler ".repeat(40_000);
  await writeFile(
    client,
    `const filler = ${JSON.stringify(filler)};
export default function contribute() {
  return <span>{filler.slice(0, 6)}</span>;
}
`,
  );
  await writeFile(
    server,
    `export default function contribute() {
  return "Server contribution";
}
`,
  );
  return { client, server };
}

describe("isolated plugin compilation", () => {
  it("reports the bundles the inline compiler produces past one pipe buffer", async () => {
    const entries = await createSplitPlugin();

    const isolated = await compilePluginIsolated(entries);

    expect(isolated).toEqual(await compilePlugin(entries));
    expect(isolated.serverBundle).toContain("Server contribution");
    expect(isolated.clientBundle?.length ?? 0).toBeGreaterThan(64 * 1024);
  }, 30_000);

  it("reports the compiler's own boundary error", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.server,
      `import { Platform } from "react-native";
export default function contribute() {
  return Platform.OS;
}
`,
    );

    await expect(compilePlugin(entries)).rejects.toThrow("client-only module cannot be imported");
    await expect(compilePluginIsolated(entries)).rejects.toThrow(
      "client-only module cannot be imported",
    );
  }, 30_000);

  it("signals the compiler subprocess after a compile settles", async () => {
    const entries = await createSplitPlugin();
    let child: ChildProcess | null = null;

    const bundles = await compilePluginIsolated(entries, {
      fork: () => {
        child = forkSubprocess("compiler-process", import.meta.url);
        return child;
      },
    });

    expect(bundles.serverBundle).toContain("Server contribution");
    expect(child).not.toBeNull();
    expect(child!.connected).toBe(false);
    if (child!.exitCode === null && child!.signalCode === null) await once(child!, "exit");
  }, 30_000);

  it("rejects with the exit status and output when the subprocess exits early", async () => {
    const entries = await createSplitPlugin();
    const directory = await createTemporaryDirectory("paseo-plugin-compiler-exit-");
    const script = path.join(directory, "failing-compiler.mjs");
    await writeFile(
      script,
      `process.on("message", () => {
  process.stderr.write("boundary traversal crashed");
  process.exit(7);
});
`,
    );
    const child = fork(script, [], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });

    await expect(compilePluginIsolated(entries, { fork: () => child })).rejects.toThrow(
      /exited before reporting \(code=7, signal=null\)\nboundary traversal crashed/,
    );
  }, 30_000);

  it("rejects when the compiler subprocess cannot start", async () => {
    const entries = await createSplitPlugin();
    const directory = await createTemporaryDirectory("paseo-plugin-compiler-missing-");

    await expect(
      compilePluginIsolated(entries, {
        fork: () =>
          fork(path.join(directory, "missing-compiler.mjs"), [], {
            execArgv: [],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          }),
      }),
    ).rejects.toThrow(/compiler subprocess/);
  }, 30_000);
});
