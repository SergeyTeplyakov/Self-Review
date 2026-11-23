import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run, type Options } from "../scripts/deploy-provider.mjs";

test("deploy, verify and restore preserve data and record manifests", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "self-review-deploy-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const checkout = process.cwd();
    const install = path.join(root, "install");
    const dist = path.join(install, "dist");
    const data = path.join(root, "data");
    const backup = path.join(root, "backup");
    mkdirSync(dist, { recursive: true });
    mkdirSync(path.join(data, "reviews"), { recursive: true });
    writeFileSync(path.join(dist, "version.json"), JSON.stringify({ buildId: "old" }));
    writeFileSync(path.join(dist, "old.txt"), "old");
    writeFileSync(path.join(dist, "__proto__"), "special name");
    writeFileSync(path.join(data, "reviews", "review.json"), "review");
    writeFileSync(path.join(data, "settings.json"), "settings");
    writeFileSync(path.join(data, "lessons.jsonl"), "lesson");
    const options: Options = { operation: "deploy", checkout, install, data, backup, receipt: path.join(root, "deploy.json") };
    await run(options, () => {});
    assert.equal(readFileSync(path.join(backup, "dist", "old.txt"), "utf8"), "old");
    const receipt = JSON.parse(readFileSync(options.receipt, "utf8")) as { buildIdBefore: string; buildIdAfter: string; dataChanged: boolean; dataBefore: unknown; dataAfter: unknown; installedBefore: { files: Record<string, string> } };
    assert.equal(receipt.buildIdBefore, "old");
    assert.notEqual(receipt.buildIdAfter, "old");
    assert.equal(receipt.dataChanged, false);
    assert.match(receipt.installedBefore.files["__proto__"], /^[a-f0-9]{64}$/);
    assert.deepEqual(receipt.dataBefore, receipt.dataAfter);
    assert.equal(readFileSync(path.join(data, "settings.json"), "utf8"), "settings");

    let servedBuild = receipt.buildIdAfter;
    const server = createServer((req, res) => {
        if (req.url !== "/api/state?t=test-token") {
            res.writeHead(403).end();
            return;
        }
        res.end(JSON.stringify({ extensionVersion: { buildId: servedBuild } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/?t=test-token`;
    await run({ ...options, backup: undefined, operation: "verify", receipt: path.join(root, "verify.json"), url });
    servedBuild = "different";
    await assert.rejects(run({ ...options, backup: undefined, operation: "verify", receipt: path.join(root, "provider-mismatch.json"), url }), /Provider build ID mismatch/);
    writeFileSync(path.join(dist, "version.json"), JSON.stringify({ buildId: "different" }));
    await assert.rejects(run({ ...options, backup: undefined, operation: "verify", receipt: path.join(root, "mismatch-version.json"), url }), /hash mismatch/);
    writeFileSync(path.join(dist, "extra"), "tampered");
    await assert.rejects(run({ ...options, backup: undefined, operation: "verify", receipt: path.join(root, "mismatch.json") }), /hash mismatch/);
    await assert.rejects(run({ ...options, operation: "deploy", receipt: path.join(root, "existing.json") }, () => {}), /Backup already exists/);
    await run({ ...options, operation: "restore", receipt: path.join(root, "restore.json") });
    assert.equal(readFileSync(path.join(dist, "old.txt"), "utf8"), "old");
    assert.equal(readFileSync(path.join(data, "reviews", "review.json"), "utf8"), "review");
    servedBuild = "old";
    await run({ ...options, operation: "verify", receipt: path.join(root, "verify-backup.json"), url });
    await assert.rejects(run({ ...options, backup: undefined, operation: "verify", receipt: path.join(root, "verify-checkout.json"), url }), /hash mismatch/);
    for (const damaged of ["missing-version", "malformed-version", "invalid-build-id", "missing-dist"] as const) {
        if (damaged === "missing-dist") rmSync(dist, { recursive: true });
        else if (damaged === "missing-version") rmSync(path.join(dist, "version.json"));
        else writeFileSync(path.join(dist, "version.json"), damaged === "malformed-version" ? "{" : "{}");
        const restoreReceipt = path.join(root, `${damaged}.json`);
        await run({ ...options, operation: "restore", receipt: restoreReceipt });
        const recorded = JSON.parse(readFileSync(restoreReceipt, "utf8")) as { buildIdBefore: string | null; buildIdAfter: string };
        assert.equal(recorded.buildIdBefore, null);
        assert.equal(recorded.buildIdAfter, "old");
        assert.equal(readFileSync(path.join(dist, "old.txt"), "utf8"), "old");
    }
    writeFileSync(path.join(backup, "dist", "old.txt"), "tampered");
    await assert.rejects(run({ ...options, operation: "restore", receipt: path.join(root, "bad-backup.json") }), /Backup hash mismatch/);
    await assert.rejects(run({ ...options, operation: "verify", receipt: path.join(root, "verify-bad-backup.json") }), /Backup hash mismatch/);
    assert.equal(readFileSync(path.join(dist, "old.txt"), "utf8"), "old");
});

test("stale builds and overlapping data paths are refused before installation changes", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "self-review-deploy-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const install = path.join(root, "install");
    mkdirSync(install);
    cpSync(path.join(process.cwd(), "extensions", "self-review", "dist"), path.join(install, "dist"), { recursive: true });
    const options: Options = { operation: "deploy", checkout: process.cwd(), install, data: path.join(root, "data"), backup: path.join(root, "backup"), receipt: path.join(root, "receipt.json") };
    const original = readFileSync(path.join(install, "dist", "version.json"), "utf8");
    await assert.rejects(run(options, () => { throw new Error("Checkout distribution is missing or stale"); }), /stale/);
    assert.equal(readFileSync(path.join(install, "dist", "version.json"), "utf8"), original);
    await assert.rejects(run({ ...options, data: path.join(install, "dist") }), /must not overlap/);
});

test("reports concurrent data changes in the receipt", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "self-review-deploy-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const install = path.join(root, "install");
    const data = path.join(root, "data");
    mkdirSync(install);
    mkdirSync(data);
    cpSync(path.join(process.cwd(), "extensions", "self-review", "dist"), path.join(install, "dist"), { recursive: true });
    const options: Options = { operation: "deploy", checkout: process.cwd(), install, data, backup: path.join(root, "backup"), receipt: path.join(root, "receipt.json") };
    await assert.rejects(run(options, () => { writeFileSync(path.join(data, "settings.json"), "concurrent"); }), /Data directory changed/);
    const receipt = JSON.parse(readFileSync(options.receipt, "utf8")) as { dataChanged: boolean; dataBefore: unknown; dataAfter: unknown };
    assert.equal(receipt.dataChanged, true);
    assert.notDeepEqual(receipt.dataBefore, receipt.dataAfter);
});

test("deploy rejects a distribution stale against checkout sources", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "self-review-freshness-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const checkout = path.join(root, "checkout");
    const install = path.join(root, "install");
    mkdirSync(checkout);
    for (const relative of [
        "extensions/self-review/src", "extensions/self-review/types", "extensions/self-review/web",
        "extensions/self-review/bundled-skills", "extensions/self-review/review-commands", "extensions/self-review/dist",
        "extensions/self-review/tsconfig.node.build.json", "extensions/self-review/tsconfig.web.build.json",
        "tsconfig.node.json", "tsconfig.web.json", "tsconfig.tools.json", ".github/plugin/marketplace.json",
        "node_modules/typescript", "node_modules/@types/node", "node_modules/undici-types",
        "node_modules/@github/copilot-sdk", "extensions/self-review/scripts", "extensions/self-review/test/modules.mts",
    ]) {
        const destination = path.join(checkout, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(process.cwd(), relative), destination, { recursive: true });
    }
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", ["-C", checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "fixture"]);
    mkdirSync(install);
    cpSync(path.join(checkout, "extensions", "self-review", "dist"), path.join(install, "dist"), { recursive: true });
    const css = path.join(checkout, "extensions", "self-review", "web", "styles.css");
    writeFileSync(css, `${readFileSync(css, "utf8")}\n/* changed source */\n`);
    const options: Options = { operation: "deploy", checkout, install, data: path.join(root, "data"), backup: path.join(root, "backup"), receipt: path.join(root, "receipt.json") };
    const original = readFileSync(path.join(install, "dist", "version.json"), "utf8");
    await assert.rejects(run(options), /Checkout distribution is missing or stale/);
    assert.equal(readFileSync(path.join(install, "dist", "version.json"), "utf8"), original);
    assert.match((JSON.parse(readFileSync(options.receipt, "utf8")) as { error: string }).error, /Checkout distribution is missing or stale/);
});
