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
const defaultCapability = readFileSync(new URL("./capabilities/default.json", import.meta.url), "utf8");
const rendererSources = [
  new URL("../src/services/runtime.ts", import.meta.url),
  new URL("../src/services/runtime-config.ts", import.meta.url),
  new URL("../src/settings-main.ts", import.meta.url),
].map((url) => readFileSync(url, "utf8"));

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

test("renderer IPC cannot read the sidecar bearer token or the secret cache (GHSA-5458)", () => {
  for (const command of ["get_local_api_token", "get_secret", "get_all_secrets"]) {
    assert.ok(
      !mainRs.includes(`fn ${command}(`),
      `${command} must not be a renderer-callable Tauri command (GHSA-5458).`,
    );
    assert.ok(
      !mainRs.includes(`            ${command},`),
      `${command} must not be registered in Tauri's invoke handler (GHSA-5458).`,
    );
  }
  for (const source of rendererSources) {
    for (const command of ["get_local_api_token", "get_secret", "get_all_secrets"]) {
      assert.ok(!source.includes(command), `renderer source must not invoke ${command} (GHSA-5458).`);
    }
  }
  const runtimeConfig = rendererSources[1];
  assert.ok(
    runtimeConfig.includes("runtimeConfig.secrets[key as RuntimeSecretKey] = { source: 'vault' }"),
    'desktop vault state must remain metadata-only (no renderer plaintext value).',
  );
});

test("only the main window receives the default Tauri capability (GHSA-5458)", () => {
  assert.match(defaultCapability, /"windows": \["main"\]/);
  assert.ok(
    !defaultCapability.includes('"settings"') && !defaultCapability.includes('"live-channels"'),
    "settings and live-channels must not inherit the main window's default capability.",
  );
});

test("native sidecar proxy blocks secret-management routes (GHSA-5458)", () => {
  const proxyStart = mainRs.indexOf("fn proxy_local_api_request(");
  assert.ok(proxyStart >= 0, "native sidecar proxy command must be present");
  const proxyEnd = mainRs.indexOf("#[tauri::command]", proxyStart + 1);
  const proxyBody = mainRs.slice(proxyStart, proxyEnd);
  assert.match(proxyBody, /require_secret_management_window\(webview\.label\(\)\)\?/);
  for (const route of ["/api/local-env-update", "/api/local-env-update-batch", "/api/local-validate-secret"]) {
    assert.ok(mainRs.includes(route), `native proxy must reject ${route}`);
  }
});
