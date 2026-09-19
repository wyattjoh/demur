import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  getDemurConfigPath,
  loadDemurSettings,
  parseFailurePolicy,
  saveDemurSettings,
} from "./settings.ts";

describe("Pi settings configuration", () => {
  it("resolves the XDG config path with a home-directory fallback", () => {
    assert.strictEqual(
      getDemurConfigPath(
        { XDG_CONFIG_HOME: "/config" },
        "/home/test",
      ),
      "/config/demur/config.json",
    );
    assert.strictEqual(
      getDemurConfigPath({}, "/home/test"),
      "/home/test/.config/demur/config.json",
    );
  });

  it("defaults safely and atomically persists selected settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-config-"));
    const configPath = join(directory, "nested", "config.json");

    assert.deepEqual(await loadDemurSettings(configPath), {
      enabled: true,
      failurePolicy: "block",
    });
    await saveDemurSettings(
      { enabled: false, failurePolicy: "ask" },
      configPath,
    );
    assert.deepEqual(await loadDemurSettings(configPath), {
      enabled: false,
      failurePolicy: "ask",
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      version: 1,
      enabled: false,
      failurePolicy: "ask",
    });
  });

  it("treats an earlier config without enabled as enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-config-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, failurePolicy: "allow" }),
      "utf8",
    );

    assert.deepEqual(await loadDemurSettings(configPath), {
      enabled: true,
      failurePolicy: "allow",
    });
  });

  it("rejects malformed persisted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-config-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, failurePolicy: "deny" }),
      "utf8",
    );

    let failure: unknown;
    try {
      await loadDemurSettings(configPath);
    } catch (error: unknown) {
      failure = error;
    }

    assert.instanceOf(failure, Error);
    assert.match(failure.message, /invalid demur config/);
  });

  it("parses only supported command arguments", () => {
    assert.strictEqual(parseFailurePolicy(" ASK "), "ask");
    assert.strictEqual(parseFailurePolicy("allow"), "allow");
    assert.strictEqual(parseFailurePolicy("deny"), undefined);
  });
});
