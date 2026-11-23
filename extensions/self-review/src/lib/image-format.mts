export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
export type ImageExtension = keyof typeof IMAGE_TYPES;
// imageType reads no further than this.
export const IMAGE_SIGNATURE_BYTES = 12;
// Diff previews also show SVG, which comment images do not accept.
export const DIFF_IMAGE_TYPES = { ...IMAGE_TYPES, svg: "image/svg+xml" } as const;
export type DiffImageType = keyof typeof DIFF_IMAGE_TYPES;
// The <svg> root must start within this many bytes, after any XML declaration, comments, and DOCTYPE.
export const SVG_PROLOG_BYTES = 8 * 1024;
// diffImageType reads no further than this.
export const DIFF_IMAGE_SNIFF_BYTES = Math.max(IMAGE_SIGNATURE_BYTES, SVG_PROLOG_BYTES);

export function imagePath(name: string | null) {
    return name !== null && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(name);
}

export function diffImageType(bytes: Buffer): DiffImageType | undefined {
    return imageType(bytes) ?? (isSvg(bytes) ? "svg" : undefined);
}

// Accepts a document whose root element is <svg>. A scan rather than a regular expression, so that crafted
// prologs cannot make it backtrack.
export function isSvg(bytes: Buffer) {
    const text = bytes.toString("utf8", 0, Math.min(bytes.length, SVG_PROLOG_BYTES));
    let pos = text.startsWith("\uFEFF") ? 1 : 0;
    for (;;) {
        while (" \t\r\n".includes(text[pos] ?? "x")) pos++;
        let close: number;
        let skip: number;
        if (text.startsWith("<?", pos)) {
            [close, skip] = [text.indexOf("?>", pos + 2), 2];
        } else if (text.startsWith("<!--", pos)) {
            [close, skip] = [text.indexOf("-->", pos + 4), 3];
        } else if (text.startsWith("<!DOCTYPE", pos)) {
            // An internal subset in brackets may contain ">".
            const gt = text.indexOf(">", pos);
            const bracket = text.indexOf("[", pos);
            const from = bracket >= 0 && (gt < 0 || bracket < gt) ? text.indexOf("]", bracket) : pos;
            [close, skip] = [from < 0 ? -1 : text.indexOf(">", from), 1];
        } else {
            return /^<svg[\s/>]/.test(text.slice(pos, pos + 5));
        }
        if (close < 0) return false;
        pos = close + skip;
    }
}

export function imageType(bytes: Buffer): ImageExtension | undefined {
    if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "jpg";
    if (["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) return "gif";
    if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
}
