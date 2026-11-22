import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReviewError } from "../web/contracts.mjs";
import type { Store } from "./store.mjs";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 4;
const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
type Extension = keyof typeof TYPES;

function imageType(bytes: Buffer): Extension | undefined {
    if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "jpg";
    if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
}

function imageLocation(store: Store, reviewId: string, id: string) {
    const extension = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/.exec(id)?.[2] as Extension | undefined;
    if (!extension) throw new ReviewError("invalid_input", "Invalid comment image reference.");
    return { file: path.join(store.reviewDir(reviewId), "comment-images", id), mimeType: TYPES[extension] };
}

export async function saveCommentImage(store: Store, reviewId: string, bytes: Buffer) {
    const type = imageType(bytes);
    if (!type || bytes.length > MAX_IMAGE_BYTES) throw new ReviewError("invalid_input", "Paste a PNG, JPEG, GIF, or WebP image up to 2 MB.");
    const id = `${createHash("sha256").update(bytes).digest("hex")}.${type}`;
    const { file } = imageLocation(store, reviewId, id);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
    return id;
}

export async function readCommentImage(store: Store, reviewId: string, id: string) {
    const { file, mimeType } = imageLocation(store, reviewId, id);
    try {
        return { bytes: await readFile(file), mimeType };
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            throw new ReviewError("not_found", "A comment image is missing. Remove it and paste it again.");
        }
        throw error;
    }
}

export const commentImagePath = (store: Store, reviewId: string, id: string) => imageLocation(store, reviewId, id).file;

export async function commentImageIds(store: Store, reviewId: string, input: unknown): Promise<string[]> {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > MAX_IMAGES || !input.every((id): id is string => typeof id === "string")) {
        throw new ReviewError("invalid_input", `A comment can attach up to ${MAX_IMAGES} images.`);
    }

    const ids = [...new Set(input)];
    await Promise.all(ids.map((id) => readCommentImage(store, reviewId, id)));
    return ids;
}

export async function checkBatchImageBudget(store: Store, reviewId: string, images: Iterable<string>) {
    let total = 0;
    const sizes = new Map<string, number>();
    for (const id of images) {
        let size = sizes.get(id);
        if (size === undefined) {
            size = (await stat(imageLocation(store, reviewId, id).file)).size;
            sizes.set(id, size);
        }
        total += size;
        if (total > MAX_BATCH_IMAGE_BYTES) {
            throw new ReviewError("invalid_input", "This review exceeds the 16 MB total image limit. Send some comments individually, then submit the remaining drafts.");
        }
    }
}
