import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Regression guard for GHSA-2x6r-qq54-mmhr — Windows OS command injection via
 * the `open_url` Tauri IPC command.
 *
 * The old Windows branch of `open_in_shell` ran `cmd /c start "" <url>` with the
 * URL UNQUOTED. Rust's std only quotes an argument containing whitespace, and a
 * URL has none, so `cmd.exe` parsed `&`/`|`/etc. in an attacker-controlled feed
 * link as command separators — arbitrary command execution on a single click.
 *
 * The fix routes all URL/path opening through the `opener` crate, which on
 * Windows calls `ShellExecuteW(NULL, "open", <wide-string>, …)`: the target is
 * a single Win32 argument handed to the registered protocol handler, never a
 * shell command line. This test asserts the sink cannot come back.
 */
const mainRs = readFileSync(new URL("./src/main.rs", import.meta.url), "utf8");

test("open_in_shell never spawns cmd.exe (GHSA-2x6r)", () => {
  assert.ok(
    !mainRs.includes('Command::new("cmd")'),
    'src-tauri/src/main.rs must not spawn cmd.exe — routing a URL through ' +
      '`cmd /c start` is an OS command-injection sink (GHSA-2x6r).',
  );
});

test("open_in_shell opens URLs/paths via the opener crate (ShellExecuteW on Windows)", () => {
  assert.ok(
    mainRs.includes("opener::open"),
    "open_in_shell should delegate to opener::open, which uses ShellExecuteW " +
      "on Windows (no shell interpretation of the URL).",
  );
});
