// Shared by the Node provider and browser. No Node or SDK imports here.
export type LearningMode = "off" | "suggest" | "auto";
export type DeliveryMode = "immediate" | "batch" | "ask";
export type DeliveryChoice = Exclude<DeliveryMode, "ask"> | null;
export type ReviewScope = "all" | "pending";
export type ReviewFocus = "review" | "simplify" | "both";

export interface AgentReviewOptions {
    models: string[];
    focus: ReviewFocus;
    intent: string;
    skillNames?: string[];
}

export interface AgentReviewDefaults extends AgentReviewOptions {
    skipDialog: boolean;
}

export interface RepoSettings {
    repoName: string;
    learning: LearningMode;
    delivery: DeliveryMode;
    configured: boolean;
    dismissed: boolean;
}

export interface SettingsPatch {
    learning?: LearningMode;
    delivery?: DeliveryMode;
    dismissed?: boolean;
}

// Historical files may lack delivery, and invalid mode strings are ignored when read.
export interface StoredRepoSettings {
    learning?: unknown;
    delivery?: unknown;
    promptDismissed?: unknown;
    name?: string;
    updatedAt?: string;
    [key: string]: unknown;
}

export interface SettingsDocument {
    version?: number;
    repos: Record<string, StoredRepoSettings>;
    // Validate saved reviewer choices when used, so corrupt defaults don't hide repo settings.
    agentReview?: unknown;
    [key: string]: unknown;
}

export interface SettingsStore {
    readSettings(): Promise<SettingsDocument>;
    updateSettings<T>(mutate: (settings: SettingsDocument) => T | Promise<T>): Promise<T>;
}

export interface GitRunner {
    runGit(cwd: string, args: string[], options?: { allowFail?: boolean }): Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
    }>;
}

export interface SettingsState {
    settings: RepoSettings | null;
    agentReviewSettings: AgentReviewDefaults | null;
    agentReviewSettingsAvailable: boolean;
    agentReviewSettingsError?: string;
}

export interface SettingsRequests {
    settings: SettingsPatch;
    "agent-review-settings": { defaults: AgentReviewDefaults | null };
}

export interface SettingsResponses {
    settings: RepoSettings;
    "agent-review-settings": AgentReviewDefaults | null;
}

export type SettingsTransport = <K extends keyof SettingsRequests>(
    method: "POST", path: K, body: SettingsRequests[K]
) => Promise<unknown>;

export type Log = (message: string, level?: "info" | "warning" | "error") => void;
