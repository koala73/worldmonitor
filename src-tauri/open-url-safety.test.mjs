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

test("every renderer-callable UX and log command requires a trusted window", () => {
  const commands = [
    "list_supported_secret_keys",
    "open_logs_folder",
    "open_sidecar_log_file",
    "open_settings_window_command",
    "close_settings_window",
    "close_live_channels_window",
  ];

  for (const command of commands) {
    const start = mainRs.indexOf(`fn ${command}(`);
    assert.ok(start >= 0, `${command} must remain registered in main.rs`);
    const nextCommand = mainRs.indexOf("#[tauri::command]", start);
    assert.ok(nextCommand >= 0, `${command} must have an explicit command boundary`);
    const body = mainRs.slice(start, nextCommand);
    assert.match(body, /webview: Webview/, `${command} must receive Tauri's calling webview`);
    assert.match(
      body,
      /require_trusted_window\(webview\.label\(\)\)\?/,
      `${command} must reject calls from untrusted windows`,
    );
  }
});
