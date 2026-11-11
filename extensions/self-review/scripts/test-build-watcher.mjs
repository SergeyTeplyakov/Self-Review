import { EventEmitter } from "node:events";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startReviewServer } from "../dist/lib/server.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(extensionRoot, "..", "..");
const webRoot = path.join(extensionRoot, "dist", "web");
const styleFile = path.join(webRoot, "styles.css");
const buildScript = path.join(extensionRoot, "scripts", "build.mjs");

function runBuild() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [buildScript], { cwd: repositoryRoot, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Build failed (${signal ?? code}).`));
        });
    });
}

function waitFor(predicate, message, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() - startedAt >= timeoutMs) return reject(new Error(message));
            setTimeout(check, 25);
        };
        check();
    });
}

const service = new EventEmitter();
const delivery = new EventEmitter();
delivery.busy = null;
const server = await startReviewServer({
    instanceId: "build-watch-regression",
    getReviewId: () => "build-watch-regression",
    service,
    delivery,
    webRoot,
});
const controller = new AbortController();
let reader;
let pump;
let events = [];
let originalStyles;
let stylesTouched = false;

try {
    const eventsUrl = new URL(server.url);
    eventsUrl.pathname = "/api/events";
    const response = await fetch(eventsUrl, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Could not connect to asset events (${response.status}).`);
    reader = response.body.getReader();
    pump = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const event = /^event: ([^\r\n]+)/m.exec(frame)?.[1];
                if (event) events.push(event);
            }
        }
    })();

    await waitFor(() => events.includes("hello"), "Canvas SSE hello was not received.");
    await runBuild();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const previousAssetEvents = events.filter((event) => event === "assets").length;
    originalStyles = await readFile(styleFile);
    await appendFile(styleFile, "\n");
    stylesTouched = true;
    await waitFor(
        () => events.filter((event) => event === "assets").length > previousAssetEvents,
        "The open canvas did not report an asset change after a build.",
    );
    console.log("Verified asset hot reload remains active after rebuilding the watched distribution.");
} finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await server.close();
    await pump?.catch(() => {});
    if (stylesTouched) await writeFile(styleFile, originalStyles);
    await runBuild();
}
