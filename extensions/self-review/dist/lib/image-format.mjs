export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export function imagePath(name) {
    return name !== null && /\.(?:png|jpe?g|gif|webp)$/i.test(name);
}
export function imageType(bytes) {
    if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
        return "png";
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff")
        return "jpg";
    if (["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6)))
        return "gif";
    if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
        return "webp";
}
