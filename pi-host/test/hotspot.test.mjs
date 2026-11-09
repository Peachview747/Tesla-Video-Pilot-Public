import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const watcher = fileURLToPath(new URL("../pi-hotspot-watch", import.meta.url));

async function runWatcher(state, radio = "enabled") {
  const root = await mkdtemp(path.join(tmpdir(), "vp-hotspot-test-"));
  const log = path.join(root, "calls");
  await writeFile(log, "");
  await writeFile(path.join(root, "nmcli"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOTSPOT_TEST_LOG"
case "$*" in
  '-g WIFI general') printf '%s\\n' "$HOTSPOT_TEST_RADIO" ;;
  '-g GENERAL.STATE device show wlan0') printf '%s\\n' "$HOTSPOT_TEST_STATE" ;;
  '-g 802-11-wireless.ssid connection show car-hotspot') printf '%s\\n' 'Car test hotspot' ;;
esac
`, {mode:0o755});
  await exec("/bin/sh", [watcher], {env:{...process.env, PATH:root+":"+process.env.PATH,
    HOTSPOT_TEST_LOG:log, HOTSPOT_TEST_STATE:state, HOTSPOT_TEST_RADIO:radio}});
  return readFile(log, "utf8");
}

test("hotspot watcher searches and reconnects when Wi-Fi is disconnected", async () => {
  const calls = await runWatcher("30 (disconnected)");
  assert.match(calls, /device wifi rescan ifname wlan0 ssid Car test hotspot/);
  assert.match(calls, /--wait 20 connection up id car-hotspot ifname wlan0/);
});

test("hotspot watcher leaves connected, activating, and radio-disabled Wi-Fi alone", async () => {
  for (const [state, radio] of [["100 (connected)", "enabled"], ["40 (connecting)", "enabled"], ["30 (disconnected)", "disabled"]]) {
    const calls = await runWatcher(state, radio);
    assert.doesNotMatch(calls, /rescan|connection up/);
  }
});
