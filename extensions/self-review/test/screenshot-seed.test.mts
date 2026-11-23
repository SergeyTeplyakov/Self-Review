import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test("the screenshot fixture saves its demo repository lessons", async () => {
    const script = fileURLToPath(new URL("../../../docs/screenshots/render.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [path.normalize(script), "--check-seed"], { timeout: 60_000 });
    assert.match(stdout, /Screenshot fixture lessons saved/);
});
