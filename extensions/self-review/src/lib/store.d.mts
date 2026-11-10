import type { SettingsDocument } from "../../types/contracts.js";

export class Store {
    settingsFile(): string;
    readSettings(): Promise<SettingsDocument>;
    updateSettings<T>(mutate: (settings: SettingsDocument) => T | Promise<T>): Promise<T>;
    getInstanceReview(instanceId: string): Promise<string | null>;
    setInstanceReview(instanceId: string, reviewId: string): Promise<void>;
}

export function migrateLegacyDataRoot(): Promise<boolean>;
