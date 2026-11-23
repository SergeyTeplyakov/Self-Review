// Run the built renderer against disposable image changes without installing a provider.
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delivery, ReviewService, Store, runGit, startReviewServer } from "../test/modules.mjs";

const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtures = path.join(checkout, "docs", "images");
const tmp = await mkdtemp(path.join(os.tmpdir(), "self-review-images-"));
const repo = path.join(tmp, "demo");
let server: Awaited<ReturnType<typeof startReviewServer>> | undefined;
try {
    await mkdir(repo);
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await copyFile(path.join(fixtures, "configure-light.png"), path.join(repo, "settings.png"));
    await copyFile(path.join(fixtures, "banner-light.png"), path.join(repo, "removed.png"));
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["-c", "user.name=Preview", "-c", "user.email=preview@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "Image preview baseline"]);
    await copyFile(path.join(fixtures, "configure-dark.png"), path.join(repo, "settings.png"));
    await copyFile(path.join(fixtures, "banner-dark.png"), path.join(repo, "added.png"));
    await rm(path.join(repo, "removed.png"));

    const service = new ReviewService({ store: new Store(path.join(tmp, "reviews")) });
    let reviewId = await service.ensureReview({ repoPath: repo, scope: "pending", base: "main", title: "Image diff preview" });
    const delivery = new Delivery({ service, send: async () => { throw new Error("This isolated preview has no agent session."); } });
    server = await startReviewServer({
        instanceId: "image-preview", service, delivery, getReviewId: () => reviewId,
        onReviewChange: (id) => { reviewId = id; }, findPullRequest: async () => null,
        webRoot: path.join(checkout, "extensions", "self-review", "dist", "web"),
    });
    console.log(`Preview: ${server.url}\nSelect settings.png for Before / After. Ctrl+C to stop.`);
    await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} finally {
    await server?.close();
    await rm(tmp, { recursive: true, force: true });
}
