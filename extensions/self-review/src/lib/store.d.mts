import type { SettingsDocument } from "../../types/contracts.js";

export class Store {
    settingsFile(): string;
    readSettings(): Promise<SettingsDocument>;
    updateSettings<T>(mutate: (settings: SettingsDocument) => T | Promise<T>): Promise<T>;
    getInstanceReview(instanceId: string): Promise<string | null>;
    getInstanceContext(instanceId: string): Promise<{ reviewId: string; returnReviewId: string | null } | null>;
    setInstanceReview(instanceId: string, reviewId: string): Promise<void>;
}

export function migrateLegacyDataRoot(): Promise<boolean>;
