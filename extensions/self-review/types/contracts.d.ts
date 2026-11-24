// Shared by the Node provider and browser. No Node or SDK imports here.
export type DeliveryMode = "immediate" | "batch" | "ask";
export type DeliveryChoice = Exclude<DeliveryMode, "ask"> | null;
export type ReviewScope = "all" | "pending";
export type ReviewFocus = "review" | "simplify" | "both";

export interface InstructionMapping {
    pathPrefix: string;
    instructionRoot: string;
    splitLanguageSpecific: boolean;
}

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
    autoSaveLearnedRules: boolean;
    delivery: DeliveryMode;
    instructionMappings: InstructionMapping[];
    pathCaseSensitive?: boolean;
    commentConcurrency?: number;
    configured: boolean;
    dismissed: boolean;
}

export interface SettingsPatch {
    autoSaveLearnedRules?: boolean;
    delivery?: DeliveryMode;
    commentConcurrency?: number;
    dismissed?: boolean;
    instructionMappings?: InstructionMapping[];
    expectedInstructionMappings?: InstructionMapping[];
}

// Historical files may lack delivery, and invalid mode strings are ignored when read.
export interface StoredRepoSettings {
    autoSaveLearnedRules?: unknown;
    learning?: unknown;
    delivery?: unknown;
    commentConcurrency?: unknown;
    promptDismissed?: unknown;
    instructionMappings?: unknown;
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
    lock<T>(key: string, action: () => Promise<T>): Promise<T>;
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

export type PullRequestState = "open" | "merged" | "closed";

// The branch's pull request as reported by GitHub CLI; validated before it is stored or shown.
export interface PullRequestInfo {
    number: number;
    url: string;
    state: PullRequestState;
    baseRefName: string | null;
    headRefOid: string | null;
    mergedAt: string | null;
    closedAt: string | null;
    mergeCommitOid: string | null;
}

// error is set when the latest lookup failed; pullRequest is then the last known result, possibly stale.
export interface PullRequestStatus {
    checkedAt: string | null;
    error: string | null;
    commitsAfterHead: number | null;
}

// How an "all changes" diff left out work a merged pull request delivered:
// separated: the diff starts at the PR head; in-base: the base already contains it;
// unavailable: the PR head commit is not in the local repository; not-in-branch: HEAD does not contain the PR head.
export type DeliveredSeparation = "separated" | "in-base" | "unavailable" | "not-in-branch";

export interface ReviewCompletion {
    pullRequest: PullRequestInfo;
    completedAt: string;
    // Threads moved to history by this completion; their status is left as it was.
    archivedThreadIds: string[];
    // The last revision captured before the merge, shown read-only as the delivered diff.
    deliveredRevisionId: string | null;
}
