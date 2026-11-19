import { isRecord } from "../web/contracts.mjs";

export interface ExtensionVersion {
    version: string;
    buildId: string;
}

export function parseExtensionVersion(value: unknown): ExtensionVersion {
    if (!isRecord(value)
        || typeof value.version !== "string" || !value.version.trim()
        || typeof value.buildId !== "string" || !/^[a-f0-9]{12}$/.test(value.buildId)) {
        throw new Error("Invalid Self-Review extension version metadata.");
    }
    return { version: value.version, buildId: value.buildId };
}
