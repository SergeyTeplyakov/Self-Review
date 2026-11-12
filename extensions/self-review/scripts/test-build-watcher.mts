import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    AgentReview, Delivery, ReviewService, ReviewSkills, SettingsService, Store, startReviewServer,
} from "../test/modules.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const extensionRoot = path.join(repositoryRoot, "extensions", "self-review");
const webRoot = path.join(extensionRoot, "dist", "web");
const styleFile = path.join(webRoot, "styles.css");
const buildScript = path.join(repositoryRoot, ".build", "extensions", "self-review", "scripts", "build.mjs");

function runBuild() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [buildScript], { cwd: repositoryRoot, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolve(undefined);
            else reject(new Error(`Build failed (${signal ?? code}).`));
        });
    });
}

function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() - startedAt >= timeoutMs) return reject(new Error(message));
            setTimeout(check, 25);
        };
        check();
    });
}

const watcherDataRoot = path.join(repositoryRoot, ".build", "watcher-data");
const store = new Store(watcherDataRoot);
const service = new ReviewService({ store });
const settings = new SettingsService({ store });
const reviewSkills = new ReviewSkills({ store });
const agentReview = new AgentReview({
    service,
    settings,
    reviewSkills,
    sessionId: () => undefined,
    send: async () => { throw new Error("The build watcher must not dispatch agent reviews."); },
});
const delivery = new Delivery({ service, send: async () => "watcher", log: () => {}, reviewIds: () => [] });
delivery.busy = null;
const server = await startReviewServer({
    instanceId: "build-watch-regression",
    getReviewId: () => "build-watch-regression",
    service,
    delivery,
    settings,
    agentReview,
    reviewSkills,
    webRoot,
});
const controller = new AbortController();
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let pump: Promise<void> | undefined;
const events: string[] = [];
let originalStyles: Buffer | undefined;
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
    const renderer = await readFile(path.join(webRoot, "app.js"), "utf8");
    const rendererSource = await readFile(path.join(extensionRoot, "src", "web", "app.ts"), "utf8");
    const rendererMarker = "FOLDER_VIEW_ROW_BUDGET";
    if (!rendererSource.includes(rendererMarker) || !renderer.includes(rendererMarker)) {
        throw new Error("The generated browser asset does not contain the TypeScript renderer.");
    }
    const rendererResponse = await fetch(new URL("app.js", server.url));
    if (!rendererResponse.ok || !(await rendererResponse.text()).includes(rendererMarker)) {
        throw new Error("The server did not serve the generated TypeScript renderer.");
    }
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
    if (stylesTouched && originalStyles) await writeFile(styleFile, originalStyles);
    await runBuild();
    await rm(watcherDataRoot, { recursive: true, force: true });
}
