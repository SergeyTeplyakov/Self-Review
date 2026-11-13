import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-process.mjs";
import type { Log } from "../../types/contracts.js";
import type { ReviewService } from "./review-service.mjs";

const DEBOUNCE_MS = 350;
const gitInput = (name: string) => !name.endsWith(".lock")
    && (/^(HEAD|index|packed-refs|config|shallow|info\/exclude)$/.test(name) || name.startsWith("refs/")
        || (name.startsWith("modules/") && (/\/(HEAD|index|packed-refs|config|shallow|info\/exclude)$/.test(name) || name.includes("/refs/"))));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type WatchDirectory = (root: string, changed: (file: string | null) => void, failed: (error: Error) => void) => Pick<FSWatcher, "close">;
const createDirectoryWatcher: WatchDirectory = (root, changed, failed) => {
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => changed(file?.toString() ?? null));
    watcher.on("error", failed);
    return watcher;
};

// Each open panel owns one watcher; switching reviews or closing the panel releases it.
export class ReviewWatcher {
    private watchers: Array<Pick<FSWatcher, "close">> = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private generation = 0;
    private reviewId: string | null = null;
    private candidates = new Map<string, { file: string; git: boolean }>();
    private closed = false;
    private running: Promise<void> = Promise.resolve();

    constructor(
        private readonly service: Pick<ReviewService, "getReview" | "refresh">,
        private readonly log: Log,
        private readonly debounceMs = DEBOUNCE_MS,
        private readonly watchDirectory: WatchDirectory = createDirectoryWatcher,
    ) {}

    async setReview(reviewId: string): Promise<void> {
        if (this.closed || this.reviewId === reviewId) return;
        this.release();
        this.reviewId = reviewId;
        const generation = this.generation;
        const signatures = new Map<string, string>();
        try {
            const review = await this.service.getReview(reviewId);
            const inventory = async () => {
                const result = await runGit(review.repoRoot, ["ls-files", "--stage", "--cached", "--others", "--exclude-standard", "-z"]);
                const files = new Set<string>();
                const submodules = new Set<string>();
                for (const entry of result.stdout.split("\0").filter(Boolean)) {
                    const staged = /^(\d{6}) [0-9a-f]+ [0-3]\t([\s\S]*)$/.exec(entry);
                    const file = staged ? staged[2] : entry;
                    files.add(file);
                    if (staged?.[1] === "160000") submodules.add(file);
                }
                return { files, submodules };
            };
            const [dirs, initialFiles] = await Promise.all([
                runGit(review.repoRoot, ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"]),
                inventory(),
            ]);
            let known = initialFiles;
            if (generation !== this.generation || this.closed) return;
            const add = (root: string, metadata: boolean) => {
                const watcher = this.watchDirectory(root, (filename) => {
                    if (generation !== this.generation || this.closed) return;
                    const file = filename?.replace(/\\/g, "/") ?? "";
                    if (metadata ? file && !gitInput(file) : file.split("/").includes(".git")) return;
                    const absolute = path.join(root, file);
                    this.candidates.set(absolute, { file, git: metadata });
                    clearTimeout(this.timer);
                    this.timer = setTimeout(() => {
                        this.timer = undefined;
                        const candidates = this.candidates;
                        this.candidates = new Map();
                        // Serialize checks as well as refreshes: read notifications must not race signature updates.
                        this.running = this.running.then(async () => {
                            if (generation !== this.generation || this.closed) return;
                            let relevant = false;
                            let rescan = false;
                            const changedPaths: string[] = [];
                            for (const [absolute, candidate] of candidates) {
                                if (!candidate.file) {
                                    relevant = true;
                                    rescan = true;
                                    continue;
                                }
                                const signature = await lstat(absolute).then(
                                    (s) => candidate.git && s.isDirectory() ? null : `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.mode}:${s.ino}`,
                                    (error: NodeJS.ErrnoException) => {
                                        if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing";
                                        throw error;
                                    },
                                );
                                if (signature === null || signatures.get(absolute) === signature) continue;
                                signatures.set(absolute, signature);
                                if (candidate.git) {
                                    relevant = true;
                                    continue;
                                }
                                changedPaths.push(candidate.file);
                            }
                            if (changedPaths.length || rescan) {
                                // One Git process per burst, even during a large build. Keep the old inventory
                                // too, so deleting an untracked reviewed file still triggers a refresh.
                                const next = await inventory();
                                const matches = (file: string) => changedPaths.some((name) => file === name || file.startsWith(`${name}/`));
                                if ([...known.files, ...next.files].some(matches)
                                    || [...known.submodules, ...next.submodules].some((file) => changedPaths.some((name) => name.startsWith(`${file}/`)))) relevant = true;
                                known = next;
                            }
                            if (relevant && generation === this.generation && !this.closed) await this.service.refresh(reviewId);
                        }).catch((error: unknown) => this.warn(error));
                    }, this.debounceMs);
                    this.timer.unref();
                }, (error) => {
                    this.warn(error);
                    watcher.close();
                });
                this.watchers.push(watcher);
            };
            add(review.repoRoot, false);
            for (const dir of new Set(dirs.stdout.trim().split(/\r?\n/))) add(dir, true);
            // Close the capture-to-watch gap, using the existing coalesced refresh.
            await this.service.refresh(reviewId);
        } catch (error) {
            if (generation === this.generation) {
                this.release();
                this.warn(error);
            }
        }
    }

    private warn(error: unknown): void {
        this.log(`self-review: automatic refresh unavailable: ${message(error)}. Manual Refresh remains available.`, "warning");
    }

    private release(): void {
        this.generation++;
        clearTimeout(this.timer);
        this.timer = undefined;
        for (const watcher of this.watchers) watcher.close();
        this.watchers = [];
        this.candidates.clear();
        this.reviewId = null;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.release();
        await this.running;
    }
}
