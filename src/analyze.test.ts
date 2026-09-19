import { describe, expect, test } from "@effect/vitest";
import { analyze, classifyPath } from "./analyze.ts";

const CWD = "/Users/dev/Code/acme-api";
const HOME = "/Users/dev";
const TMP = "/var/folders/xy/T";

/**
 * Analyze with the standard fixture context.
 *
 * @param command - Command line to analyze
 * @returns The analysis
 */
const run = (command: string) => analyze(command, CWD, HOME, TMP);

/**
 * The resolved program name of the first segment.
 *
 * @param command - Command line to analyze
 * @returns The first segment's `argv0`
 */
const program = (command: string) => run(command).segments[0]?.argv0;

/**
 * The classification of a path in the fixture context.
 *
 * @param path - Path to classify
 * @returns Its `PathClass`
 */
const where = (path: string) => classifyPath(path, CWD, HOME, TMP).class;

describe("argv0 resolution", () => {
  test("does not read rm out of the middle of a word", () => {
    // These were false positives: the model saw the substring `rm`.
    expect(program("transform data")).toBe("transform");
    expect(program("perform action")).toBe("perform");
    expect(program("form submit")).toBe("form");
    expect(program("rmdir empty_folder")).toBe("rmdir");
    expect(program("srm -z file.txt")).toBe("srm");
    expect(program("git-lfs pull")).toBe("git-lfs");
  });

  test("collapses quote-based obfuscation", () => {
    expect(program("rm -rf'' /etc")).toBe("rm");
    expect(run("rm -rf'' /etc").segments[0]?.args).toEqual(["-rf", "/etc"]);
  });

  test("reports an unterminated quote instead of inventing a parse", () => {
    // The quote never closes, so reporting an incomplete parse beats guessing.
    expect(run("rm -r'f /").parsedCleanly).toBe(false);
  });

  test("strips wrappers and leading directories", () => {
    expect(program("/usr/bin/git reset --hard")).toBe("git");
    expect(program("env git reset --hard")).toBe("git");
    expect(program("sudo git reset --hard")).toBe("git");
    expect(program("time rm -rf build")).toBe("rm");
    expect(program("FOO=bar BAZ=qux git status")).toBe("git");
  });

  test("sees through groupings and control flow", () => {
    expect(program("(chmod -R 755 /etc)")).toBe("chmod");
    expect(program("( chmod -R 755 /etc )")).toBe("chmod");
    expect(program("if true; then chmod -R 755 /etc; fi")).toBe("true");
    expect(
      run("if true; then chmod -R 755 /etc; fi").segments.map((s) => s.argv0),
    ).toContain("chmod");
  });

  test("splits compound commands", () => {
    const a = run("chown user /var/log/app.log; cp -R src /opt/app");
    expect(a.segments.map((s) => s.argv0)).toEqual(["chown", "cp"]);

    const b = run("chmod 600 /root/.ssh/x && grep -rn foo /etc/ssh/");
    expect(b.segments.map((s) => s.argv0)).toEqual(["chmod", "grep"]);
  });
});

describe("path classification", () => {
  test("recognizes unix temp", () => {
    expect(where("/tmp/build")).toBe("temp");
    expect(where("/var/tmp/x")).toBe("temp");
    expect(where("$TMPDIR/build")).toBe("temp");
    expect(where("${TMPDIR}/build")).toBe("temp");
    expect(where("${TMPDIR:-/tmp}/build")).toBe("temp");
  });

  test("recognizes common Windows temp path forms", () => {
    expect(where("C:\\Users\\u\\AppData\\Local\\Temp\\some\\file")).toBe("temp");
    expect(where("c:\\users\\u\\appdata\\local\\TEMP\\x")).toBe("temp");
    expect(where("C:/Users/u/AppData/Local/Temp/scratch")).toBe("temp");
    expect(where("/c/Users/u/AppData/Local/Temp/some/subdir/file")).toBe("temp");
    expect(where("/C/users/U/appdata/local/temp/x")).toBe("temp");
  });

  test("does not let .. escape temp unnoticed", () => {
    // This path climbs out of Temp into Documents.
    expect(where("C:\\Users\\u\\AppData\\Local\\Temp\\..\\..\\Documents")).not.toBe(
      "temp",
    );
  });

  test("separates system, root, home, and project paths", () => {
    expect(where("/etc/passwd")).toBe("system");
    expect(where("/usr/local/bin")).toBe("system");
    expect(where("/")).toBe("filesystem-root");
    expect(where("~")).toBe("home-root");
    expect(where("/Users/dev")).toBe("home-root");
    expect(where("~/Documents/a.txt")).toBe("home");
    expect(where("/Users/dev/Code/acme-api/src")).toBe("inside-working-directory");
    expect(where("./src")).toBe("relative");
  });

  test("flags paths it cannot resolve rather than guessing", () => {
    expect(where("$UNKNOWN_VAR/build")).toBe("unresolved-variable");
    expect(where("https://example.com/x")).toBe("remote");
    expect(where("user@host:/srv")).toBe("remote");
  });
});

describe("substitutions and heredocs", () => {
  test("surfaces commands hidden in substitutions", () => {
    expect(run("echo `git reset --hard`").substitutions).toContain(
      "git reset --hard",
    );
    expect(run("echo `rm -rf /home`").substitutions).toContain("rm -rf /home");
    expect(run("env -C `rm -rf /home/user` git status").substitutions).toContain(
      "rm -rf /home/user",
    );
  });

  test("separates heredoc bodies from the command", () => {
    const a = run("cat <<EOF\ngit reset --hard\nEOF");
    expect(a.segments[0]?.argv0).toBe("cat");
    expect(a.heredocs[0]?.body).toBe("git reset --hard");
    expect(a.heredocs[0]?.quoted).toBe(false);

    const b = run("python3 - <<'PY'\ngit branch $name\nPY");
    expect(b.heredocs[0]?.quoted).toBe(true);
    expect(b.heredocs[0]?.consumer).toBe("python3");
  });

  test("a heredoc body does not become a command segment", () => {
    const a = run("tee /tmp/docs.txt <<EOF\nrm -rf /home/user\nEOF");
    expect(a.segments.map((s) => s.argv0)).toEqual(["tee"]);
  });
});

describe("statically unresolvable detection", () => {
  test("flags targets that depend on runtime expansion", () => {
    expect(run("rm -rf $TMPDIR/build").staticallyUnresolvable).toBe(true);
    expect(run("rm -rf ${TMPDIR}/build").staticallyUnresolvable).toBe(true);
    expect(run("rm -rf ${TMPDIR:-/tmp}/build").staticallyUnresolvable).toBe(true);
    expect(run('rm -rf "$TMPDIR/build"').staticallyUnresolvable).toBe(true);
    expect(run("/* -D main").staticallyUnresolvable).toBe(true);
    expect(run("$(producer) branch -d feature").staticallyUnresolvable).toBe(true);
    expect(run('mv "$HOME/Documents/a" ~/Documents/b').staticallyUnresolvable).toBe(true);
  });

  test("a variable path stays flagged even when it resolves somewhere benign", () => {
    // $TMPDIR resolves to a temp dir on this machine and to anywhere at all on
    // another. The classification is still `temp`; the flag is what matters.
    const path = run("rm -rf $TMPDIR/build").segments[0]?.paths[0];
    expect(path?.class).toBe("temp");
    expect(path?.variableRooted).toBe(true);
  });

  test("does not flag fully determined commands", () => {
    expect(run("rm -rf ./build").staticallyUnresolvable).toBe(false);
    expect(run("git reset --hard HEAD~3").staticallyUnresolvable).toBe(false);
    expect(run("rm -rf /tmp/build").staticallyUnresolvable).toBe(false);
    expect(run("chmod -R 755 /etc").staticallyUnresolvable).toBe(false);
  });
});
