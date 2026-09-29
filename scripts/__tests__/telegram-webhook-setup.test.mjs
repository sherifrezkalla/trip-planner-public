import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("webhook registration refuses an omitted installation URL before reading credentials or networking", () => {
  const script = fileURLToPath(new URL("../register-telegram-webhook.sh", import.meta.url));
  const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Supply your own HTTPS webhook URL/);
  assert.doesNotMatch(result.stdout, /Pointing the bot|Webhook registered/);
});
