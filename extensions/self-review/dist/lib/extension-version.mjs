import { isRecord } from "../web/contracts.mjs";
export function parseExtensionVersion(value) {
    if (!isRecord(value)
        || typeof value.version !== "string" || !value.version.trim()
        || typeof value.buildId !== "string" || !/^[a-f0-9]{12}$/.test(value.buildId)) {
        throw new Error("Invalid Self-Review extension version metadata.");
    }
    return { version: value.version, buildId: value.buildId };
}
