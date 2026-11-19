import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function readDistributionText(file: string): string {
    const bytes = readFileSync(file);
    const content = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(content, "utf8").equals(bytes)) {
        throw new Error(`Distribution asset is not UTF-8 text: ${file}`);
    }
    return content;
}

export function normalizeDistributionLineEndings(files: readonly string[]): void {
    for (const file of files) {
        const content = readDistributionText(file);
        const normalized = content.replace(/\r\n?/g, "\n");
        if (content !== normalized) writeFileSync(file, normalized);
    }
}

export function distributionBuildId(distributionRoot: string, files: readonly string[]): string {
    const orderedFiles = files
        .map((file) => ({
            file,
            relativePath: path.relative(distributionRoot, file).split(path.sep).join("/"),
        }))
        .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);

    const hash = createHash("sha256");
    for (const { file, relativePath } of orderedFiles) {
        hash.update(relativePath).update("\0");
        hash.update(readDistributionText(file).replace(/\r\n?/g, "\n")).update("\0");
    }
    return hash.digest("hex").slice(0, 12);
}
