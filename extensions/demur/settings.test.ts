import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  getDemurConfigPath,
  loadDemurSettings,
  parseDemurMode,
  parseFailurePolicy,
  saveDemurSettings,
} from "./settings.ts";

describe("Pi settings configuration", () => {
  it("resolves the XDG config path with a home-directory fallback", () => {
    assert.strictEqual(
      getDemurConfigPath(
        {
          DEMUR_CONFIG_HOME: "/isolated/demur-config",
          XDG_CONFIG_HOME: "/config",
        },
        "/home/test",
      ),
      "/isolated/demur-config/config.json",
    );
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
      mode: "enforce",
      training: false,
      failurePolicy: "block",
    });
    await saveDemurSettings(
      { mode: "passive", training: true, failurePolicy: "ask" },
      configPath,
    );
    assert.deepEqual(await loadDemurSettings(configPath), {
      mode: "passive",
      training: true,
      failurePolicy: "ask",
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      version: 2,
      mode: "passive",
      training: true,
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
      mode: "enforce",
      training: false,
      failurePolicy: "allow",
    });
  });

  it("rejects malformed persisted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-config-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        mode: "disabled",
        training: true,
        failurePolicy: "block",
      }),
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

  it("does not persist training while disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-config-"));
    const configPath = join(directory, "config.json");

    let failure: unknown;
    try {
      await saveDemurSettings(
        { mode: "disabled", training: true, failurePolicy: "block" },
        configPath,
      );
    } catch (error: unknown) {
      failure = error;
    }

    assert.instanceOf(failure, Error);
    assert.include(failure.message, "training cannot be enabled");
  });

  it("parses only supported command arguments", () => {
    assert.strictEqual(parseDemurMode(" PASSIVE "), "passive");
    assert.strictEqual(parseDemurMode("enabled"), undefined);
    assert.strictEqual(parseFailurePolicy(" ASK "), "ask");
    assert.strictEqual(parseFailurePolicy("allow"), "allow");
    assert.strictEqual(parseFailurePolicy("deny"), undefined);
  });
});
