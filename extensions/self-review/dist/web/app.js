// Self review canvas client: renders the diff, inline threads, and composers; talks to the
// per-instance loopback server with the token from the URL.
import { createSettingsApi } from "./settings-api.mjs";
import { REVIEW_COMMANDS, reviewCommandSuggestions } from "./review-commands.mjs";
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onRefreshProgress(event) {
    const payload = JSON.parse(event.data);
    if (!isRefreshStatus(payload))
        throw new Error("Invalid refresh progress event.");
    serverRefresh = payload;
    if (serverRefresh?.status !== "refreshing")
        refreshError = "";
    renderLoadStatus();
}
function isView(value) {
    if (!isRecord(value))
        return false;
    if (value.type === "overview" || value.type === "lessons" || value.type === "agent-comments" || value.type === "history")
        return true;
    return (value.type === "file" || value.type === "folder") && typeof value.path === "string";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isOptionalString(value) {
    return value === undefined || value === null || typeof value === "string";
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isDiffRow(value) {
    return isRecord(value)
        && (value.t === "add" || value.t === "del" || value.t === "ctx")
        && (value.o === undefined || value.o === null || typeof value.o === "number")
        && (value.n === undefined || value.n === null || typeof value.n === "number")
        && typeof value.s === "string"
        && (value.noNewlineAtEnd === undefined || typeof value.noNewlineAtEnd === "boolean");
}
function isDiffHunk(value) {
    return isRecord(value)
        && typeof value.oldStart === "number" && typeof value.oldLines === "number"
        && typeof value.newStart === "number" && typeof value.newLines === "number"
        && typeof value.header === "string"
        && Array.isArray(value.rows) && value.rows.every(isDiffRow)
        && (value.gap === undefined || typeof value.gap === "boolean");
}
function isDiffFile(value) {
    return isRecord(value)
        && typeof value.path === "string"
        && isOptionalString(value.oldPath)
        && (value.status === "modified" || value.status === "added" || value.status === "deleted" || value.status === "renamed")
        && typeof value.additions === "number" && typeof value.deletions === "number"
        && typeof value.binary === "boolean" && isOptionalString(value.note)
        && (value.imageSides === undefined || (isRecord(value.imageSides)
            && isOptionalString(value.imageSides.old) && isOptionalString(value.imageSides.new)))
        && (value.untracked === undefined || typeof value.untracked === "boolean")
        && isOptionalString(value.oldMode) && isOptionalString(value.newMode)
        && (value.typeChanged === undefined || typeof value.typeChanged === "boolean")
        && Array.isArray(value.hunks) && value.hunks.every(isDiffHunk)
        && (value.full === undefined || typeof value.full === "boolean");
}
function isRevision(value) {
    return isRecord(value)
        && typeof value.revisionId === "string" && typeof value.createdAt === "string"
        && typeof value.files === "number" && typeof value.additions === "number"
        && typeof value.deletions === "number";
}
function isLocation(value) {
    return isRecord(value) && typeof value.path === "string"
        && (value.side === undefined || value.side === "old" || value.side === "new")
        && (value.startLine === undefined || typeof value.startLine === "number")
        && (value.endLine === undefined || typeof value.endLine === "number")
        && (value.state === undefined || typeof value.state === "string");
}
function isAnchor(value) {
    return isRecord(value) && typeof value.revisionId === "string"
        && (value.selectedLines === undefined || isStringArray(value.selectedLines))
        && isLocation(value);
}
function isMessage(value) {
    if (!isRecord(value) || typeof value.messageId !== "string"
        || (value.author !== "user" && value.author !== "agent")
        || typeof value.body !== "string" || typeof value.createdAt !== "string"
        || (value.imageIds !== undefined && !isStringArray(value.imageIds))
        || !isOptionalString(value.outcome) || !isOptionalString(value.verification)
        || (value.lessonIds !== undefined && (!Array.isArray(value.lessonIds) || !value.lessonIds.every((id) => typeof id === "string")))) {
        return false;
    }
    if (value.delivery == null)
        return true;
    return isRecord(value.delivery)
        && ["draft", "saving", "queued", "processing", "replied", "no-reply", "failed"].includes(String(value.delivery.state))
        && isOptionalString(value.delivery.queuedAt) && isOptionalString(value.delivery.error);
}
function isFinding(value) {
    if (!isRecord(value) || typeof value.model !== "string" || typeof value.category !== "string"
        || typeof value.assessment !== "string" || typeof value.severity !== "string"
        || typeof value.revisionId !== "string" || typeof value.runId !== "string"
        || !isOptionalString(value.approvalMessageId))
        return false;
    if (value.contributions !== undefined && (!Array.isArray(value.contributions) || !value.contributions.every((item) => isRecord(item) && typeof item.model === "string" && typeof item.body === "string" && isRecord(item.evidence)
        && isOptionalString(item.evidence.source) && isOptionalString(item.evidence.baseline) && isOptionalString(item.evidence.validation)
        && isOptionalString(item.kind) && isOptionalString(item.category) && isOptionalString(item.assessment) && isOptionalString(item.severity)
        && (item.anchor === undefined || item.anchor === null || isAnchor(item.anchor)))))
        return false;
    if (value.votes !== undefined && (!Array.isArray(value.votes) || !value.votes.every((vote) => isRecord(vote) && typeof vote.model === "string" && ["agree", "disagree", "uncertain"].includes(String(vote.decision))
        && typeof vote.discussion === "string" && typeof vote.rationale === "string")))
        return false;
    if (value.evidence === undefined || value.evidence === null)
        return true;
    return isRecord(value.evidence) && isOptionalString(value.evidence.source)
        && isOptionalString(value.evidence.baseline) && isOptionalString(value.evidence.validation);
}
function isThread(value) {
    if (!isRecord(value) || typeof value.threadId !== "string"
        || !["overview", "file", "change", "line"].includes(String(value.kind))
        || !["active", "resolved", "wontfix", "closed"].includes(String(value.status))
        || !Array.isArray(value.messages) || !value.messages.every(isMessage)
        || (value.location !== undefined && value.location !== null && !isLocation(value.location))
        || (value.followUpOf !== undefined && typeof value.followUpOf !== "string"))
        return false;
    if (value.anchor !== undefined && value.anchor !== null) {
        if (!isAnchor(value.anchor))
            return false;
    }
    return value.agentReview === undefined || value.agentReview === null || isFinding(value.agentReview);
}
function isLesson(value) {
    return isRecord(value)
        && typeof value.lessonId === "string" && typeof value.scope === "string"
        && (value.sourceMessageId === undefined || typeof value.sourceMessageId === "string")
        && (value.status === undefined || typeof value.status === "string")
        && typeof value.rule === "string" && isOptionalString(value.savedTo)
        && typeof value.threadId === "string" && typeof value.createdAt === "string";
}
function isAgentReviewRun(value) {
    if (!isRecord(value) || typeof value.runId !== "string" || typeof value.state !== "string"
        || typeof value.focus !== "string" || typeof value.revisionId !== "string"
        || !Array.isArray(value.models) || !value.models.every((model) => typeof model === "string")
        || !Array.isArray(value.results) || !isOptionalString(value.intent) || !isOptionalString(value.error))
        return false;
    if (value.skills !== undefined && (!Array.isArray(value.skills) || !value.skills.every((skill) => isRecord(skill) && typeof skill.name === "string" && isOptionalString(skill.release))))
        return false;
    if (value.protocol !== undefined && value.protocol !== "consensus-v1")
        return false;
    if (value.consensus !== undefined && (!Array.isArray(value.consensus) || !value.consensus.every((group) => isRecord(group) && (group.kind === "finding" || group.kind === "ponytail")
        && Array.isArray(group.sources) && group.sources.every((source) => isRecord(source)
        && typeof source.model === "string" && Number.isSafeInteger(source.index))
        && Array.isArray(group.votes) && group.votes.every((vote) => isRecord(vote)
        && typeof vote.model === "string" && ["agree", "disagree", "uncertain"].includes(String(vote.decision))
        && typeof vote.discussion === "string" && typeof vote.rationale === "string"))))
        return false;
    return value.results.every((result) => {
        if (!isRecord(result) || typeof result.model !== "string" || !Array.isArray(result.threadIds)
            || !result.threadIds.every((id) => typeof id === "string")
            || (result.candidates !== undefined && !Array.isArray(result.candidates))
            || !isOptionalString(result.error) || !isOptionalString(result.summary))
            return false;
        if (result.ponytail === undefined || result.ponytail === null)
            return true;
        return isRecord(result.ponytail) && typeof result.ponytail.status === "string"
            && typeof result.ponytail.summary === "string" && Array.isArray(result.ponytail.benefits)
            && result.ponytail.benefits.every((benefit) => isRecord(benefit)
                && typeof benefit.proposal === "string" && typeof benefit.benefit === "string"
                && isRecord(benefit.evidence) && typeof benefit.evidence.source === "string"
                && typeof benefit.evidence.baseline === "string" && typeof benefit.evidence.validation === "string");
    });
}
function isGitStatus(value) {
    if (!isRecord(value) || !isOptionalString(value.headCommit) || !isOptionalString(value.baseCommit)
        || !isOptionalString(value.branch) || (value.uncommittedFiles !== undefined && typeof value.uncommittedFiles !== "number"))
        return false;
    if (value.delivered !== undefined && value.delivered !== null && (!isRecord(value.delivered)
        || typeof value.delivered.pullRequestNumber !== "number"
        || !["separated", "in-base", "unavailable", "not-in-branch"].includes(String(value.delivered.separation))))
        return false;
    return value.upstream === undefined || value.upstream === null
        || (isRecord(value.upstream) && (value.upstream.ahead === null || typeof value.upstream.ahead === "number")
            && (value.upstream.behind === null || typeof value.upstream.behind === "number")
            && typeof value.upstream.name === "string");
}
function isDescription(value) {
    return isRecord(value) && typeof value.version === "number"
        && (value.revisionId === null || typeof value.revisionId === "string") && typeof value.body === "string";
}
function isPullRequest(value) {
    return isRecord(value) && typeof value.number === "number" && Number.isSafeInteger(value.number) && typeof value.url === "string"
        && (value.state === undefined || value.state === "open" || value.state === "merged" || value.state === "closed")
        && isOptionalString(value.baseRefName) && isOptionalString(value.headRefOid) && isOptionalString(value.mergedAt)
        && isOptionalString(value.closedAt) && isOptionalString(value.mergeCommitOid);
}
// Older providers reported only an open pull request's number and URL.
function parsePullRequest(value) {
    return {
        number: value.number,
        url: value.url,
        state: value.state ?? "open",
        baseRefName: value.baseRefName ?? null,
        headRefOid: value.headRefOid ?? null,
        mergedAt: value.mergedAt ?? null,
        closedAt: value.closedAt ?? null,
        mergeCommitOid: value.mergeCommitOid ?? null,
    };
}
function isPullRequestStatus(value) {
    return isRecord(value) && isOptionalString(value.checkedAt) && isOptionalString(value.error)
        && (value.commitsAfterHead === null || value.commitsAfterHead === undefined || typeof value.commitsAfterHead === "number");
}
function isCompletion(value) {
    return isRecord(value) && isPullRequest(value.pullRequest) && typeof value.completedAt === "string"
        && isStringArray(value.archivedThreadIds) && isOptionalString(value.deliveredRevisionId);
}
function isReview(value) {
    return isRecord(value)
        && typeof value.reviewId === "string"
        && typeof value.title === "string"
        && typeof value.repoRoot === "string"
        && (value.base === null || typeof value.base === "string")
        && (value.branch === undefined || value.branch === null || typeof value.branch === "string")
        && (value.scope === undefined || value.scope === "all" || value.scope === "pending")
        && (value.currentRevisionId === null || typeof value.currentRevisionId === "string")
        && Array.isArray(value.revisions) && value.revisions.every(isRevision)
        && Array.isArray(value.threads) && value.threads.every(isThread)
        && Array.isArray(value.lessons) && value.lessons.every(isLesson)
        && (value.git === undefined || value.git === null || isGitStatus(value.git))
        && (value.description === undefined || value.description === null || isDescription(value.description))
        && (value.deliveryMode === undefined || value.deliveryMode === null
            || value.deliveryMode === "immediate" || value.deliveryMode === "batch")
        && (value.agentReviews === undefined || (Array.isArray(value.agentReviews) && value.agentReviews.every(isAgentReviewRun)))
        && (value.completions === undefined || (Array.isArray(value.completions) && value.completions.every(isCompletion)));
}
function parseReview(value) {
    if (!isReview(value))
        throw new Error("Invalid review state response.");
    return value;
}
function isReviewFocus(value) {
    return value === "review" || value === "simplify" || value === "both";
}
function isThreadStatus(value) {
    return value === "active" || value === "resolved" || value === "wontfix" || value === "closed";
}
function isSnapshot(value) {
    return isRecord(value) && typeof value.revisionId === "string"
        && Array.isArray(value.files) && value.files.every(isDiffFile);
}
function parseSnapshot(value) {
    if (!isSnapshot(value))
        throw new Error("Invalid snapshot response.");
    return value;
}
function parseContent(value, file) {
    if (!isRecord(value) || typeof value.available !== "boolean")
        throw new Error("Invalid content response.");
    if (!value.available)
        return { status: "unavailable", reason: typeof value.reason === "string" ? value.reason : undefined };
    if (!isStringArray(value.lines)) {
        throw new Error("Invalid full-file content response.");
    }
    return { status: "ready", full: buildFullFile(file, value.lines) };
}
function isRefreshStatus(value) {
    return isRecord(value) && ["idle", "refreshing", "error"].includes(String(value.status))
        && (value.status !== "error" || typeof value.error === "string");
}
function isExtensionVersion(value) {
    return isRecord(value) && typeof value.version === "string" && Boolean(value.version.trim())
        && typeof value.buildId === "string" && /^[a-f0-9]{12}$/.test(value.buildId)
        && (value.builtAt === undefined || typeof value.builtAt === "string");
}
function isStateResponse(value) {
    if (!isRecord(value) || !isReview(value.review)
        || (value.refresh !== undefined && !isRefreshStatus(value.refresh))
        || (value.extensionVersion !== undefined && !isExtensionVersion(value.extensionVersion))
        || (value.session !== undefined && (!isRecord(value.session)
            || (value.session.busy !== null && typeof value.session.busy !== "boolean")))
        || (value.pullRequest !== undefined && value.pullRequest !== null && !isPullRequest(value.pullRequest))
        || (value.pullRequestStatus !== undefined && value.pullRequestStatus !== null && !isPullRequestStatus(value.pullRequestStatus))
        || (value.agentReviewAvailable !== undefined && typeof value.agentReviewAvailable !== "boolean")
        || (value.reviewSkillsAvailable !== undefined && typeof value.reviewSkillsAvailable !== "boolean")
        || (value.agentReviewSuggestedModels !== undefined && !isStringArray(value.agentReviewSuggestedModels)))
        return false;
    return true;
}
function parseState(value) {
    if (!isStateResponse(value))
        throw new Error("Invalid state response.");
    return {
        review: value.review,
        refresh: value.refresh,
        session: value.session === undefined ? undefined : { busy: value.session.busy },
        pullRequest: value.pullRequest == null ? null : parsePullRequest(value.pullRequest),
        pullRequestStatus: value.pullRequestStatus == null ? null : {
            checkedAt: value.pullRequestStatus.checkedAt ?? null,
            error: value.pullRequestStatus.error ?? null,
            commitsAfterHead: value.pullRequestStatus.commitsAfterHead ?? null,
        },
        agentReviewAvailable: value.agentReviewAvailable === true,
        reviewSkillsAvailable: value.reviewSkillsAvailable === true,
        agentReviewSuggestedModels: value.agentReviewSuggestedModels ?? [],
        extensionVersion: value.extensionVersion,
        settingsPayload: value,
    };
}
function isSkill(value) {
    return isRecord(value)
        && typeof value.name === "string" && typeof value.title === "string"
        && typeof value.role === "string" && typeof value.summary === "string"
        && isRecord(value.upstream) && typeof value.upstream.repository === "string"
        && typeof value.upstream.release === "string" && typeof value.upstream.path === "string"
        && typeof value.upstream.fileCommit === "string"
        && isRecord(value.license) && typeof value.license.spdx === "string"
        && isOptionalString(value.attribution);
}
function isSkillCatalog(value) {
    return isRecord(value)
        && Array.isArray(value.selected) && value.selected.every((name) => typeof name === "string")
        && Array.isArray(value.skills) && value.skills.every(isSkill);
}
function parseSkillCatalog(value) {
    if (!isSkillCatalog(value))
        throw new Error("Invalid review skills response.");
    return value;
}
const TOKEN = new URLSearchParams(location.search).get("t") ?? "";
const STATUSES = ["active", "resolved", "wontfix", "closed"];
const STALE_QUEUE_MS = 120000;
const FINDING_ASSESSMENTS = { confirmed: "Confirmed", "pre-existing": "Pre-existing", rejected: "Rejected", unverified: "Unverified" };
const FINDING_SEVERITIES = { critical: "Critical", required: "Required", optional: "Optional", nit: "Nit", fyi: "FYI" };
const state = {
    review: null,
    snapshot: null,
    pullRequest: null,
    pullRequestStatus: null,
    archived: [],
    historyDiffs: new Map(),
    historySelection: new Set(),
    followingUp: false,
    busy: null,
    connection: "connecting",
    view: { type: "overview" },
    selection: null,
    dragging: false,
    pendingJump: null,
    open: new Set(),
    pending: new Map(),
    expanded: new Set(),
    collapsedThreads: new Set(),
    showResolved: false,
    collapsedDirs: null,
    fileFold: new Map(),
    content: new Map(),
    images: new Map(),
    imageViews: new Map(),
    settings: null,
    extensionVersion: undefined,
    dialog: null,
    switching: false,
    submitting: false,
    agentReviewAvailable: false,
    agentReviewSettings: null,
    agentReviewSettingsAvailable: false,
    agentReviewSettingsError: "",
    agentReviewSuggestedModels: [],
    startingReview: false,
    reviewSkillsAvailable: false,
    skillOverrides: new Map(),
    approving: new Set(),
};
const FOLDER_VIEW_ROW_BUDGET = 3000;
const settingsApi = createSettingsApi((method, path, body) => api(method, path, body));
const destinationPreviewRequests = new WeakMap();
const destinationFormDrafts = new Map();
const DELIVERY_MODES = ["immediate", "batch", "ask"];
const DELIVERY = {
    immediate: { label: "Send each comment now", pill: "Immediate", hint: "Each comment goes to Copilot as soon as you post it." },
    batch: { label: "Batch into a review", pill: "Batch", hint: "Comments wait as drafts until you submit the review, then Copilot addresses them together in one pass." },
    ask: { label: "Ask for each review", pill: "Ask", hint: "The first time you comment on a review, choose whether to send each comment now or batch them." },
};
const LESSON_STATUSES = {
    proposed: "Proposed by Copilot and not saved yet.",
    saved: "Saved as a guideline for future work.",
    declined: "Declined; not saved.",
};
const scopeOf = (review) => (review?.scope === "pending" ? "pending" : "all");
const scopeLabel = (scope) => (scope === "pending" ? "pending changes" : "all changes");
const autoSaveLearnedRules = () => state.settings?.autoSaveLearnedRules === true;
const autoSaveLabel = () => `Auto-save learned rules: ${autoSaveLearnedRules() ? "On" : "Off"}`;
const deliveryRepoMode = () => {
    const mode = state.settings?.delivery;
    return mode === "batch" || mode === "ask" ? mode : "immediate";
};
// Mirrors the server's resolveDelivery: null while an ask-mode review is undecided. Without settings nothing is held.
function deliveryMode() {
    if (!state.settings)
        return "immediate";
    const mode = deliveryRepoMode();
    if (mode !== "ask")
        return mode;
    const chosen = state.review?.deliveryMode;
    return chosen === "immediate" || chosen === "batch" ? chosen : null;
}
const draftMessages = () => (state.review?.threads ?? []).flatMap((t) => t.messages).filter((m) => m.author === "user" && m.delivery?.state === "draft");
// Lessons recorded before statuses existed were saved by definition.
const lessonStatus = (lesson) => (lesson.status === "proposed" || lesson.status === "declined" || lesson.status === "saved" ? lesson.status : "saved");
const lessonBadge = (lesson) => {
    const status = lessonStatus(lesson);
    return `<span class="badge lesson-${status}" title="${esc(LESSON_STATUSES[status])}">${status}</span>`;
};
const $ = (sel, root = document) => root.querySelector(sel);
const requiredElement = (sel) => {
    const element = $(sel);
    if (!element)
        throw new Error(`Missing renderer element: ${sel}`);
    return element;
};
function esc(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character] ?? character);
}
const CODE_KEYWORDS = new Set(("abstract as async await base bool boolean break byte case catch char checked class const continue decimal default delegate delete do double else enum event export extends extern false finally fixed float for foreach from function get if implements import in init int interface internal is let lock long namespace new null object operator out override params partial private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct super switch this throw true try typeof uint ulong unchecked undefined unsafe ushort using var virtual void volatile while with yield").split(" "));
const highlightedFiles = new WeakMap();
function syntaxLanguage(filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (["cs", "js", "mjs", "cjs", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp"].includes(ext))
        return "code";
    if (["xml", "html", "htm", "csproj", "props", "targets", "config", "svg", "xaml"].includes(ext))
        return "xml";
    if (["json", "jsonc"].includes(ext))
        return "json";
    if (["yaml", "yml"].includes(ext))
        return "yaml";
    if (["md", "markdown", "mdx"].includes(ext))
        return "markdown";
    return null;
}
// Lexical highlighting only: escape every source fragment and preserve its exact text.
function highlightLine(text, language, lexical = {}) {
    if (!language)
        return esc(text);
    if (language === "markdown")
        return highlightMarkdown(text, lexical);
    const out = [];
    const emit = (value, kind) => out.push(kind ? `<span class="syn-${kind}">${esc(value)}</span>` : esc(value));
    const tokens = language === "xml"
        ? /<!--|<\/?[\w:.-]+|\/?>|[\w:.-]+(?=\s*=)|"(?:[^"]*)"|'(?:[^']*)'/g
        : /\/\*|\/\/.*$|#[^\n]*$|@"(?:""|[^"])*"|\$?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|[A-Za-z_$][\w$]*/g;
    let offset = 0;
    while (offset < text.length) {
        if (lexical.comment) {
            const end = text.indexOf(lexical.comment, offset);
            const next = end < 0 ? text.length : end + lexical.comment.length;
            emit(text.slice(offset, next), "comment");
            offset = next;
            if (end < 0)
                break;
            lexical.comment = null;
            continue;
        }
        tokens.lastIndex = offset;
        const match = tokens.exec(text);
        if (!match) {
            emit(text.slice(offset));
            break;
        }
        emit(text.slice(offset, match.index));
        const token = match[0];
        offset = tokens.lastIndex;
        if ((language === "xml" && token === "<!--") || (language === "code" && token === "/*")) {
            lexical.comment = language === "xml" ? "-->" : "*/";
            emit(token, "comment");
        }
        else if (language === "xml") {
            if (token.startsWith("<"))
                lexical.tag = true;
            const kind = token.startsWith("<") || /^\/?>$/.test(token) ? "keyword"
                : /^["']/.test(token) ? "string" : lexical.tag ? "property" : null;
            emit(token, kind);
            if (/\/?>$/.test(token))
                lexical.tag = false;
        }
        else if ((language === "code" || language === "json") && token.startsWith("//")
            || language === "yaml" && token.startsWith("#")) {
            emit(token, "comment");
        }
        else if (/^(?:@|\$)?["'`]/.test(token)) {
            emit(token, language === "json" && /^\s*:/.test(text.slice(offset)) ? "property" : "string");
        }
        else if (/^\d/.test(token)) {
            emit(token, "number");
        }
        else {
            const kind = language === "code" && CODE_KEYWORDS.has(token)
                || language !== "code" && /^(true|false|null)$/.test(token) ? "keyword"
                : language === "yaml" && /^\s*:/.test(text.slice(offset)) ? "property"
                    : language === "code" && /^[A-Z]/.test(token) ? "type" : null;
            emit(token, kind);
        }
    }
    return out.join("");
}
const MD_FENCE_ALIASES = { javascript: "js", typescript: "ts", csharp: "cs", "c#": "cs", "c++": "cpp", markdown: "md" };
const MD_INLINE = /\\[!-\/:-@[-`{-~]|`+|<!--|!?\[|<(?:https?:\/\/|mailto:)[^<>\s]+>|(?<![\w/])https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|\*\*|__|~~|[*_|]/g;
const MD_LINK = /!?\[((?:\\.|[^\\\]\n])*)\](?:\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)((?:\s+(?:"[^"]*"|'[^']*'))?\s*)\)|\[([^\]\n]*)\])/y;
const MD_STYLES = { "**": "strong", __: "strong", "*": "em", _: "em", "~~": "del" };
const mdToken = (value, cls) => (value ? `<span class="${cls}">${esc(value)}</span>` : "");
const mdBlock = (html) => `<span class="md-block">${html}</span>`;
function fenceLanguage(info) {
    const name = info.trim().split(/[\s{,]/)[0]?.toLowerCase() ?? "";
    return name ? syntaxLanguage(`fence.${MD_FENCE_ALIASES[name] ?? name}`) : null;
}
// Markdown stays source text: markers are dimmed, never removed, so selections and anchors match the file.
function highlightMarkdown(text, lexical) {
    const fence = lexical.fence;
    if (fence) {
        const close = text.match(/^(\s*)(`{3,}|~{3,})(\s*)$/);
        if (close && close[2][0] === fence.marker[0] && close[2].length >= fence.marker.length) {
            lexical.fence = null;
            return mdBlock(esc(close[1]) + mdToken(close[2], "md-mark") + esc(close[3]));
        }
        return mdBlock(fence.language ? highlightLine(text, fence.language, fence.lexical) : esc(text));
    }
    if (lexical.comment) {
        const end = text.indexOf("-->");
        if (end < 0)
            return mdToken(text, "syn-comment");
        lexical.comment = null;
        return mdToken(text.slice(0, end + 3), "syn-comment") + mdInline(text.slice(end + 3), lexical);
    }
    const open = text.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
        lexical.fence = { marker: open[2], language: fenceLanguage(open[3]), lexical: {} };
        return mdBlock(esc(open[1]) + mdToken(open[2], "md-mark") + mdToken(open[3], "md-lang"));
    }
    if (/^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+)[ \t]*$/.test(text))
        return mdToken(text, "md-mark");
    const heading = text.match(/^( {0,3})(#{1,6})((?:\s.*?)?)((?:\s#+)?\s*)$/);
    if (heading) {
        return esc(heading[1]) + mdToken(heading[2], "md-mark")
            + `<span class="md-heading">${mdInline(heading[3], lexical)}</span>` + mdToken(heading[4], "md-mark");
    }
    const definition = text.match(/^( {0,3})(\[(?!\^)[^\]\n]+\]:)(\s*)(\S*)(.*)$/);
    if (definition) {
        return esc(definition[1]) + mdToken(definition[2], "md-link") + esc(definition[3])
            + mdToken(definition[4], "md-url") + mdToken(definition[5], "md-mark");
    }
    let prefix = "";
    let rest = text;
    const quote = rest.match(/^ {0,3}>(?:[ \t]?>)*[ \t]?/);
    if (quote) {
        prefix += mdToken(quote[0], "md-mark");
        rest = rest.slice(quote[0].length);
    }
    const item = rest.match(/^(\s*)([-*+]|\d{1,9}[.)])(?=\s|$)(\s*)(\[[ xX]\](?=\s|$))?/);
    if (item) {
        prefix += esc(item[1]) + mdToken(item[2], "md-list") + esc(item[3]) + mdToken(item[4], "md-mark");
        rest = rest.slice(item[0].length);
    }
    if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(rest))
        return prefix + mdToken(rest, "md-mark");
    const body = mdInline(rest, lexical, /^\s*\|/.test(rest));
    return prefix + (quote ? `<span class="md-quote">${body}</span>` : body);
}
function mdInline(text, lexical, table = false, depth = 0) {
    // Delimiter matching rescans the line, so pathological lines stay plain.
    if (depth > 6 || text.length > 4000)
        return esc(text);
    const tokens = new RegExp(MD_INLINE);
    const out = [];
    let plain = 0;
    let match;
    while ((match = tokens.exec(text))) {
        const token = match[0];
        if (token[0] === "\\")
            continue;
        const at = match.index;
        let end = tokens.lastIndex;
        let html = null;
        if (token[0] === "`") {
            const closing = /`+/g;
            closing.lastIndex = end;
            let close;
            while ((close = closing.exec(text)) && close[0].length !== token.length)
                ;
            if (close) {
                html = `<span class="md-code">${mdToken(token, "md-mark")}${esc(text.slice(end, close.index))}${mdToken(close[0], "md-mark")}</span>`;
                end = closing.lastIndex;
            }
        }
        else if (token === "<!--") {
            const close = text.indexOf("-->", end);
            if (close < 0)
                lexical.comment = "-->";
            end = close < 0 ? text.length : close + 3;
            html = mdToken(text.slice(at, end), "syn-comment");
        }
        else if (token.endsWith("[")) {
            MD_LINK.lastIndex = at;
            const link = MD_LINK.exec(text);
            if (link) {
                const [, label = "", url, title, ref] = link;
                end = MD_LINK.lastIndex;
                const head = `${mdToken(token, "md-mark")}<span class="md-link">${mdInline(label, {}, false, depth + 1)}</span>`;
                html = url != null
                    ? `${head}${mdToken("](", "md-mark")}${mdToken(url, "md-url")}${mdToken(title, "md-mark")}${mdToken(")", "md-mark")}`
                    : `${head}${mdToken("][", "md-mark")}${mdToken(ref, "md-url")}${mdToken("]", "md-mark")}`;
            }
        }
        else if (/^<(?:https?:|mailto:)/.test(token)) {
            html = `${mdToken("<", "md-mark")}${mdToken(token.slice(1, -1), "md-url")}${mdToken(">", "md-mark")}`;
        }
        else if (token.startsWith("<")) {
            html = mdToken(token, "md-html");
        }
        else if (token.startsWith("http")) {
            html = mdToken(token, "md-url");
        }
        else if (token === "|") {
            if (table)
                html = mdToken(token, "md-mark");
        }
        else {
            const mark = token[0];
            if (mark === "_" && /[\p{L}\p{N}]/u.test(text[at - 1] ?? ""))
                continue;
            const c = mark === "*" ? "\\*" : mark;
            const closing = new RegExp(`(?=[^\\s${c}])(.*?[^\\s\\\\${c}])${c.repeat(token.length)}(?!${c})${mark === "_" ? "(?![\\p{L}\\p{N}])" : ""}`, "uy");
            closing.lastIndex = end;
            const close = closing.exec(text);
            if (close) {
                end = closing.lastIndex;
                html = `<span class="md-${MD_STYLES[token]}">${mdToken(token, "md-mark")}${mdInline(close[1], {}, table, depth + 1)}${mdToken(token, "md-mark")}</span>`;
            }
        }
        if (html == null)
            continue;
        if (at > plain)
            out.push(esc(text.slice(plain, at)));
        out.push(html);
        plain = tokens.lastIndex = end;
    }
    if (plain < text.length)
        out.push(esc(text.slice(plain)));
    return out.join("");
}
function highlightFile(file) {
    const cached = highlightedFiles.get(file);
    if (cached)
        return cached;
    const language = syntaxLanguage(file.path);
    const sides = {
        old: { next: null, lexical: {} }, new: { next: null, lexical: {} },
    };
    const rows = file.hunks.map((hunk) => hunk.rows.map((row) => {
        let html;
        const lineSides = [["old", row.o], ["new", row.n]];
        for (const [side, line] of lineSides) {
            if (line == null)
                continue;
            const cursor = sides[side];
            // Omitted diff context cannot establish a multiline token's state.
            if (cursor.next !== line)
                cursor.lexical = {};
            html = highlightLine(row.s, language, cursor.lexical);
            cursor.next = line + 1;
        }
        return html ?? esc(row.s);
    }));
    highlightedFiles.set(file, rows);
    return rows;
}
const MD_RENDER_TOKENS = /\\[!-\/:-@[-`{-~]|`+|\*\*|!?\[/g;
const MD_RENDER_DESTINATION = /\((?:<((?:\\[!-\/:-@[-`{-~]|[^\\<>\r\n])*)>|((?:\\[!-\/:-@[-`{-~]|[^\\<>()\s]|\((?:\\[!-\/:-@[-`{-~]|[^\\<>()\s])*\))*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
function closingCodeRun(text, from, length) {
    const runs = /`+|\n/g;
    runs.lastIndex = from;
    for (let run = runs.exec(text); run && run[0] !== "\n"; run = runs.exec(text)) {
        if (run[0].length === length)
            return run;
    }
    return null;
}
function closingInlineDelimiter(text, from, kind) {
    const delimiters = /\\[!-\/:-@[-`{-~]|`+|\*\*|[\[\]\n]/g;
    delimiters.lastIndex = from;
    let depth = 1;
    for (let match = delimiters.exec(text); match && match[0] !== "\n"; match = delimiters.exec(text)) {
        const [token] = match;
        if (token.startsWith("`")) {
            const close = closingCodeRun(text, delimiters.lastIndex, token.length);
            if (close)
                delimiters.lastIndex = close.index + close[0].length;
        }
        else if (kind === "bold" && token === "**") {
            return match.index;
        }
        else if (kind === "label") {
            if (token === "[")
                depth++;
            if (token === "]" && --depth === 0)
                return match.index;
        }
    }
    return -1;
}
function externalMarkdownUrl(destination) {
    let decoder;
    const url = destination.replace(/\\([!-\/:-@[-`{-~])|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]*);/g, (token, punctuation) => {
        if (typeof punctuation === "string")
            return punctuation;
        // Only a single syntactically valid reference, never arbitrary markup, reaches the decoder.
        decoder ??= document.createElement("textarea");
        decoder.innerHTML = token;
        return decoder.value;
    });
    if (!/^https?:\/\//i.test(url) || !URL.canParse(url))
        return undefined;
    return new URL(url).href;
}
function inline(text, allowLinks = true) {
    // Bound repeated delimiter scans on long lines without dropping any text.
    if (text.length > 4000)
        return esc(text);
    const tokens = new RegExp(MD_RENDER_TOKENS);
    let html = "";
    let offset = 0;
    for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
        const [token] = match;
        html += esc(text.slice(offset, match.index));
        if (token.startsWith("\\"))
            html += esc(token.slice(1));
        else if (token.startsWith("`")) {
            const close = closingCodeRun(text, tokens.lastIndex, token.length);
            if (close) {
                html += `<code>${esc(text.slice(tokens.lastIndex, close.index))}</code>`;
                tokens.lastIndex = close.index + close[0].length;
            }
            else
                html += esc(token);
        }
        else if (token === "**") {
            const close = closingInlineDelimiter(text, tokens.lastIndex, "bold");
            if (close > tokens.lastIndex) {
                html += `<strong>${inline(text.slice(tokens.lastIndex, close), allowLinks)}</strong>`;
                tokens.lastIndex = close + token.length;
            }
            else
                html += esc(token);
        }
        else if (allowLinks) {
            const close = closingInlineDelimiter(text, tokens.lastIndex, "label");
            MD_RENDER_DESTINATION.lastIndex = close + 1;
            const link = close < 0 ? null : MD_RENDER_DESTINATION.exec(text);
            if (link) {
                const end = MD_RENDER_DESTINATION.lastIndex;
                const destination = link[1] ?? link[2];
                const href = token === "[" && destination ? externalMarkdownUrl(destination) : undefined;
                html += href
                    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-markdown-link>${inline(text.slice(tokens.lastIndex, close), false)}</a>`
                    : esc(text.slice(match.index, end));
                tokens.lastIndex = end;
            }
            else
                html += esc(token);
        }
        else {
            html += esc(token);
        }
        offset = tokens.lastIndex;
    }
    return html + esc(text.slice(offset));
}
function md(text) {
    const out = [];
    let para = [];
    let code = null;
    let list = null;
    const flush = () => {
        if (para.length)
            out.push(`<p>${para.map((line) => inline(line)).join("<br>")}</p>`);
        para = [];
        if (list)
            out.push(`</${list}>`);
        list = null;
    };
    for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
        if (code) {
            if (/^\s*```/.test(line)) {
                out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
                code = null;
            }
            else
                code.push(line);
            continue;
        }
        if (/^\s*```/.test(line)) {
            flush();
            code = [];
        }
        else if (!line.trim())
            flush();
        else if (/^#{1,6}\s/.test(line)) {
            flush();
            const heading = line.match(/^(#{1,6})\s+(.*)$/);
            if (!heading)
                continue;
            const [, hashes, title] = heading;
            out.push(`<h${hashes.length}>${inline(title)}</h${hashes.length}>`);
        }
        else if (/^(?:[-*]|\d+\.)\s+/.test(line)) {
            const match = line.match(/^([-*]|\d+\.)\s+(.*)$/);
            if (!match)
                continue;
            const [, bullet, item] = match;
            const tag = /^\d/.test(bullet) ? "ol" : "ul";
            if (list !== tag) {
                flush();
                out.push(`<${tag}>`);
                list = tag;
            }
            out.push(`<li>${inline(item)}</li>`);
        }
        else {
            if (list)
                flush();
            para.push(line);
        }
    }
    if (code)
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    flush();
    return `<div class="md">${out.join("")}</div>`;
}
function ago(iso) {
    if (!iso)
        return "";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 45)
        return "just now";
    if (s < 3600)
        return `${Math.round(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleString();
}
function uuid() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
// ---------- API ----------
async function api(method, path, body) {
    const headers = { "X-MR-Token": TOKEN };
    if (state.review)
        headers["X-MR-Review"] = state.review.reviewId;
    if (body !== undefined)
        headers["Content-Type"] = "application/json";
    const res = await fetch(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    // The server switched reviews under this page; catch up so the next attempt targets the review on screen.
    if (res.status === 409)
        scheduleReload();
    const error = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string" ? json.error.message : null;
    if (!res.ok)
        throw new Error(error ?? `${res.status} ${res.statusText}`);
    return json;
}
// A scope switch points this page at a different review; nothing derived from the previous one may carry over.
function resetForReview() {
    persistPinnedComposers();
    imageUploads.clear();
    pinnedComposers.clear();
    composerContexts.clear();
    state.snapshot = null;
    state.view = { type: "overview" };
    state.selection = null;
    state.pendingJump = null;
    state.open.clear();
    state.pending.clear();
    state.expanded.clear();
    state.collapsedThreads.clear();
    state.fileFold.clear();
    state.content.clear();
    pruneImages(null);
    state.imageViews.clear();
    state.collapsedDirs = null;
    state.archived = [];
    state.historyDiffs.clear();
    state.historySelection.clear();
    viewRestored = false;
}
let loading = null;
let reloadAgain = false;
let reloadPending = false;
let refreshing = false;
let loadError = "";
let refreshError = "";
let serverRefresh;
let renderedStatusHtml = "";
let renderedFooterControlsHtml = "";
// The next state load asks the provider to bypass its cached pull request lookup.
let pullRequestCheckDue = false;
let lastPullRequestCheck = 0;
let quietLoad = false;
const PULL_REQUEST_POLL_MS = 120_000;
function checkPullRequest() {
    if (typeof document.visibilityState === "string" && document.visibilityState === "hidden")
        return;
    pullRequestCheckDue = true;
    if (loading || reloadPending) {
        if (loading)
            reloadAgain = true;
        return;
    }
    // A background status check keeps the page as it is instead of flashing the refresh indicator.
    quietLoad = true;
    void loadState().catch(() => undefined);
}
function archivedIds(review) {
    return new Set((review?.completions ?? []).flatMap((c) => c.archivedThreadIds));
}
const latestCompletion = () => state.review?.completions?.at(-1) ?? null;
const findAnyThread = (threadId) => state.review?.threads.find((t) => t.threadId === threadId)
    ?? state.archived.find((t) => t.threadId === threadId);
function renderLoadStatus() {
    const status = $("#review-status");
    const footerControls = $("#review-status-controls");
    if (!status || !footerControls)
        return;
    const refreshFailure = refreshError || (serverRefresh?.status === "error" ? serverRefresh.error : "");
    const pending = (Boolean(loading) && !quietLoad) || reloadPending || refreshing || (!loadError && !refreshFailure && serverRefresh?.status === "refreshing");
    const error = loadError || refreshFailure;
    const failureLabel = loadError ? "Could not load the current review" : "Could not refresh from the working tree";
    const errorText = error.trim();
    const punctuation = /[.!?…]$/u.test(errorText) ? "" : ".";
    status.hidden = !pending && !error;
    status.className = error && !pending ? "review-status del" : "review-status muted";
    const message = pending
        ? state.review ? "Refreshing review and Overview... Showing the last loaded data." : "Loading review and Overview..."
        : error ? `${failureLabel}: ${esc(errorText)}${punctuation} ${state.review ? "Showing the last loaded data." : ""}` : "";
    const retry = error && !pending ? `<button type="button" data-action="refresh">Retry</button>` : "";
    const html = message ? `<span class="review-status-message">${message}</span>${retry}` : "";
    if (renderedStatusHtml !== html) {
        status.innerHTML = html;
        renderedStatusHtml = html;
    }
    const controls = [];
    if (state.extensionVersion) {
        const { version, buildId, builtAt } = state.extensionVersion;
        const built = builtAt ? new Date(builtAt) : null;
        const date = built && !Number.isNaN(built.getTime())
            ? built.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
            : "";
        const detail = `Self-Review extension version ${version}, build ${buildId}${date ? `, built ${built?.toISOString()}` : ""}`;
        controls.push(`<span class="pill mono review-extension-version" tabindex="0" title="${esc(detail)}" aria-label="${esc(detail)}">v${esc(version)} · ${date ? esc(date) : `build ${esc(buildId)}`}</span>`);
    }
    if (state.settings && deliveryRepoMode() === "ask") {
        const chosen = deliveryMode();
        if (chosen)
            controls.push(`<button class="link" data-action="delivery-reask" title="This review sends comments: ${esc(DELIVERY[chosen].pill)}. Choose again.">Change delivery</button>`);
    }
    const controlsHtml = controls.join("");
    if (renderedFooterControlsHtml !== controlsHtml) {
        footerControls.innerHTML = controlsHtml;
        renderedFooterControlsHtml = controlsHtml;
    }
}
async function loadState() {
    clearTimeout(reloadTimer);
    reloadPending = false;
    if (loading) {
        reloadAgain = true;
        return loading;
    }
    loadError = "";
    loading = Promise.resolve().then(async () => {
        do {
            reloadAgain = false;
            const checkPullRequest = pullRequestCheckDue;
            pullRequestCheckDue = false;
            const data = parseState(await api("GET", checkPullRequest ? "state?pullRequest=refresh" : "state"));
            if (checkPullRequest)
                lastPullRequestCheck = Date.now();
            const rev = data.review.currentRevisionId;
            const snapshot = !rev ? null : state.review?.reviewId !== data.review.reviewId || state.snapshot?.revisionId !== rev
                ? parseSnapshot(await api("GET", `snapshot/${rev}`)) : state.snapshot;
            if (snapshot && snapshot.revisionId !== rev)
                throw new Error("Snapshot does not match the review revision.");
            // An event received during either request invalidates the pair before it reaches the screen.
            if (reloadAgain)
                continue;
            const reviewChanged = state.review?.reviewId !== data.review.reviewId;
            if (state.review && reviewChanged)
                resetForReview();
            else if (state.review && state.review.currentRevisionId !== data.review.currentRevisionId)
                pinComposers();
            state.review = data.review;
            const archived = archivedIds(data.review);
            state.archived = data.review.threads.filter((t) => archived.has(t.threadId));
            if (archived.size)
                state.review.threads = data.review.threads.filter((t) => !archived.has(t.threadId));
            for (const id of state.historySelection)
                if (!archived.has(id))
                    state.historySelection.delete(id);
            state.extensionVersion = data.extensionVersion;
            if (reviewChanged)
                restorePinnedComposers(data.review.reviewId);
            if (state.snapshot !== snapshot)
                pruneImages(snapshot);
            state.snapshot = snapshot;
            serverRefresh = data.refresh;
            refreshError = "";
            state.reviewSkillsAvailable = data.reviewSkillsAvailable === true;
            state.pullRequest = data.pullRequest ?? null;
            state.pullRequestStatus = data.pullRequestStatus ?? null;
            const settingsState = settingsApi.readState(data.settingsPayload);
            state.settings = settingsState.settings;
            state.agentReviewAvailable = data.agentReviewAvailable;
            state.agentReviewSettings = settingsState.agentReviewSettings;
            state.agentReviewSettingsAvailable = settingsState.agentReviewSettingsAvailable;
            state.agentReviewSettingsError = settingsState.agentReviewSettingsError ?? "";
            state.agentReviewSuggestedModels = data.agentReviewSuggestedModels;
            if (data.session)
                state.busy = data.session.busy;
            restoreView();
            render();
        } while (reloadAgain);
    }).catch((error) => {
        loadError = errorMessage(error);
        throw error;
    }).finally(() => {
        const retryQueued = reloadAgain;
        reloadAgain = false;
        loading = null;
        quietLoad = false;
        renderLoadStatus();
        if (retryQueued)
            scheduleReload();
    });
    renderLoadStatus();
    return loading;
}
let reloadTimer;
function scheduleReload() {
    reloadPending = true;
    quietLoad = false;
    renderLoadStatus();
    clearTimeout(reloadTimer);
    if (loading) {
        reloadAgain = true;
        reloadPending = false;
        return;
    }
    // loadState already reports failures in the persistent status footer.
    reloadTimer = window.setTimeout(() => loadState().catch(() => undefined), 120);
}
async function refreshReview() {
    refreshing = true;
    loadError = "";
    refreshError = "";
    pullRequestCheckDue = true;
    renderLoadStatus();
    try {
        await api("POST", "refresh", {});
        // An unchanged capture keeps the current revision, so retry its failed images here.
        pruneImages(state.snapshot);
        await loadState();
    }
    catch (error) {
        refreshError = errorMessage(error);
        throw error;
    }
    finally {
        refreshing = false;
        renderLoadStatus();
    }
}
function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
    es.addEventListener("refresh", (event) => onRefreshProgress(event));
    es.addEventListener("hello", (event) => {
        state.connection = "open";
        const payload = JSON.parse(event.data);
        state.busy = isRecord(payload) && typeof payload.busy === "boolean" ? payload.busy : null;
        scheduleReload();
    });
    es.addEventListener("changed", scheduleReload);
    // The extension's web assets changed on disk (dev hot reload).
    es.addEventListener("assets", () => location.reload());
    es.addEventListener("session", (event) => {
        const payload = JSON.parse(event.data);
        state.busy = isRecord(payload) && typeof payload.busy === "boolean" ? payload.busy : null;
        renderTop();
    });
    es.onerror = () => {
        state.connection = "lost";
        renderTop();
    };
}
// ---------- Drafts & view persistence ----------
const draftKey = (key) => `sr:${state.review?.reviewId}:draft:${key}`;
const getDraft = (key) => localStorage.getItem(draftKey(key)) ?? "";
function setDraft(key, value) {
    if (value)
        localStorage.setItem(draftKey(key), value);
    else
        localStorage.removeItem(draftKey(key));
}
const draftImageKey = (key) => `${draftKey(key)}:images`;
const imageUploads = new Map();
function getDraftImages(key) {
    try {
        const ids = JSON.parse(localStorage.getItem(draftImageKey(key)) ?? "[]");
        return isStringArray(ids) ? ids : [];
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return [];
        throw error;
    }
}
function setDraftImages(key, ids) {
    if (ids.length)
        localStorage.setItem(draftImageKey(key), JSON.stringify(ids));
    else
        localStorage.removeItem(draftImageKey(key));
}
function imagesHtml(ids, key, disabled = false) {
    if (!ids.length)
        return "";
    return `<div class="comment-images">${ids.map((id, i) => {
        const label = `Attached image ${i + 1}`;
        const url = `/api/comment-images/${encodeURIComponent(id)}?review=${encodeURIComponent(state.review?.reviewId ?? "")}&t=${encodeURIComponent(TOKEN)}`;
        return `<div><a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="${label}"></a>`
            + (key === undefined ? "" : `<button type="button" aria-label="Remove ${label.toLowerCase()}" data-action="remove-image" data-key="${esc(key)}" data-image="${esc(id)}"${disabled ? " disabled" : ""}>×</button>`) + `</div>`;
    }).join("")}</div>`;
}
function saveView() {
    if (state.review)
        sessionStorage.setItem(`sr:${state.review.reviewId}:view`, JSON.stringify(state.view));
}
let viewRestored = false;
function restoreView() {
    if (viewRestored || !state.review)
        return;
    viewRestored = true;
    try {
        const value = JSON.parse(sessionStorage.getItem(`sr:${state.review.reviewId}:view`) ?? "null");
        if (isView(value) && (value.type !== "history" || latestCompletion()))
            state.view = value;
    }
    catch { /* ignore */ }
}
function collapsedDirs() {
    if (!state.collapsedDirs) {
        try {
            const value = JSON.parse(localStorage.getItem(`sr:${state.review?.reviewId}:collapsed`) ?? "[]");
            state.collapsedDirs = isStringArray(value) ? new Set(value) : new Set();
        }
        catch {
            state.collapsedDirs = new Set();
        }
    }
    return state.collapsedDirs;
}
function setDirCollapsed(dir, collapsed) {
    const review = state.review;
    if (!review)
        return;
    const set = collapsedDirs();
    if (collapsed)
        set.add(dir);
    else
        set.delete(dir);
    localStorage.setItem(`sr:${review.reviewId}:collapsed`, JSON.stringify([...set]));
}
function expandAncestors(path) {
    for (const dir of collapsedDirs()) {
        if (dir === "" || path.startsWith(`${dir}/`))
            setDirCollapsed(dir, false);
    }
}
// ---------- File tree ----------
const inDir = (path, dir) => dir === "" || path.startsWith(`${dir}/`);
const filesUnder = (dir) => (state.snapshot?.files ?? []).filter((f) => inDir(f.path, dir)).sort((a, b) => a.path.localeCompare(b.path));
const repoName = () => state.settings?.repoName ?? (state.review?.repoRoot ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "All files";
// Folders first, then files; chains of single-child folders are compacted like ADO ("src/Common/Foo").
function buildTree(files) {
    const root = { name: repoName(), path: "", dirs: new Map(), files: [], children: [] };
    for (const f of files) {
        const parts = f.path.split("/");
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (part === undefined)
                continue;
            if (!node.dirs.has(part))
                node.dirs.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [], children: [] });
            const next = node.dirs.get(part);
            if (next)
                node = next;
        }
        node.files.push(f);
    }
    const finish = (node) => {
        node.children = [...node.dirs.values()].map((dir) => {
            let d = dir;
            while (!d.files.length && d.dirs.size === 1) {
                const only = d.dirs.values().next().value;
                if (!only)
                    break;
                d = { ...only, name: `${d.name}/${only.name}` };
            }
            return finish(d);
        }).sort((a, b) => a.name.localeCompare(b.name));
        node.files.sort((a, b) => a.path.localeCompare(b.path));
        return node;
    };
    return finish(root);
}
// ---------- Diff helpers ----------
function hunkAnchorRange(hunk) {
    const side = hunk.rows.some((r) => r.t === "add") ? "new" : "old";
    const key = side === "old" ? "o" : "n";
    const nums = hunk.rows.map((r) => r[key]).filter((v) => v != null);
    return nums.length ? { side, startLine: Math.min(...nums), endLine: Math.max(...nums) } : null;
}
function selectionRange(file, sel) {
    const rows = file.hunks[sel.hunk].rows.slice(sel.from, sel.to + 1);
    const side = rows.every((r) => r.t === "del") ? "old" : "new";
    const key = side === "old" ? "o" : "n";
    const nums = rows.map((r) => r[key]).filter((v) => v != null);
    return { side, startLine: Math.min(...nums), endLine: Math.max(...nums) };
}
const fileOf = (p) => state.snapshot?.files.find((f) => f.path === p) ?? null;
// ADO parity: selecting a file shows the whole file (changes inline); folders show diffs only.
// The full view interleaves unchanged "gap" hunks with the snapshot hunks, so selection,
// placement, and anchoring keep working on the same { hunks: [{ rows }] } shape.
function needsContent(file) {
    return !file.binary && file.status !== "added" && file.status !== "deleted" && file.hunks.length > 0;
}
function contentEntry(file) {
    const rev = state.snapshot?.revisionId;
    if (!rev)
        return { status: "unavailable", reason: "missing" };
    const key = `${rev}:${file.path}`;
    let entry = state.content.get(key);
    if (!entry) {
        entry = { status: "loading" };
        state.content.set(key, entry);
        api("GET", `content/${encodeURIComponent(rev)}?path=${encodeURIComponent(file.path)}`)
            .then((data) => { state.content.set(key, parseContent(data, file)); })
            .catch((err) => { state.content.set(key, { status: "unavailable", reason: errorMessage(err) }); })
            .finally(() => {
            if (state.view.type === "file" && state.view.path === file.path && !state.dragging) {
                render();
                revealPendingJump();
            }
        });
    }
    return entry ?? { status: "loading" };
}
function buildFullFile(file, lines) {
    const hunks = [];
    let nextNew = 1;
    let nextOld = 1;
    const gap = (untilNew) => {
        const rows = [];
        for (let n = nextNew; n < untilNew; n++)
            rows.push({ t: "ctx", o: nextOld + (n - nextNew), n, s: lines[n - 1] ?? "" });
        if (rows.length)
            hunks.push({ gap: true, rows });
        nextOld += Math.max(0, untilNew - nextNew);
        nextNew = Math.max(nextNew, untilNew);
    };
    for (const hunk of file.hunks) {
        const newStart = hunk.newStart ?? 1;
        const newLines = hunk.newLines ?? 0;
        const oldStart = hunk.oldStart ?? 1;
        const oldLines = hunk.oldLines ?? 0;
        gap(newLines > 0 ? newStart : newStart + 1);
        hunks.push(hunk);
        nextNew = (newLines > 0 ? newStart : newStart + 1) + newLines;
        nextOld = (oldLines > 0 ? oldStart : oldStart + 1) + oldLines;
    }
    gap(lines.length + 1);
    return { ...file, hunks, full: true };
}
// The file object rendered for a path in the current view: full file in file view when loaded.
function displayFile(path) {
    const file = fileOf(path);
    if (!file || state.view.type !== "file" || state.view.path !== path || !needsContent(file))
        return file;
    const entry = contentEntry(file);
    if (state.selection?.path === path && state.selection.full === false)
        return file;
    return entry.status === "ready" ? entry.full : file;
}
// Where a thread renders inside a file view, or null when it cannot be placed in the diff.
function placeThread(thread, file) {
    const loc = thread.location;
    if (!file || !loc || loc.path !== file.path)
        return null;
    if (thread.kind === "file")
        return { where: "file" };
    if (loc.state === "outdated")
        return null;
    if (loc.startLine === undefined || loc.endLine === undefined)
        return null;
    const key = loc.side === "old" ? "o" : "n";
    for (let h = 0; h < file.hunks.length; h++) {
        const hunk = file.hunks[h];
        if (thread.kind === "change") {
            if (hunk.gap)
                continue;
            const r = hunkAnchorRange(hunk);
            if (r && r.side === loc.side && r.startLine <= loc.endLine && r.endLine >= loc.startLine)
                return { where: "hunk", hunk: h };
            continue;
        }
        for (let i = hunk.rows.length - 1; i >= 0; i--) {
            if (hunk.rows[i][key] === loc.endLine)
                return { where: "row", hunk: h, row: i };
        }
    }
    return null;
}
function isPlaced(thread) {
    if (thread.kind === "overview")
        return true;
    return placeThread(thread, fileOf(thread.location?.path)) !== null;
}
function lineLabel(loc) {
    if (!loc || loc.startLine == null)
        return "";
    return loc.startLine === loc.endLine ? `L${loc.startLine}` : `L${loc.startLine}–${loc.endLine}`;
}
function locLabel(thread) {
    const loc = thread.location ?? thread.anchor ?? {};
    if (thread.kind === "overview")
        return "Overall";
    if (thread.kind === "file")
        return loc.path ?? "";
    return `${loc.path ?? ""} ${lineLabel(loc)}${loc.side === "old" ? " (old)" : ""}`;
}
const STATUS_LETTER = { modified: "M", added: "A", deleted: "D", renamed: "R" };
// ---------- Rendering ----------
function render() {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLTextAreaElement ? active.dataset.composer : undefined;
    const selStart = active instanceof HTMLTextAreaElement ? active.selectionStart : null;
    const selEnd = active instanceof HTMLTextAreaElement ? active.selectionEnd : null;
    // Keep keyboard focus on a swipe or opacity slider across background re-renders.
    const imageControl = active instanceof HTMLInputElement && active.dataset?.imageControl
        ? `input[data-image-control="${CSS.escape(active.dataset.imageControl)}"][data-path="${CSS.escape(active.dataset.path ?? "")}"]` : "";
    const main = $("#main");
    if (!main)
        return;
    const scroll = main.scrollTop;
    renderTop();
    renderLoadStatus();
    renderBanner();
    renderSide();
    renderMain();
    refreshDestinationPreviews();
    const outsideReplies = outsideDraftRepliesHtml();
    if (pinnedComposers.size || outsideReplies) {
        main.insertAdjacentHTML("afterbegin", outsideReplies + [...pinnedComposers].map(([key, options]) => `<div class="thread"><div class="muted">Diff changed. This comment keeps its original location in ${esc(options.revisionId)}.</div>${composerHtml(key, options)}</div>`).join(""));
    }
    paintImageDiffs();
    main.scrollTop = scroll;
    renderRuler();
    if (imageControl)
        document.querySelector(imageControl)?.focus();
    if (focusKey) {
        const el = document.querySelector(`textarea[data-composer="${CSS.escape(focusKey)}"]`);
        if (el) {
            el.focus();
            if (selStart != null)
                el.setSelectionRange(selStart, selEnd);
        }
    }
}
function scopeToggleHtml(scope) {
    const button = (value, label, title) => `<button type="button" data-action="scope" data-scope="${value}" aria-pressed="${scope === value}" title="${esc(title)}"${state.switching ? " disabled" : ""}>${label}</button>`;
    return `<span class="seg" role="group" aria-label="Review scope">`
        + button("all", "All changes", "Everything on this branch since it diverged from the base, plus uncommitted work")
        + button("pending", "Pending changes", "Only uncommitted work: staged, unstaged and untracked files compared with HEAD")
        + `</span>`;
}
function reviewSettingsMenuHtml() {
    const settings = [];
    if (state.settings)
        settings.push(`<button data-action="configure">Manual review settings</button>`);
    if (state.agentReviewAvailable)
        settings.push(`<button data-action="agent-review-configure">Agent review settings</button>`);
    return settings.length
        ? `<details class="review-settings-menu"><summary title="Configure review settings">Settings</summary><div class="review-settings-options" role="group" aria-label="Review settings">${settings.join("")}</div></details>`
        : "";
}
function prLink(pr, className, label, title) {
    return `<a class="pill pr-link ${className}" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${esc(label)}</a>`;
}
function completedLabel(pr) {
    return `Completed · PR #${pr.number} merged${pr.baseRefName ? ` into ${pr.baseRefName}` : ""}${pr.mergedAt ? ` · ${ago(pr.mergedAt)}` : ""}`;
}
const mergedTitle = (pr) => `Pull request #${pr.number} merged${pr.mergedAt ? ` ${new Date(pr.mergedAt).toLocaleString()}` : ""}. Open it in the browser.`;
// A failed lookup keeps the last known pull request but never reports a completion it did not observe.
function pullRequestPills(r, scope) {
    const completion = r.completions?.at(-1)?.pullRequest ?? null;
    const pr = state.pullRequest;
    const status = state.pullRequestStatus;
    const error = status?.error ?? null;
    const checked = status?.checkedAt ? `Last successful check: ${new Date(status.checkedAt).toLocaleString()}.` : "No successful check yet.";
    const staleTitle = `Could not check the pull request on GitHub: ${error ?? ""} ${checked}`;
    const heading = [];
    if (completion)
        heading.push(prLink(completion, "pr-completed", completedLabel(completion), mergedTitle(completion)));
    const current = pr && pr.number !== completion?.number ? pr : null;
    if (current && error) {
        heading.push(prLink(current, "pr-stale warn", `PR #${current.number} · status may be stale`, `Last known state: ${current.state}. ${staleTitle}`));
    }
    else if (current?.state === "open") {
        heading.push(prLink(current, "pr-open", `PR #${current.number} · Awaiting merge`, `Pull request #${current.number} is open and has not merged yet. Open it in the browser.`));
    }
    else if (current?.state === "merged") {
        heading.push(prLink(current, "pr-completed", completedLabel(current), mergedTitle(current)));
    }
    else if (current) {
        heading.push(prLink(current, "pr-closed", `PR #${current.number} closed without merging`, `Pull request #${current.number} was closed without merging. This review stays active.`));
    }
    else if (error) {
        heading.push(`<span class="pill ${completion ? "warn" : "muted"} pr-stale" title="${esc(staleTitle)}">${completion ? "PR status may be stale" : "PR status unknown"}</span>`);
    }
    let localWork = null;
    const open = pr?.state === "open" && pr.number !== completion?.number ? pr : null;
    const delivered = open ? null : completion ?? (pr?.state === "merged" ? pr : null);
    const reference = open ?? delivered;
    if (scope === "all" && reference) {
        const commits = pr?.number === reference.number ? status?.commitsAfterHead ?? null : null;
        const uncommitted = r.git?.uncommittedFiles ?? 0;
        const counts = [
            commits ? `${commits} ${commits === 1 ? "commit" : "commits"}` : "",
            uncommitted ? `${uncommitted} uncommitted` : "",
        ].filter(Boolean).join(" · ");
        const title = open
            ? `Local work that pull request #${open.number} does not contain yet. All changes shows the pull request together with this work.`
            : `Work added after pull request #${reference.number}. It stays active in All changes.`;
        localWork = counts ? `<span class="pill warn local-work" title="${esc(title)}">${open ? "Not in" : "After"} PR #${reference.number}: ${counts}</span>` : "";
    }
    return { heading: heading.join(""), localWork };
}
function renderTop() {
    const r = state.review;
    if (!r)
        return;
    const top = requiredElement("#top");
    const previousSettingsMenu = top.querySelector(".review-settings-menu");
    const active = document.activeElement;
    const activeInSettingsMenu = active instanceof HTMLElement && previousSettingsMenu?.contains(active);
    const activeParallelismBadge = active instanceof HTMLElement && active.dataset.action === "configure-parallelism";
    const settingsMenuWasOpen = previousSettingsMenu?.open ?? false;
    const focusedSettingsSummary = activeInSettingsMenu && active === previousSettingsMenu?.querySelector("summary");
    const focusedSettingsAction = activeInSettingsMenu && active instanceof HTMLElement ? active.dataset.action : undefined;
    const rev = r.revisions.find((x) => x.revisionId === r.currentRevisionId);
    const git = r.git ?? {};
    const scope = scopeOf(r);
    const deliveries = r.threads.flatMap(t => t.messages.map(m => m.delivery));
    const queued = deliveries.filter(d => d?.state === "queued").length;
    const processing = deliveries.filter(d => d?.state === "processing");
    const ready = processing.filter(d => d?.parallelPhase === "ready").length;
    const applying = processing.filter(d => d?.parallelPhase === "applying").length;
    const limit = state.settings?.commentConcurrency ?? 1;
    const running = processing.length - ready - applying;
    const counts = limit > 1 || processing.some(d => d?.parallel) || queued || running
        ? ` · ${queued} queued · ${running} running${ready ? ` · ${ready} waiting to apply` : ""}${applying ? ` · ${applying} applying` : ""}`
        : "";
    // The host reports the owning conversation as busy even when it is handling something other than these comments.
    const commentsActive = running || ready || applying;
    const branch = `<span class="pill mono" title="HEAD ${esc(git.headCommit ?? "")}">${esc(r.branch ?? "?")}</span>`;
    const prStatus = pullRequestPills(r, scope);
    const separated = scope === "all" && git.delivered?.separation === "separated";
    const parts = [
        `<section class="change-context" role="group" aria-label="Change context">`,
        `<div class="change-context-heading"><span class="title">${esc(r.title)}</span>${branch}`,
        separated ? `<span class="muted">vs</span><span class="pill mono" title="Showing work after pull request #${git.delivered.pullRequestNumber}'s head ${esc(git.baseCommit ?? "")}. Its delivered changes are in Review history.">PR #${git.delivered.pullRequestNumber} head</span>`
            : scope === "all" ? `<span class="muted">vs</span><span class="pill mono" title="merge-base ${esc(git.baseCommit ?? "")}">${esc(r.base)}</span>`
                : `<span class="muted">uncommitted changes only</span>`,
        rev ? `<span class="pill" title="Revision captured ${esc(rev.createdAt)}">${esc(rev.revisionId)} · ${rev.files} files · <span class="add">+${rev.additions}</span> <span class="del">−${rev.deletions}</span></span>` : "",
        prStatus.heading,
        `</div><div class="change-context-details">`,
    ];
    if (scope === "all") {
        if (git.upstream) {
            const { ahead, behind, name } = git.upstream;
            const countsUnavailable = ahead === null || behind === null;
            const countLabel = countsUnavailable ? "↑? ↓?" : `↑${ahead} ↓${behind}`;
            const hasChanges = !countsUnavailable && (ahead !== 0 || behind !== 0);
            parts.push(`<span class="pill${countsUnavailable || hasChanges ? " warn" : ""}" title="${esc(name)}">${countLabel}</span>`);
        }
        else if (git.branch)
            parts.push(`<span class="pill warn">no upstream</span>`);
        if (prStatus.localWork !== null)
            parts.push(prStatus.localWork);
        else if (git.uncommittedFiles)
            parts.push(`<span class="pill warn" title="Diff includes working-tree changes">${git.uncommittedFiles} uncommitted</span>`);
        if (git.delivered?.separation === "unavailable") {
            parts.push(`<span class="pill warn" title="The head commit of pull request #${git.delivered.pullRequestNumber} is not in this clone, so All changes still includes what it delivered. Fetch the pull request head, then Refresh.">Delivered changes not separated</span>`);
        }
    }
    if (limit > 1)
        parts.push(`<button type="button" class="pill" data-action="configure-parallelism" aria-haspopup="dialog" title="Change how many comments are analyzed together in this repository">Parallelism: ${limit}</button>`);
    if (state.connection === "lost")
        parts.push(`<span class="pill warn" title="If this persists, reopen the canvas">disconnected</span>`);
    else if (commentsActive)
        parts.push(`<span class="pill busy"><span class="dot"></span>Copilot working${counts}</span>`);
    else if (state.busy === true)
        parts.push(`<span class="pill busy" title="${queued ? "Copilot is finishing other work in this conversation. Queued comments start when it picks them up." : "Copilot is working in this conversation."}"><span class="dot"></span>Copilot busy${counts}</span>`);
    else if (state.busy === false || queued)
        parts.push(`<span class="pill"><span class="dot muted"></span>Copilot idle${counts}</span>`);
    parts.push(`<span class="spacer"></span>${agentReviewButtonHtml()}${reviewSettingsMenuHtml()}<button data-action="refresh" title="Re-read the working tree">Refresh</button></div></section>`);
    const drafts = draftMessages().length;
    const controls = [];
    if (drafts)
        controls.push(`<span class="feedback-draft-count">${drafts} draft ${drafts === 1 ? "comment" : "comments"}</span>`);
    if (drafts)
        controls.push(`<button class="primary" data-action="submit-review" title="Send every draft comment to Copilot together, as one review"${state.submitting ? " disabled>Submitting…" : `>Submit review (${drafts})`}</button>`);
    if (controls.length)
        parts.push(`<div class="review-controls">${controls.join("")}</div>`);
    top.innerHTML = parts.join("");
    const settingsMenu = top.querySelector(".review-settings-menu");
    if (activeParallelismBadge) {
        const badge = top.querySelector('[data-action="configure-parallelism"]');
        if (badge)
            badge.focus();
        else
            settingsMenu?.querySelector("summary")?.focus();
    }
    if (!settingsMenu)
        return;
    settingsMenu.open = settingsMenuWasOpen;
    if (activeInSettingsMenu) {
        if (focusedSettingsSummary || !settingsMenuWasOpen)
            settingsMenu.querySelector("summary")?.focus();
        else if (focusedSettingsAction)
            settingsMenu.querySelector(`[data-action="${focusedSettingsAction}"]`)?.focus();
    }
}
// ---------- Repository settings: first-use banner, per-review delivery question, and Configure dialog ----------
function learningBannerHtml() {
    const s = state.settings;
    if (!s || s.configured || s.dismissed)
        return "";
    return `<div class="banner-row"><span class="banner-text"><strong>Auto-save learned rules in ${esc(s.repoName)}?</strong> Copilot proposes reusable guidelines from your feedback. By default, you choose which guidelines to save.</span>`
        + `<span class="banner-actions"><button data-action="learning-set" data-enabled="false" class="primary">Keep manual saving</button><button data-action="learning-set" data-enabled="true">Enable auto-save</button>`
        + `<button class="link" data-action="learning-dismiss" title="Hide this notice without enabling auto-save.">Not now</button></span></div>`;
}
// Shown while an ask-mode review is undecided; until then the server holds new comments as drafts.
function deliveryBannerHtml() {
    if (!state.settings || !state.review || deliveryRepoMode() !== "ask" || deliveryMode())
        return "";
    const drafts = draftMessages().length;
    const waiting = drafts ? `${drafts} draft ${drafts === 1 ? "comment is" : "comments are"} waiting.` : "Until you choose, new comments wait as drafts.";
    const choice = (mode, label) => `<button data-action="delivery-choose" data-mode="${mode}" title="${esc(DELIVERY[mode].hint)}">${label}</button>`;
    return `<div class="banner-row"><span class="banner-text"><strong>How should Copilot receive your comments on this review?</strong> Send each one as you post it, or batch them and submit the review when you are done. ${waiting}</span>`
        + `<span class="banner-actions">${choice("immediate", "Send each now")}${choice("batch", "Batch into a review")}</span></div>`;
}
function bannerHtml() {
    return learningBannerHtml() + deliveryBannerHtml();
}
function renderBanner() {
    const el = $("#banner");
    const html = bannerHtml();
    if (!el)
        return;
    el.hidden = !html;
    el.innerHTML = html;
}
function choicesHtml(name, modes, table, selected) {
    return modes.map((mode) => `<label class="choice"><input type="radio" name="${name}" value="${mode}"${selected === mode ? " checked" : ""}>`
        + `<span><span class="choice-title">${esc(table[mode].label)}</span><span class="choice-hint">${esc(table[mode].hint)}</span></span></label>`).join("");
}
function dialogHtml() {
    const d = state.dialog;
    if (!d)
        return "";
    if (d.type === "agent-review")
        return agentReviewDialogHtml(d);
    return `<div class="modal-backdrop" data-action="dialog-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc">`
        + `<h2 id="dialog-title">Review settings</h2>`
        + `<p id="dialog-desc" class="muted">Settings for ${esc(state.settings?.repoName ?? "this repository")}. They are stored on this machine only and never committed.</p>`
        + `<fieldset class="choices"><legend>Guidelines</legend><label><input type="checkbox" name="autoSaveLearnedRules"${d.autoSaveLearnedRules ? " checked" : ""}> Auto-save learned rules</label><p>When off, review and save proposed guidelines yourself.</p></fieldset>`
        + `<fieldset class="choices instruction-mappings"><legend>Repository instruction destinations</legend>`
        + `<p class="muted">Map a repository-relative path prefix to the folder that contains its .github instructions. The longest matching prefix wins; an empty prefix is the repository-root default. These mappings are per-user and shared across clones and worktrees.</p>`
        + (d.instructionMappings.length ? d.instructionMappings.map((mapping, index) => `<div class="instruction-mapping" data-mapping-index="${index}">`
            + `<label>Path prefix <input name="mapping-prefix" data-index="${index}" value="${esc(mapping.pathPrefix)}" placeholder="(repository root)"></label>`
            + `<label>Instruction root <input name="mapping-root" data-index="${index}" value="${esc(mapping.instructionRoot)}" placeholder="(repository root)"></label>`
            + `<label><input type="checkbox" name="mapping-split" data-index="${index}"${mapping.splitLanguageSpecific ? " checked" : ""}> Split language-specific rules into scoped files</label>`
            + `<button data-action="mapping-remove" data-index="${index}">Remove mapping</button></div>`).join("")
            : `<p class="muted">No mappings yet. Repository rules remain proposals until a destination is configured.</p>`)
        + `<button data-action="mapping-add">Add destination mapping</button></fieldset>`
        + `<fieldset class="choices"><legend>Send comments to Copilot</legend>${choicesHtml("delivery", DELIVERY_MODES, DELIVERY, d.delivery)}</fieldset>`
        + `<fieldset class="choices"><legend>Comment processing</legend><label>Concurrent comments <select name="commentConcurrency" aria-describedby="comment-concurrency-hint">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === (d.commentConcurrency ?? 1) ? " selected" : ""}>${n === 1 ? "1 (serial)" : n}</option>`).join("")}</select></label><p id="comment-concurrency-hint">2–4 comments can be analyzed together in this checkout. Only the coordinator edits, one change at a time. Follow-ups in the same thread wait their turn.</p></fieldset>`
        + (d.error ? `<div class="modal-error" role="alert">${esc(d.error)}</div>` : "")
        + `<div class="modal-actions"><button data-action="dialog-cancel"${d.saving ? " disabled" : ""}>Cancel</button>`
        + `<button class="primary" data-action="dialog-save"${d.saving ? " disabled" : ""}>${d.saving ? "Saving…" : "Save"}</button></div>`
        + `</div></div>`;
}
function focusIn(selector) {
    const target = $(selector);
    const closedMenu = target?.closest("details:not([open])");
    (closedMenu?.querySelector?.("summary") ?? target)?.focus?.();
}
// The dialog is rendered on its own so re-renders of the page never disturb its focus or radio state.
function renderDialog() {
    const active = document.activeElement instanceof HTMLElement && document.activeElement.closest("#dialog") ? document.activeElement : null;
    const key = active instanceof HTMLInputElement && active.name ? `[name="${active.name}"]${active.type === "checkbox" ? `[value="${CSS.escape(active.value)}"]` : ""}`
        : active instanceof HTMLSelectElement && active.name ? `[name="${active.name}"]`
            : active instanceof HTMLTextAreaElement && active.name ? `[name="${active.name}"]`
                : active?.dataset?.action ? `[data-action="${active.dataset.action}"]` : null;
    const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
        ? [active.selectionStart, active.selectionEnd] : null;
    const dialog = $("#dialog");
    if (!dialog)
        return;
    dialog.innerHTML = dialogHtml();
    for (const id of ["#top", "#banner", "#layout", "#review-status-slot"]) {
        const el = $(id);
        if (el)
            el.inert = Boolean(state.dialog);
    }
    const restored = key ? document.querySelector(`#dialog ${key}`) : null;
    if (restored && !("disabled" in restored && restored.disabled)) {
        restored.focus();
        if (selection && selection[0] !== null
            && (restored instanceof HTMLTextAreaElement || (restored instanceof HTMLInputElement && restored.type === "text"))) {
            restored.setSelectionRange(...selection);
        }
    }
}
function openConfigure(opener = "configure") {
    if (!state.settings || state.dialog)
        return;
    const mappings = state.settings.instructionMappings.map((mapping) => ({ ...mapping }));
    state.dialog = {
        type: "configure", opener, autoSaveLearnedRules: autoSaveLearnedRules(), delivery: deliveryRepoMode(),
        commentConcurrency: state.settings.commentConcurrency ?? 1,
        originalInstructionMappings: mappings.map((mapping) => ({ ...mapping })),
        instructionMappings: mappings,
        saving: false, error: "",
    };
    renderDialog();
    focusIn(opener === "configure-parallelism" ? '#dialog select[name="commentConcurrency"]' : '#dialog input[name="autoSaveLearnedRules"]');
}
function closeConfigure() {
    if (!state.dialog || state.dialog.saving)
        return;
    const opener = state.dialog.type === "agent-review" ? state.dialog.opener ?? "agent-review" : state.dialog.opener;
    state.dialog = null;
    renderDialog();
    const returnTo = opener === "configure-parallelism" && (state.settings?.commentConcurrency ?? 1) <= 1 ? "configure" : opener;
    focusIn(`[data-action="${returnTo}"]`);
}
function reviewSkillsSectionHtml(d) {
    const disabled = d.saving || d.skillsLoading;
    const names = d.skillNames ?? [];
    const rows = (d.skillCatalog?.skills ?? []).map((skill) => {
        const source = `${skill.upstream.repository}/blob/${skill.upstream.release}/${skill.upstream.path}`;
        return `<label class="choice skill-choice"><input type="checkbox" name="review-skill" value="${esc(skill.name)}"${names.includes(skill.name) ? " checked" : ""}${disabled ? " disabled" : ""}>`
            + `<span><span class="skill-group-name">${esc(skill.title)}</span> <code>${esc(skill.name)}</code>${skill.role === "ponytail" ? " - separate top-level benefits note" : " - review guidance"}`
            + `<span class="choice-hint">${esc(skill.summary)}<br>Bundled with Self-Review: unmodified snapshot of <a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(skill.upstream.repository.replace("https://github.com/", ""))} ${esc(skill.upstream.release)}</a> (file commit ${esc(skill.upstream.fileCommit.slice(0, 7))}). License: ${esc(skill.license.spdx)}.`
            + `${skill.attribution ? `<br>${esc(skill.attribution)}` : ""}</span></span></label>`;
    }).join("");
    return `<fieldset class="choices review-skills-section"><legend>Review skills</legend>`
        + `<p class="muted">These skills ship with Self-Review and are on by default. Their full text is given to every reviewer in the run. Uncheck any you do not want; nothing is installed or downloaded.</p>`
        + (d.skillsLoading && !d.skillCatalog ? `<p class="muted" role="status">Loading bundled skills...</p>` : "")
        + rows
        + (d.skillsError ? `<div class="modal-error" role="alert">${esc(d.skillsError)}</div><button data-action="review-skills-refresh"${disabled ? " disabled" : ""}>Retry</button>` : "")
        + (state.agentReviewSettingsAvailable ? `<label class="choice"><input type="checkbox" name="review-skill-defaults"${d.saveSkillDefaults ? " checked" : ""}${disabled || !d.skillCatalog ? " disabled" : ""}><span>Save these skill choices as my defaults across repositories</span></label>` : "")
        + `<p class="muted">Unchecked choices apply to this review until you save them as defaults. Third-party notices and license texts are in the extension's bundled-skills folder.</p></fieldset>`;
}
async function refreshReviewSkills() {
    const d = state.dialog;
    if (d?.type !== "agent-review" || d.saving || d.skillsLoading)
        return;
    d.skillsLoading = true;
    d.skillsError = "";
    renderDialog();
    try {
        const firstLoad = !d.skillCatalog;
        const catalog = parseSkillCatalog(await api("GET", "review-skills"));
        if (state.dialog !== d)
            return;
        d.skillCatalog = catalog;
        if (firstLoad && d.skillNames === undefined) {
            d.skillNames = [...catalog.selected];
        }
    }
    catch (err) {
        d.skillsError = errorMessage(err);
    }
    finally {
        d.skillsLoading = false;
        if (state.dialog === d) {
            renderDialog();
            if (!document.activeElement?.closest?.("#dialog"))
                focusIn(d.skillsError ? '#dialog [data-action="review-skills-refresh"]' : '#dialog [data-action="review-tab"][aria-selected="true"]');
        }
    }
}
function reviewTabsHtml(d) {
    const tab = (id, label) => `<button role="tab" id="review-tab-${id}" class="review-tab" data-action="review-tab" data-tab="${id}" aria-controls="review-panel-${id}" aria-selected="${d.tab === id}">${label}</button>`;
    return `<div class="review-tabs" role="tablist" aria-label="Review settings sections">${tab("general", "General")}${tab("skills", "Review skills")}</div>`;
}
function agentReviewDialogHtml(d) {
    const options = [["review", "Review issues"], ["simplify", "Simplification"], ["both", "Review and simplification"]];
    return `<div class="modal-backdrop" data-action="dialog-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc">`
        + (d.settingsOnly
            ? `<h2 id="dialog-title">Agent review settings</h2><p id="dialog-desc">Configure reviewers, focus, guidance, and review skills. Saving never starts a review; use Run agentic review in the Agent reviews view.</p>`
            : `<h2 id="dialog-title">Agentic review</h2><p id="dialog-desc">Review ${esc(d.revisionId)} (${esc(d.scope)}). Selected models review independently, discuss, and vote; these additional calls may consume credits. Only unanimous findings are published. An unavailable reviewer prevents publication. No files are changed until you approve a suggestion or explicitly request a fix.</p>`)
        + reviewTabsHtml(d)
        + `<div role="tabpanel" id="review-panel-general" aria-labelledby="review-tab-general"${d.tab === "general" ? "" : " hidden"}>`
        + `<label class="review-field">Reviewers (two to four model IDs, comma-separated)<input name="review-models" value="${esc(d.models)}" maxlength="483" autocomplete="off"${d.saving ? " disabled" : ""}></label>`
        + `<p class="muted">Use exact model IDs available in your Copilot session, or copilot-fusion to run Copilot Fusion in a child session that reports back later. An unavailable reviewer is reported as a failure, never silently replaced.</p>`
        + `<label class="review-field"><span id="review-focus-label">Focus</span><select name="review-focus" aria-labelledby="review-focus-label"${d.saving ? " disabled" : ""}>${options.map(([value, label]) => `<option value="${value}"${d.focus === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>`
        + `<label class="review-field">Goal, spec, or review guidance (optional)<textarea name="review-intent" maxlength="4000" rows="3" placeholder="Acceptance criteria, a spec reference, or focused review guidance"${d.saving ? " disabled" : ""}>${esc(d.intent)}</textarea></label>`
        + `<p class="muted">The coordinating agent checks findings against the code, baseline, and relevant callers or tests before reporting them. Missing evidence is reported, not treated as a pass.</p>`
        + (state.agentReviewSettingsAvailable
            ? `<fieldset class="choices"><legend>User defaults for all repositories</legend>`
                + `<label class="choice"><input type="checkbox" name="review-save-defaults"${d.saveDefaults ? " checked" : ""}${d.saving ? " disabled" : ""}><span>Save these models, focus, and guidance as my defaults</span></label>`
                + `<label class="choice"><input type="checkbox" name="review-skip-dialog"${d.skipDialog ? " checked" : ""}${d.saving || !d.saveDefaults ? " disabled" : ""}><span>Run with saved defaults without asking again</span></label>`
                + `<p class="muted">Each click on Run agentic review authorizes a credit-consuming review. Nothing runs on save or when opening a canvas. Fixes still need approval. Saved guidance applies across repositories; avoid repository-specific instructions.</p></fieldset>` : "")
        + `</div><div role="tabpanel" id="review-panel-skills" aria-labelledby="review-tab-skills"${d.tab === "skills" ? "" : " hidden"}>`
        + (state.reviewSkillsAvailable ? reviewSkillsSectionHtml(d) : `<p class="muted" role="status">Bundled review skills are unavailable in this build. Reviews run with the built-in guidance.</p>`)
        + `</div>`
        + (d.error ? `<div class="modal-error" role="alert">${esc(d.error)}</div>` : "")
        + `<div class="modal-actions"><button data-action="dialog-cancel"${d.saving ? " disabled" : ""}>Cancel</button>`
        + (state.agentReviewSettingsAvailable ? `<button${d.settingsOnly ? ' class="primary"' : ""} data-action="agent-review-save-defaults"${d.saving || d.skillsLoading || !(d.saveDefaults || d.saveSkillDefaults) ? " disabled" : ""}>Save defaults</button>` : "")
        + (d.settingsOnly && state.reviewSkillsAvailable ? `<button data-action="agent-review-apply-skills"${d.saving || d.skillsLoading || !d.skillCatalog ? " disabled" : ""}>Apply for this review</button>` : "")
        + (d.settingsOnly ? "" : `<button class="primary" data-action="agent-review-start"${d.saving || d.skillsLoading ? " disabled" : ""}>${d.saving ? "Please wait..." : "Run review"}</button>`)
        + `</div></div></div>`;
}
function openAgentReview(opener = "agent-review") {
    if (!state.agentReviewAvailable || !state.review || state.dialog)
        return;
    const revisionId = state.review.currentRevisionId;
    const last = state.review.agentReviews?.at(-1);
    const defaults = state.agentReviewSettings;
    state.dialog = {
        type: "agent-review", reviewId: state.review.reviewId, revisionId,
        scope: scopeLabel(scopeOf(state.review)), models: (defaults?.models ?? last?.models ?? state.agentReviewSuggestedModels).join(", "),
        focus: defaults?.focus ?? (isReviewFocus(last?.focus) ? last.focus : "review"), intent: defaults?.intent ?? "", saving: false,
        skillNames: state.skillOverrides.get(state.review.reviewId) ?? defaults?.skillNames,
        skillCatalog: null, skillsLoading: false, skillsError: "", saveSkillDefaults: false, tab: "general",
        saveDefaults: Boolean(defaults), skipDialog: defaults?.skipDialog ?? false, opener, settingsOnly: opener === "agent-review-configure", error: state.agentReviewSettingsError,
    };
    renderDialog();
    focusIn('#dialog input[name="review-models"]');
    if (state.reviewSkillsAvailable)
        refreshReviewSkills().catch((err) => toast(errorMessage(err), true));
}
function agentReviewOptions(d) {
    return { models: d.models.split(",").map((m) => m.trim()), focus: d.focus, intent: d.intent,
        ...(d.skillNames !== undefined ? { skillNames: d.skillNames } : {}) };
}
async function saveAgentReviewDefaults(d) {
    const { skillNames: _skillNames, ...options } = agentReviewOptions(d);
    state.agentReviewSettings = await settingsApi.updateAgentReview({ ...options, skipDialog: d.skipDialog });
    state.agentReviewSettingsError = "";
}
async function startAgentReview(saveOnly = false) {
    const d = state.dialog;
    if (d?.type !== "agent-review" || d.saving || (d.settingsOnly && !saveOnly))
        return;
    d.saving = true;
    d.error = "";
    renderDialog();
    try {
        if (!saveOnly && (d.reviewId !== state.review?.reviewId || d.revisionId !== state.review?.currentRevisionId)) {
            throw new Error("The review scope changed or revision is stale. Close this dialog and try again.");
        }
        if (saveOnly && !d.saveDefaults && !d.saveSkillDefaults)
            throw new Error("Select Save these models, focus, and guidance, or save skill choices, first.");
        if (d.saveDefaults)
            await saveAgentReviewDefaults(d);
        if (d.saveSkillDefaults) {
            if (d.reviewId !== state.review?.reviewId)
                throw new Error("The review changed. Close this dialog and try again.");
            await api("POST", "review-skills", { names: d.skillNames ?? [], saveDefaults: true });
        }
        if (d.skillCatalog && d.skillNames !== undefined)
            state.skillOverrides.set(d.reviewId, [...d.skillNames]);
        if (!saveOnly) {
            if (d.reviewId !== state.review?.reviewId || d.revisionId !== state.review?.currentRevisionId) {
                throw new Error("The review scope changed or revision is stale. Close this dialog and try again.");
            }
            await api("POST", "agent-reviews", { ...agentReviewOptions(d), revisionId: d.revisionId });
        }
        state.dialog = null;
        renderDialog();
        focusIn('[data-action="agent-review"]');
        await loadState();
        toast(saveOnly ? "User defaults saved. No review was started." : "Review requested. Model results will appear as suggestions.");
    }
    catch (err) {
        d.saving = false;
        d.error = errorMessage(err);
        if (state.dialog === d)
            renderDialog();
        await loadState().catch((loadError) => toast(errorMessage(loadError), true));
    }
}
function applyReviewSkills() {
    const d = state.dialog;
    if (d?.type !== "agent-review" || d.saving || !d.skillCatalog)
        return;
    if (d.reviewId !== state.review?.reviewId) {
        d.error = "The review changed. Close this dialog and try again.";
        renderDialog();
        return;
    }
    state.skillOverrides.set(d.reviewId, [...(d.skillNames ?? [])]);
    state.dialog = null;
    renderDialog();
    focusIn('[data-action="agent-review-configure"]');
    toast("Review skills applied to this review only. Defaults are unchanged and no review was started.");
}
async function runAgentReview() {
    if (!state.agentReviewAvailable || !state.review || state.dialog || state.startingReview
        || state.review.agentReviews?.some((run) => ["sending", "queued", "running"].includes(run.state)))
        return;
    if (!state.agentReviewSettings?.skipDialog || state.agentReviewSettings.models.length < 2 || state.agentReviewSettingsError) {
        openAgentReview();
        return;
    }
    const reviewId = state.review.reviewId;
    const revisionId = state.review.currentRevisionId;
    state.startingReview = true;
    renderTop();
    try {
        await loadState();
        if (state.review?.reviewId !== reviewId || state.review.currentRevisionId !== revisionId) {
            toast("The review scope or revision changed. Confirm the current review before starting.");
            return;
        }
        if (!state.agentReviewSettings?.skipDialog || state.agentReviewSettings.models.length < 2 || state.agentReviewSettingsError) {
            openAgentReview();
            return;
        }
        const skillNames = state.skillOverrides.get(reviewId);
        await api("POST", "agent-reviews", { useDefaults: true, oneClick: true, revisionId, ...(skillNames !== undefined ? { skillNames } : {}) });
        toast("Review requested with your saved defaults.");
    }
    finally {
        state.startingReview = false;
        renderTop();
        render();
        await loadState();
    }
}
function agentComments() {
    return state.review?.threads.filter((thread) => Boolean(thread.agentReview)) ?? [];
}
function agentCommentsView() {
    const review = state.review;
    if (!review)
        return "";
    const threads = agentComments();
    const active = threads.filter((thread) => thread.status === "active").length;
    const older = threads.filter((thread) => thread.agentReview.revisionId !== review.currentRevisionId).length;
    return `<div class="agent-reviews-heading"><h2>Agent reviews</h2>${agentReviewButtonHtml()}</div>`
        + agentReviewsHtml()
        + `<h2>Agent comments (<span aria-live="polite">${threads.length}</span>)</h2>`
        + `<p class="muted">${active} active, ${threads.length - active} closed or resolved; ${older} from older revisions. Counts include all agent findings in this scope, not replies or manual threads.</p>`
        + (threads.length ? threads.map((thread) => threadHtml(thread, { showLocation: true })).join("") : `<div class="empty">No agent comments yet. A review may still be running or may have reported no findings; check its status above.</div>`);
}
function agentReviewButtonHtml() {
    const review = state.review;
    if (!review || !state.agentReviewAvailable)
        return "";
    const running = review.agentReviews?.some((run) => ["sending", "queued", "running"].includes(run.state));
    const defaults = state.agentReviewSettings;
    const hint = defaults?.skipDialog
        ? `Run with saved defaults: ${defaults.models.join(", ")} (${defaults.focus}). Review, discussion and voting calls may consume credits.`
        : "Configure and run a read-only review, discussion and vote. These calls may consume credits.";
    return `<button class="primary agent-review-launch" data-action="agent-review" title="${esc(hint)}"${running || state.startingReview ? " disabled" : ""}>${running ? "Agentic review running" : state.startingReview ? "Queuing review..." : "Run agentic review"}</button>`;
}
function agentReviewsHtml() {
    const review = state.review;
    const runs = review?.agentReviews ?? [];
    if (!runs.length)
        return "";
    const active = (r) => ["sending", "queued", "running"].includes(r.state);
    return `<h3>Review runs</h3><p class="muted">Assessments and verification are reported by the coordinating agent, not independently attested by the canvas.</p>${[...runs].reverse().map((r) => `<div class="card agent-review-run">`
        + `<strong>${esc(r.focus)}: ${esc(r.state)}</strong> <span class="pill">${agentComments().filter((thread) => thread.agentReview.runId === r.runId).length} agent comments</span> <span class="muted">${esc(r.revisionId)}${r.revisionId !== review?.currentRevisionId ? " (older diff)" : ""}</span>`
        + (r.consensus?.some((group) => group.votes.some((vote) => vote.decision !== "agree"))
            ? `<p class="muted">${r.consensus.filter((group) => group.votes.some((vote) => vote.decision !== "agree")).length} candidates did not reach unanimous agreement and were not published.</p>` : "")
        + (r.intent ? `<p class="review-summary">Goal / spec / guidance: ${esc(r.intent)}</p>` : "")
        + (r.skills?.length ? `<p class="review-summary">Bundled skills supplied: ${esc(r.skills.map((skill) => skill.release ? `${skill.name} (${skill.release})` : skill.name).join(", "))}. See actual use and limits in each result.</p>` : "")
        + (r.error ? `<p class="err">${esc(r.error)}</p>` : "")
        + `<ul>${r.models.map((model) => {
            const result = r.results.find((x) => x.model === model);
            let outcome = active(r) ? (model === "copilot-fusion" ? "Awaiting result from the Copilot Fusion child session" : "Awaiting result") : "Not completed";
            if (result) {
                if (result.error) {
                    outcome = `Failed: ${esc(result.error)}`;
                }
                else {
                    const counts = {};
                    for (const id of result.threadIds) {
                        const assessment = findAnyThread(id)?.agentReview?.assessment;
                        const key = typeof assessment === "string" && Object.hasOwn(FINDING_ASSESSMENTS, assessment) ? assessment : "unverified";
                        counts[key] = (counts[key] ?? 0) + 1;
                    }
                    outcome = result.threadIds.length ? Object.keys(FINDING_ASSESSMENTS).filter((key) => counts[key]).map((key) => `${counts[key]} ${key}`).join(", ")
                        : r.protocol === "consensus-v1" && active(r) ? "Awaiting discussion and consensus"
                            : r.protocol === "consensus-v1" ? "No agreed findings published" : "No findings reported";
                    outcome += `<details><summary>Coverage and verification</summary><p class="review-summary">${esc(result.summary ?? "No coverage or verification summary recorded.")}</p></details>`;
                    if (result.ponytail) {
                        const report = result.ponytail;
                        const groupFor = (index) => r.consensus?.find((group) => group.kind === "ponytail"
                            && group.sources.some((source) => source.model === model && source.index === index));
                        const isAgreed = (index) => {
                            const group = groupFor(index);
                            return !!group && group.votes.length === r.models.length && group.votes.every((vote) => vote.decision === "agree");
                        };
                        const agreedCount = r.protocol === "consensus-v1"
                            ? report.benefits.filter((_, index) => isAgreed(index)).length : report.benefits.length;
                        const ponytailStatus = report.status !== "used" ? "unavailable / not loaded"
                            : r.protocol === "consensus-v1" && active(r) ? "awaiting consensus"
                                : agreedCount ? `${agreedCount} ${r.protocol === "consensus-v1" ? "agreed" : "supported"} opportunities`
                                    : r.protocol === "consensus-v1" ? "no agreed opportunities" : "no supported benefits";
                        outcome += `<details><summary>Ponytail: ${ponytailStatus}</summary>`
                            + `<p class="review-summary">${esc(report.summary)}</p>`
                            + report.benefits.map((entry, index) => {
                                const status = r.protocol !== "consensus-v1" ? ""
                                    : isAgreed(index) ? "Agreed"
                                        : groupFor(index) ? "Not agreed (not published)"
                                            : active(r) ? "Awaiting consensus (not published)" : "Not finalized (not published)";
                                return `<div class="review-summary"><strong>${esc(entry.proposal)}</strong>${status ? ` <span class="muted">${esc(status)}</span>` : ""}<p>${esc(entry.benefit)}</p><p>Source: ${esc(entry.evidence.source)}<br>Baseline: ${esc(entry.evidence.baseline)}<br>Validation/limits: ${esc(entry.evidence.validation)}</p></div>`;
                            }).join("")
                            + (r.consensus?.filter((group) => group.kind === "ponytail"
                                && group.sources.some((source) => source.model === model)
                                && group.votes.every((vote) => vote.decision === "agree")).map((group) => `<p>${group.votes.map((vote) => `${esc(vote.model)}: ${esc(vote.decision)} — ${esc(vote.rationale)}`).join("<br>")}</p>`).join("") ?? "")
                            + `</details>`;
                    }
                }
            }
            return `<li><span class="mono">${esc(model)}</span>: ${outcome}</li>`;
        }).join("")}</ul>`
        + (active(r) ? `<button data-action="agent-review-close" data-run="${esc(r.runId)}" title="Stop accepting results for this review. This does not stop agents already running.">Close review</button>` : "")
        + `</div>`).join("")}`;
}
// A delivery change alters every composer's buttons, so it needs a full render once a diff is shown.
async function updateSettings(patch) {
    const before = deliveryMode();
    const previousMappings = JSON.stringify(state.settings?.instructionMappings ?? []);
    state.settings = await settingsApi.update(patch);
    const mappingsChanged = previousMappings !== JSON.stringify(state.settings.instructionMappings);
    if ((deliveryMode() !== before && state.snapshot) || mappingsChanged) {
        render();
    }
    else {
        renderTop();
        renderBanner();
        renderLoadStatus();
    }
}
async function saveConfigure() {
    const d = state.dialog;
    if (!d || d.type !== "configure" || d.saving)
        return;
    d.saving = true;
    d.error = "";
    renderDialog();
    try {
        const mappingsChanged = JSON.stringify(d.instructionMappings) !== JSON.stringify(d.originalInstructionMappings);
        await updateSettings({
            autoSaveLearnedRules: d.autoSaveLearnedRules, delivery: d.delivery,
            ...(d.commentConcurrency !== (state.settings?.commentConcurrency ?? 1) ? { commentConcurrency: d.commentConcurrency } : {}),
            ...(mappingsChanged ? {
                instructionMappings: d.instructionMappings,
                expectedInstructionMappings: d.originalInstructionMappings,
            } : {}),
        });
        d.saving = false;
        closeConfigure();
        toast(`Saved. ${autoSaveLabel()} · Delivery: ${DELIVERY[deliveryRepoMode()].pill}`);
    }
    catch (err) {
        d.saving = false;
        d.error = errorMessage(err);
        renderDialog();
        focusIn('#dialog [data-action="dialog-save"]');
    }
}
// Keeps Tab inside the open dialog; each radio group is a single tab stop (its checked radio).
function trapTab(e) {
    const groupStop = (name) => {
        const radios = Array.from(document.querySelectorAll(`#dialog input[name="${name}"]`));
        return radios.find((x) => x.checked) ?? radios[0];
    };
    const trapAllFocusable = state.dialog?.type === "agent-review" || state.dialog?.type === "configure";
    const deliveryStop = trapAllFocusable ? undefined : groupStop("delivery");
    const stops = trapAllFocusable
        ? Array.from(document.querySelectorAll("#dialog input:not([disabled]), #dialog select:not([disabled]), #dialog textarea:not([disabled]), #dialog a[href], #dialog button:not([disabled])"))
        : [...(deliveryStop ? [deliveryStop] : []), ...Array.from(document.querySelectorAll("#dialog button:not([disabled])"))];
    if (!stops.length)
        return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    }
    else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}
async function switchScope(scope) {
    if (state.switching || scope === scopeOf(state.review))
        return;
    state.switching = true;
    renderTop();
    renderSide();
    try {
        await api("POST", "scope", { scope });
        await loadState();
    }
    finally {
        state.switching = false;
        renderTop();
        renderSide();
    }
}
function activeCount(pathName) {
    return state.review?.threads.filter((t) => t.status === "active" && t.kind !== "overview" && t.location?.path === pathName).length ?? 0;
}
const CHEVRON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FOLDER_ICON = `<svg class="ficon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3h4.1l1.5 1.5h6.9c.41 0 .75.34.75.75v7c0 .41-.34.75-.75.75H1.75A.75.75 0 0 1 1 12.25v-8.5c0-.41.34-.75.75-.75Z" fill="currentColor"/></svg>`;
const statHtml = (adds, dels) => `<span class="stat"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>`;
function treeHtml(node, depth, out) {
    const review = state.review;
    if (!review)
        return;
    const v = state.view;
    const collapsed = collapsedDirs().has(node.path);
    const files = filesUnder(node.path);
    const n = files.reduce((sum, f) => sum + activeCount(f.path), 0);
    const title = node.path === "" ? `${review.repoRoot} — ${scopeLabel(scopeOf(review))}` : node.path;
    out.push(`<div class="nav-item tree dir${v.type === "folder" && v.path === node.path ? " active" : ""}" data-action="nav" data-view="folder" data-path="${esc(node.path)}" style="--depth:${depth}" title="${esc(title)}" role="treeitem" aria-expanded="${!collapsed}">`
        + `<span class="twisty${collapsed ? "" : " open"}" data-action="fold" data-path="${esc(node.path)}" title="${collapsed ? "Expand" : "Collapse"}">${CHEVRON}</span>`
        + FOLDER_ICON
        + `<span class="name">${esc(node.name)}</span>`
        + `<span class="count${n ? "" : " zero"}">${n}</span>`
        + `</div>`);
    if (collapsed)
        return;
    for (const child of node.children)
        treeHtml(child, depth + 1, out);
    for (const f of node.files) {
        const letter = STATUS_LETTER[f.status] ?? "M";
        const fn = activeCount(f.path);
        out.push(`<div class="nav-item tree${v.type === "file" && v.path === f.path ? " active" : ""}" data-action="nav" data-view="file" data-path="${esc(f.path)}" style="--depth:${depth + 1}" title="${esc(f.path)}${f.untracked ? " (untracked)" : ""}" role="treeitem">`
            + `<span class="twisty spacer-twisty"></span>`
            + `<span class="status-letter ${letter}">${letter}</span>`
            + `<span class="name">${esc(f.path.slice(f.path.lastIndexOf("/") + 1))}</span>`
            + `<span class="count${fn ? "" : " zero"}">${fn}</span>`
            + `${statHtml(f.additions, f.deletions)}</div>`);
    }
}
function setAllDirsCollapsed(collapse) {
    const review = state.review;
    if (!review)
        return;
    const dirs = [];
    const walk = (node) => {
        for (const child of node.children) {
            dirs.push(child.path);
            walk(child);
        }
    };
    if (collapse)
        walk(buildTree(state.snapshot?.files ?? []));
    state.collapsedDirs = new Set(dirs);
    localStorage.setItem(`sr:${review.reviewId}:collapsed`, JSON.stringify(dirs));
}
function descriptionHtml() {
    const review = state.review;
    if (!review)
        return "";
    const d = review.description;
    const stale = d && d.revisionId !== review.currentRevisionId;
    return `<div class="section-head"><h2>Change overview</h2><span class="spacer"></span>`
        + `<button data-action="discuss-description">Discuss / request edits</button></div>`
        + `<div class="card description"><div class="muted">Local PR-style draft; not synced to the published PR.`
        + (d ? ` v${d.version} · based on ${esc(d.revisionId)}${stale ? " · Earlier diff: description has not been updated for the current revision." : ""}` : "")
        + `</div>${d ? md(d.body) : `<div class="empty">No saved description. Descriptions are not generated automatically. Ask Copilot below to describe the purpose, behavior, scope, verification, and risks.</div>`}</div>`;
}
function renderSide() {
    const r = state.review;
    if (!r)
        return;
    const files = state.snapshot?.files ?? [];
    const v = state.view;
    const completion = latestCompletion();
    const overviewCount = r.threads.filter((t) => t.status === "active" && (t.kind === "overview" || !isPlaced(t))).length;
    const html = [
        `<div class="nav-item${v.type === "overview" ? " active" : ""}" data-action="nav" data-view="overview"><span class="name">Overview</span><span class="count${overviewCount ? "" : " zero"}">${overviewCount}</span></div>`,
        ...(state.agentReviewAvailable || agentComments().length ? [`<div class="nav-item${v.type === "agent-comments" ? " active" : ""}" data-action="nav" data-view="agent-comments"><span class="count" title="Agent findings in this scope, across all revisions; excludes replies and manual threads">${agentComments().length}</span><span class="name">Agent reviews</span></div>`] : []),
        `<div class="nav-item${v.type === "lessons" ? " active" : ""}" data-action="nav" data-view="lessons"><span class="name">Lessons learned</span><span class="muted">${r.lessons.length}</span></div>`,
        ...(completion ? [`<div class="nav-item history-nav${v.type === "history" ? " active" : ""}" data-action="nav" data-view="history" title="Review history: the diff and comments pull request #${completion.pullRequest.number} delivered"><span class="name">Delivered in PR #${completion.pullRequest.number}</span><span class="muted" title="Comments moved to history">${state.archived.length}</span></div>`] : []),
        `<div class="section">Files (${files.length})</div>`,
        `<div class="tree-scope">${scopeToggleHtml(scopeOf(r))}</div>`,
    ];
    if (files.length) {
        html.push(`<div class="tree-controls"><button class="link" data-action="fold-tree" data-fold="1">Collapse all</button><button class="link" data-action="fold-tree" data-fold="0">Expand all</button></div>`, `<div role="tree">`);
        treeHtml(buildTree(files), 0, html);
        html.push(`</div>`);
    }
    else if (state.snapshot) {
        const after = scopeOf(r) === "all" && r.git?.delivered?.separation === "separated" ? r.git.delivered.pullRequestNumber : null;
        html.push(`<div class="side-empty">${scopeOf(r) === "pending" ? "No uncommitted changes." : after ? `No changes after PR #${after}.` : "No changes against the base."}</div>`);
    }
    requiredElement("#side").innerHTML = html.join("");
}
function renderMain() {
    const main = $("#main");
    if (!main)
        return;
    captureDestinationFormDrafts(main);
    if (state.view.type === "file") {
        const file = displayFile(state.view.path);
        if (file) {
            main.innerHTML = fileView(file);
            return;
        }
        state.view = { type: "overview" };
    }
    if (state.view.type === "folder") {
        if (filesUnder(state.view.path).length) {
            main.innerHTML = folderView(state.view.path);
            return;
        }
        state.view = { type: "overview" };
    }
    if (state.view.type === "history" && !latestCompletion())
        state.view = { type: "overview" };
    // Background renders rebuild the history DOM; keep delivered files the reviewer expanded or focused.
    const openFiles = new Set(Array.from(main.querySelectorAll("details.history-file[open]"), (d) => d.dataset.historyKey));
    const focused = document.activeElement?.closest("details.history-file");
    const focusedKey = focused && main.contains(focused) ? focused.dataset.historyKey : undefined;
    main.innerHTML = state.view.type === "lessons" ? lessonsView() : state.view.type === "agent-comments" ? agentCommentsView()
        : state.view.type === "history" ? historyView() : overviewView();
    for (const details of Array.from(main.querySelectorAll("details.history-file"))) {
        if (openFiles.has(details.dataset.historyKey))
            details.open = true;
        if (focusedKey && details.dataset.historyKey === focusedKey)
            details.querySelector("summary")?.focus();
    }
}
const pinnedComposers = new Map();
const composerContexts = new Map();
const pinnedComposersKey = (reviewId) => `sr:${reviewId}:pinned-composers`;
function persistPinnedComposers() {
    if (!state.review)
        return;
    const key = pinnedComposersKey(state.review.reviewId);
    if (pinnedComposers.size)
        localStorage.setItem(key, JSON.stringify([...pinnedComposers]));
    else
        localStorage.removeItem(key);
}
function restorePinnedComposers(reviewId) {
    pinnedComposers.clear();
    try {
        const value = JSON.parse(localStorage.getItem(pinnedComposersKey(reviewId)) ?? "[]");
        if (!Array.isArray(value))
            throw new Error("Pinned composers must be an array.");
        for (const entry of value) {
            if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1]))
                continue;
            const [key, options] = entry;
            if ((options.kind !== "file" && options.kind !== "line" && options.kind !== "change")
                || typeof options.path !== "string" || typeof options.revisionId !== "string"
                || (options.side !== undefined && options.side !== "old" && options.side !== "new")
                || (options.startLine !== undefined && typeof options.startLine !== "number")
                || (options.endLine !== undefined && typeof options.endLine !== "number")
                || (options.label !== undefined && typeof options.label !== "string")
                || (options.placeholder !== undefined && typeof options.placeholder !== "string"))
                continue;
            pinnedComposers.set(key, {
                kind: options.kind, path: options.path, revisionId: options.revisionId, alwaysOpen: true,
                side: options.side, startLine: options.startLine, endLine: options.endLine,
                label: options.label, placeholder: options.placeholder,
            });
        }
    }
    catch {
        localStorage.removeItem(pinnedComposersKey(reviewId));
    }
}
function pinComposers() {
    const pin = (key, options) => {
        if (pinnedComposers.has(key))
            return null;
        const draft = getDraft(key);
        const images = getDraftImages(key);
        const upload = imageUploads.get(key);
        const pending = state.pending.get(key);
        state.open.delete(key);
        composerContexts.delete(key);
        if (!draft && !images.length && !upload && !pending)
            return null;
        const pinnedKey = `pinned:${options.revisionId}:${key}`;
        pinnedComposers.set(pinnedKey, { ...options, alwaysOpen: true });
        setDraft(pinnedKey, draft);
        setDraft(key, "");
        setDraftImages(pinnedKey, images);
        setDraftImages(key, []);
        if (upload) {
            upload.key = pinnedKey;
            imageUploads.set(pinnedKey, upload);
            imageUploads.delete(key);
        }
        if (pending) {
            state.pending.set(pinnedKey, pending);
            state.pending.delete(key);
        }
        return pinnedKey;
    };
    for (const box of Array.from(document.querySelectorAll(".composer[data-kind]"))) {
        const d = box.dataset;
        if (!d.key || (d.kind !== "line" && d.kind !== "change" && d.kind !== "file") || pinnedComposers.has(d.key))
            continue;
        const textarea = box.querySelector("textarea");
        if (textarea)
            setDraft(d.key, textarea.value);
        const pinnedKey = pin(d.key, {
            kind: d.kind, path: d.path, side: d.side === "old" ? "old" : "new",
            startLine: d.start ? Number(d.start) : undefined, endLine: d.end ? Number(d.end) : undefined, revisionId: d.revision,
            label: box.querySelector(".label")?.textContent ?? "Comment on original selection", alwaysOpen: true,
        });
        if (pinnedKey) {
            d.key = pinnedKey;
            if (textarea)
                textarea.dataset.composer = pinnedKey;
        }
    }
    for (const [key, options] of composerContexts)
        pin(key, options);
    // Row indices belong to the previous snapshot, never to the refreshed diff.
    state.selection = null;
    persistPinnedComposers();
}
function composerHtml(key, { label, placeholder, kind, path, side, startLine, endLine, alwaysOpen, revisionId, }) {
    const draft = getDraft(key);
    const images = getDraftImages(key);
    const uploading = imageUploads.has(key);
    // The HTML parser strips the first newline immediately after a textarea's opening tag.
    const draftHtml = (draft.startsWith("\n") ? "\n" : "") + esc(draft);
    const p = state.pending.get(key);
    const open = alwaysOpen || state.open.has(key) || Boolean(draft) || Boolean(images.length) || Boolean(p) || uploading;
    if (open && (kind === "line" || kind === "change" || kind === "file") && !pinnedComposers.has(key)) {
        composerContexts.set(key, { label, placeholder, kind, path, side, startLine, endLine, alwaysOpen: true, revisionId: revisionId ?? state.review?.currentRevisionId ?? undefined });
    }
    const data = [
        `data-key="${esc(key)}"`,
        `data-revision="${esc(revisionId ?? state.review?.currentRevisionId ?? "")}"`,
        kind ? `data-kind="${kind}"` : "",
        path ? `data-path="${esc(path)}"` : "",
        side ? `data-side="${side}"` : "",
        startLine ? `data-start="${startLine}"` : "",
        endLine ? `data-end="${endLine}"` : "",
    ].join(" ");
    const k = esc(key);
    const batching = deliveryMode() !== "immediate";
    const disabled = p?.sending || uploading;
    const buttons = batching
        ? `<button data-action="submit" data-key="${k}" data-draft="0" title="Send this comment to Copilot right away"${disabled ? " disabled" : ""}>Send now</button>`
            + `<button class="primary" data-action="submit" data-key="${k}" data-draft="1" title="Hold this comment as a draft until you submit the review"${disabled ? " disabled" : ""}>${p?.sending ? "Saving…" : "Add to review"}</button>`
        : `<button class="primary" data-action="submit" data-key="${k}"${disabled ? " disabled" : ""}>${p?.sending ? "Sending…" : "Comment"}</button>`;
    return `<div class="composer${open ? " open" : ""}" ${data}>`
        + (label ? `<div class="label">${esc(label)}</div>` : "")
        + `<textarea data-composer="${k}" rows="1" placeholder="${esc(placeholder ?? "Write a comment…")}" ${p?.sending ? "disabled" : ""}>${draftHtml}</textarea>`
        + `<div class="review-commands" role="group" aria-label="Review commands" hidden></div>`
        + imagesHtml(images, key, Boolean(p?.sending))
        + (uploading ? `<div class="muted" role="status">Attaching image…</div>` : "")
        + (p?.error ? `<div class="err">${esc(p.error)}</div>` : "")
        + `<div class="bar"><span class="hint">/ for commands · Ctrl+Enter to ${batching ? "add to review" : "send"} · Esc to cancel${/^win/i.test(globalThis.navigator?.platform ?? "") ? " · Win+H for dictation" : ""}</span>`
        + `<button data-action="cancel" data-key="${k}">Cancel</button>`
        + `${buttons}</div>`
        + `</div>`;
}
function deliveryHtml(m) {
    const d = m.delivery;
    if (!d)
        return "";
    const resend = (label) => `<button class="link" data-action="retry" data-message="${esc(m.messageId)}">${label}</button>`;
    switch (d.state) {
        case "draft":
            return `<span class="delivery draft" title="Held until you submit the review">Draft · <button class="link" data-action="send-draft" data-message="${esc(m.messageId)}">Send now</button>`
                + ` · <button class="link" data-action="discard-draft" data-message="${esc(m.messageId)}">Discard</button></span>`;
        case "saving":
            return `<span class="delivery saving">Sending to Copilot…</span>`;
        case "queued": {
            const stale = state.busy === false && d.queuedAt && Date.now() - Date.parse(d.queuedAt) > STALE_QUEUE_MS;
            return `<span class="delivery queued">Queued for Copilot${stale ? ` · ${resend("Resend")}` : ""}</span>`;
        }
        case "processing":
            if (d.parallel)
                return `<span class="delivery processing">${d.parallelPhase === "ready" ? "Waiting to apply" : d.parallelPhase === "applying" ? "Applying change…" : "Analyzing comment…"}</span>`;
            return `<span class="delivery processing">Copilot is working…</span>`;
        case "replied":
            return `<span class="delivery replied">✓ Replied</span>`;
        case "no-reply":
            return `<span class="delivery no-reply" title="${esc(d.error ?? "Copilot finished without replying in this thread")}">${d.error ? "Processing failed" : "No reply"} · ${resend("Resend")}</span>`;
        case "failed":
            return `<span class="delivery failed" title="${esc(d.error ?? "")}">Delivery failed · ${resend("Retry")}</span>`;
        default:
            return "";
    }
}
function mappingForPath(reviewedPath) {
    const caseSensitive = state.settings?.pathCaseSensitive ?? true;
    const normalize = (value) => {
        const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
        return caseSensitive ? normalized : normalized.toLowerCase();
    };
    const file = normalize(reviewedPath);
    return [...(state.settings?.instructionMappings ?? [])]
        .filter((mapping) => {
        const prefix = normalize(mapping.pathPrefix);
        return !prefix || file === prefix || file.startsWith(`${prefix}/`);
    })
        .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
}
function reviewedPathForLesson(lesson) {
    if (lesson.reviewedPath !== undefined)
        return lesson.reviewedPath;
    const thread = findAnyThread(lesson.threadId);
    if (thread?.kind === "overview")
        return "";
    return thread?.location?.path ?? thread?.anchor?.path;
}
function suggestedDestination(lesson, reviewedPath = lesson.reviewedPath) {
    if (lesson.destination)
        return lesson.destination;
    const extension = reviewedPath?.replace(/\\/g, "/").split(".").at(-1)?.toLowerCase() ?? "";
    const names = {
        cs: "csharp", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
        ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", py: "python", ps1: "powershell", go: "go",
        rs: "rust", java: "java", rb: "ruby", php: "php", sh: "shell", sql: "sql",
    };
    const language = names[extension];
    return language
        ? { kind: "language", language, applyTo: `**/*.${extension}` }
        : { kind: "general" };
}
function lessonDestinationSignature(lesson, reviewedPath) {
    return JSON.stringify([lesson.rule, lesson.scope, reviewedPath ?? null]);
}
function destinationFormDraftKey(lessonId, messageId) {
    return JSON.stringify([lessonId, messageId]);
}
function captureDestinationFormDrafts(main) {
    for (const form of Array.from(main.querySelectorAll("[data-lesson-form]"))) {
        const lessonId = form.dataset.lessonForm;
        const messageId = form.dataset.lessonMessage;
        const signature = form.dataset.lessonSignature;
        const input = (name) => form.querySelector(`[name="${name}"]`);
        const pathPrefix = input("pathPrefix");
        const instructionRoot = input("instructionRoot");
        const splitLanguageSpecific = input("splitLanguageSpecific");
        const destinationKind = input("destinationKind");
        const language = input("language");
        const applyTo = input("applyTo");
        const details = form.querySelector("details.lesson-destination");
        if (!lessonId || !messageId || !signature || !pathPrefix || !instructionRoot || !splitLanguageSpecific
            || !destinationKind || !language || !applyTo || !details)
            continue;
        destinationFormDrafts.set(destinationFormDraftKey(lessonId, messageId), {
            signature,
            edited: form.dataset.destinationEdited === "true",
            pathPrefix: pathPrefix.value,
            instructionRoot: instructionRoot.value,
            splitLanguageSpecific: splitLanguageSpecific instanceof HTMLInputElement && splitLanguageSpecific.checked,
            destinationKind: destinationKind.value === "language" ? "language" : "general",
            language: language.value,
            applyTo: applyTo.value,
            detailsOpen: details.open,
            expectedMappings: form.dataset.expectedMappings ?? currentMappingsSnapshot(),
        });
    }
}
function currentMappingsSnapshot() {
    return JSON.stringify(state.settings?.instructionMappings ?? []);
}
// A failed save may follow a concurrent mapping change, so reload the stored mappings for the card and its next save.
// An edited card keeps the mappings it was edited against; if they changed since, show the stored destination again.
async function refreshDestinationAfterFailedSave(form) {
    const lessonId = form.dataset.lessonForm;
    const messageId = form.dataset.lessonMessage;
    if (!lessonId || !messageId)
        return;
    await loadState();
    if (form.dataset.destinationEdited !== "true")
        return;
    const key = destinationFormDraftKey(lessonId, messageId);
    const draft = destinationFormDrafts.get(key);
    if (draft && draft.expectedMappings === currentMappingsSnapshot())
        return;
    destinationFormDrafts.delete(key);
    for (const current of Array.from(document.querySelectorAll("#main [data-lesson-form]"))) {
        if (current.dataset.lessonForm === lessonId && current.dataset.lessonMessage === messageId)
            delete current.dataset.destinationEdited;
    }
    render();
}
function destinationFormProposal(form) {
    const input = (name) => form.querySelector(`[name="${name}"]`);
    const root = input("instructionRoot")?.value.replace(/\/+$/, "") ?? "";
    const kind = input("destinationKind")?.value === "language" ? "language" : "general";
    const splitInput = input("splitLanguageSpecific");
    const language = input("language")?.value.trim() ?? "";
    const applyTo = input("applyTo")?.value.trim() ?? "";
    return {
        mapping: {
            pathPrefix: input("pathPrefix")?.value ?? "",
            instructionRoot: root,
            splitLanguageSpecific: splitInput instanceof HTMLInputElement ? splitInput.checked : true,
        },
        destination: kind === "language" ? { kind, language, applyTo } : { kind: "general" },
    };
}
async function updateDestinationPreview(form) {
    const lessonId = form.dataset.lessonForm;
    const preview = form.querySelector("[data-destination-preview]");
    if (!lessonId || !preview)
        return null;
    const proposal = destinationFormProposal(form);
    const key = JSON.stringify(proposal);
    const existing = destinationPreviewRequests.get(form);
    if (existing?.key === key)
        return existing.promise;
    const requestId = Symbol();
    form.dataset.destinationPreviewKey = key;
    form.dataset.destinationPreviewState = "loading";
    preview.textContent = "Resolving actual destination…";
    const isCurrentRequest = () => form.dataset.destinationPreviewKey === key
        && destinationPreviewRequests.get(form)?.requestId === requestId;
    const promise = (async () => {
        try {
            const result = await api("POST", `lessons/${encodeURIComponent(lessonId)}/destination`, proposal);
            if (!isRecord(result) || typeof result.savedTo !== "string" || typeof result.needsConfirmation !== "boolean") {
                throw new Error("The provider returned an invalid destination preview.");
            }
            if (isCurrentRequest()) {
                form.dataset.destinationPreviewState = "ready";
                form.dataset.resolvedDestination = result.savedTo;
                preview.textContent = `${result.savedTo}${result.needsConfirmation ? " (new file; confirmation required)" : ""}`;
            }
            return { savedTo: result.savedTo, needsConfirmation: result.needsConfirmation };
        }
        catch (error) {
            if (isCurrentRequest()) {
                form.dataset.destinationPreviewState = "error";
                preview.textContent = `Unable to resolve destination: ${errorMessage(error)}`;
            }
            if (destinationPreviewRequests.get(form)?.requestId === requestId)
                destinationPreviewRequests.delete(form);
            return null;
        }
    })();
    destinationPreviewRequests.set(form, { key, requestId, promise });
    return promise;
}
function refreshDestinationPreviews() {
    for (const form of Array.from(document.querySelectorAll("#main [data-lesson-form]"))) {
        if (form.dataset.destinationPreviewState !== "ready")
            void updateDestinationPreview(form);
    }
}
function lessonDestinationForm(lesson, messageId) {
    const reviewedPath = reviewedPathForLesson(lesson);
    const mapping = reviewedPath !== undefined ? mappingForPath(reviewedPath) : undefined;
    const parent = reviewedPath?.replace(/\\/g, "/").split("/").slice(0, -1).join("/") ?? "";
    const suggestion = suggestedDestination(lesson, reviewedPath);
    const signature = lessonDestinationSignature(lesson, reviewedPath);
    const draftKey = destinationFormDraftKey(lesson.lessonId, messageId);
    const previousDraft = destinationFormDrafts.get(draftKey);
    const draft = previousDraft?.signature === signature ? previousDraft : undefined;
    if (previousDraft && !draft)
        destinationFormDrafts.delete(draftKey);
    const editedDraft = draft?.edited ? draft : undefined;
    const destination = editedDraft
        ? { kind: editedDraft.destinationKind, language: editedDraft.language, applyTo: editedDraft.applyTo }
        : suggestion;
    const prefix = editedDraft?.pathPrefix ?? mapping?.pathPrefix ?? destination.pathPrefix ?? parent;
    const root = editedDraft?.instructionRoot ?? mapping?.instructionRoot ?? destination.instructionRoot ?? parent;
    const splitLanguageSpecific = editedDraft?.splitLanguageSpecific ?? mapping?.splitLanguageSpecific ?? true;
    return `<details class="lesson-destination"${draft?.detailsOpen ? " open" : ""}><summary>Confirm repository destination</summary>`
        + `<p class="muted">Reviewed file: <code>${esc(reviewedPath ?? "path unavailable")}</code>. This per-user mapping is shared by clones and worktrees of the same repository.</p>`
        + `<label>Path prefix <input name="pathPrefix" value="${esc(prefix)}" placeholder="(repository root)"></label>`
        + `<label>Instruction root <input name="instructionRoot" value="${esc(root)}" placeholder="(repository root)"></label>`
        + `<label><input type="checkbox" name="splitLanguageSpecific"${splitLanguageSpecific ? " checked" : ""}> Split language-specific rules into scoped files</label>`
        + `<label>Rule type <select name="destinationKind"><option value="language"${destination.kind === "language" ? " selected" : ""}>Language-specific</option><option value="general"${destination.kind === "general" ? " selected" : ""}>Repository-wide</option></select></label>`
        + `<label>Language <input name="language" value="${esc(destination.language ?? "")}" placeholder="csharp"></label>`
        + `<label>applyTo <input name="applyTo" value="${esc(destination.applyTo ?? "")}" placeholder="**/*.cs"></label>`
        + `<p class="muted">Actual destination: <code data-destination-preview>Resolving actual destination…</code></p>`
        + `<button data-action="save-lesson" data-lesson="${esc(lesson.lessonId)}">Confirm destination and save guideline</button>`
        + `</details>`;
}
function saveLessonButton(l, messageId) {
    if (l.status !== "proposed" || (l.scope !== "repo" && l.scope !== "personal"))
        return "";
    if (l.scope === "repo") {
        const reviewedPath = reviewedPathForLesson(l);
        const signature = lessonDestinationSignature(l, reviewedPath);
        const draftKey = destinationFormDraftKey(l.lessonId, messageId);
        const draft = destinationFormDrafts.get(draftKey);
        const edited = draft?.signature === signature && draft.edited;
        const expectedMappings = edited ? draft.expectedMappings : currentMappingsSnapshot();
        return ` <span data-lesson-form="${esc(l.lessonId)}" data-lesson-message="${esc(messageId)}" data-lesson-signature="${esc(signature)}"${edited ? ' data-destination-edited="true"' : ""} data-expected-mappings="${esc(expectedMappings)}" data-rule="${esc(l.rule)}" data-scope="${esc(l.scope)}">`
            + `${lessonDestinationForm(l, messageId)}${l.saveError ? ` <span role="status">${esc(l.saveError)}</span>` : ""}</span>`;
    }
    return ` <button data-action="save-lesson" data-lesson="${esc(l.lessonId)}" data-proposal="${esc(JSON.stringify({ rule: l.rule, scope: l.scope }))}">Save guideline</button>`
        + (l.saveError ? ` <span role="status">${esc(l.saveError)}</span>` : "");
}
function messageHtml(m) {
    const agent = m.author === "agent";
    const lessons = (m.lessonIds ?? []).map((id) => state.review?.lessons.find((l) => l.lessonId === id)).filter((lesson) => Boolean(lesson));
    const savedLesson = !agent && state.review?.lessons.some((l) => l.sourceMessageId === m.messageId && l.status === "saved" && l.savedTo);
    return `<div class="msg" data-message-id="${esc(m.messageId)}">`
        + `<div class="msg-head"><span class="avatar${agent ? " agent" : ""}">${agent ? "AI" : "Me"}</span>`
        + `<span class="who">${agent ? "Copilot" : "You"}</span><span class="when" title="${esc(m.createdAt)}">${esc(ago(m.createdAt))}</span>`
        + (agent && m.outcome ? `<span class="outcome ${esc(m.outcome)}">${esc(m.outcome)}</span>` : "")
        + deliveryHtml(m)
        + (savedLesson ? `<span class="badge lesson-saved">Lesson learned</span>` : "")
        + `</div>${md(m.body)}${imagesHtml(m.imageIds ?? [])}`
        + (m.verification ? `<div class="verification">Verification: ${inline(m.verification)}</div>` : "")
        + (lessons.length ? `<div class="lessons">Guidelines:<ul>${lessons.map((l) => `<li><span class="badge">${esc(l.scope)}</span> ${lessonBadge(l)} ${inline(l.rule)}${l.savedTo ? ` <span class="muted mono">→ ${esc(l.savedTo)}</span>` : ""}${saveLessonButton(l, m.messageId)}</li>`).join("")}</ul></div>` : "")
        + `</div>`;
}
function findingApprovalIssue(finding) {
    if (finding.assessment !== "confirmed")
        return "Only confirmed findings can be approved; discuss the assessment or run a fresh review.";
    if (!Object.hasOwn(FINDING_SEVERITIES, finding.severity) || finding.severity === "fyi")
        return "This finding is not an actionable suggestion; use Discuss.";
    const fields = ["source", "baseline", "validation"];
    if (fields.some((key) => typeof finding.evidence?.[key] !== "string" || !finding.evidence[key]?.trim())) {
        return "Evidence is missing; run a fresh review or use Discuss.";
    }
    if (finding.contributions?.some((item) => item.assessment !== undefined && item.assessment !== "confirmed")) {
        return "A reviewer did not confirm this finding; discuss the assessment.";
    }
    if (finding.contributions?.some((item) => item.severity !== undefined
        && (!Object.hasOwn(FINDING_SEVERITIES, item.severity) || item.severity === "fyi"))) {
        return "A reviewer marked this finding FYI or non-actionable; use Discuss.";
    }
    if (finding.contributions?.some((item) => fields.some((key) => typeof item.evidence?.[key] !== "string" || !item.evidence[key]?.trim()))) {
        return "Reviewer evidence is missing; run a fresh review or use Discuss.";
    }
    return "";
}
function findingEvidenceHtml(finding) {
    if (!finding)
        return "";
    return `<details class="finding-evidence"><summary>Evidence and verification</summary><dl>`
        + [["source", "Source / requirement"], ["baseline", "Baseline comparison"], ["validation", "Validation / limits"]].map(([key, label]) => `<dt>${label}</dt><dd>${typeof finding.evidence?.[key] === "string" ? md(finding.evidence[key]) : "Not recorded"}</dd>`).join("")
        + `</dl>`
        + (finding.contributions?.map((item) => `<section><strong>${esc(item.model)}</strong>`
            + (item.severity || item.assessment ? `<p>${esc(item.assessment ?? "Not recorded")} / ${esc(item.severity ?? "Not recorded")}</p>` : "")
            + (item.anchor ? `<p>${esc(item.anchor.path)}${item.anchor.startLine != null ? ` · ${esc(item.anchor.side ?? "new")} ${esc(lineLabel(item.anchor))}` : ""}</p>` : "")
            + `${md(item.body)}<dl>`
            + [["source", "Source / requirement"], ["baseline", "Baseline comparison"], ["validation", "Validation / limits"]].map(([key, label]) => `<dt>${label}</dt><dd>${typeof item.evidence[key] === "string" ? md(item.evidence[key]) : "Not recorded"}</dd>`).join("")
            + `</dl></section>`).join("") ?? "")
        + (finding.votes?.length ? `<h4>Reviewer discussion and votes</h4>${finding.votes.map((vote) => `<p><strong>${esc(vote.model)}: ${esc(vote.decision)}</strong><br>${esc(vote.discussion)}<br>${esc(vote.rationale)}</p>`).join("")}` : "")
        + `</details>`;
}
const replyKey = (threadId) => `reply:${threadId}`;
const hasDraftReply = (threadId) => Boolean(getDraft(replyKey(threadId)) || getDraftImages(replyKey(threadId)).length);
const threadDefaultsCollapsed = (t) => (t.status !== "active" || t.location?.state === "outdated") && !hasDraftReply(t.threadId);
const threadCollapsed = (t) => state.collapsedThreads.has(t.threadId) || (threadDefaultsCollapsed(t) && !state.expanded.has(t.threadId));
function outsideDraftRepliesHtml() {
    const drafts = state.review?.threads.filter((t) => hasDraftReply(t.threadId));
    if (!drafts?.length)
        return "";
    const visible = new Set(Array.from(document.querySelectorAll("#main [data-thread-id]"), (el) => el.dataset.threadId));
    const links = drafts.filter((t) => !visible.has(t.threadId)).map((t) => `<div><button class="link" data-action="jump" data-thread="${esc(t.threadId)}">Resume reply</button> · ${esc(locLabel(t))}</div>`);
    return links.length ? `<div class="card"><strong>Unposted replies outside this view</strong>${links.join("")}</div>` : "";
}
function threadHtml(t, { showLocation = false } = {}) {
    const loc = t.location ?? {};
    const outdated = loc.state === "outdated";
    const collapsed = threadCollapsed(t);
    const pending = t.messages.filter((m) => m.delivery && m.delivery.state !== "replied");
    const notInDiff = !outdated && !isPlaced(t);
    const anchor = t.anchor;
    const moved = anchor?.startLine != null && loc.startLine != null && (anchor.startLine !== loc.startLine || anchor.endLine !== loc.endLine);
    const options = STATUSES.map((s) => `<option value="${s}"${s === t.status ? " selected" : ""}>${s === "wontfix" ? "won't fix" : s}</option>`).join("");
    const head = `<div class="thread-head">`
        + `<span class="badge kind">${t.kind === "change" ? "change" : t.kind}</span>`
        + (t.agentReview ? `<span class="badge" title="Reported reviewer models">${esc(t.agentReview.contributions?.map((item) => item.model).join(", ") || t.agentReview.model)} / ${esc(t.agentReview.category)}</span>` : "")
        + (t.agentReview ? `<span class="badge" title="Assessment reported by the coordinating agent">${esc(FINDING_ASSESSMENTS[t.agentReview.assessment] ?? "Unverified")}</span><span class="badge">${esc(FINDING_SEVERITIES[t.agentReview.severity] ?? "Severity not reported")}</span>` : "")
        + `<span class="loc">${showLocation ? `<button class="link" data-action="jump" data-thread="${esc(t.threadId)}">${esc(locLabel(t))}</button>` : esc(locLabel(t))}`
        + (moved && anchor ? ` <span class="muted" title="Line numbers changed since ${esc(anchor.revisionId)}">(originally ${esc(lineLabel(anchor))} in ${esc(anchor.revisionId)})</span>` : "")
        + `</span>`
        + (outdated ? `<span class="badge outdated" title="The commented code changed or was removed">Outdated</span>` : "")
        + (notInDiff ? `<span class="badge outdated" title="This location is not part of the current diff">Not in diff</span>` : "")
        + (t.status !== "active" ? `<span class="badge st-${t.status}">${t.status === "wontfix" ? "won't fix" : t.status}</span>` : "")
        + `<select data-action="status" data-thread="${esc(t.threadId)}" title="Thread status">${options}</select>`
        + (collapsed ? pending.map(deliveryHtml).join("") : "")
        + (collapsed && hasDraftReply(t.threadId) ? `<span class="badge">Unposted reply</span>` : "")
        + `<button class="link" data-action="toggle" data-thread="${esc(t.threadId)}" aria-expanded="${!collapsed}">${collapsed ? "Show" : "Hide"}</button>`
        + `</div>`;
    const original = outdated && t.anchor?.selectedLines?.length
        ? `<div class="original muted">Originally commented code (${esc(t.anchor.revisionId)}, ${esc(lineLabel(t.anchor))}):<pre>${esc(t.anchor.selectedLines.join("\n"))}</pre></div>`
        : "";
    const reply = composerHtml(replyKey(t.threadId), { placeholder: "Reply…" });
    const staleFinding = t.agentReview && t.agentReview.revisionId !== state.review?.currentRevisionId;
    const approvalIssue = t.agentReview ? findingApprovalIssue(t.agentReview) : "";
    const actions = t.agentReview
        ? `<div class="finding-actions"><button class="primary" data-action="approve-finding" data-thread="${esc(t.threadId)}" title="${esc(staleFinding ? "Review changed; rerun before approving" : approvalIssue || "Send this suggestion to the coding agent for implementation")}"${t.agentReview.approvalMessageId || staleFinding || approvalIssue || t.status !== "active" || state.approving.has(t.threadId) ? " disabled" : ""}>${t.agentReview.approvalMessageId ? "Approved" : "Approve"}</button>`
            + `<button data-action="discuss-finding" data-thread="${esc(t.threadId)}">Discuss</button></div>`
        : "";
    return `<div class="thread${collapsed ? " collapsed" : ""}" data-thread-id="${esc(t.threadId)}">${head}<div class="thread-body">${original}${t.messages.map((m, i) => messageHtml(m) + (i === 0 ? findingEvidenceHtml(t.agentReview) : "")).join("")}${actions}${reply}</div></div>`;
}
// Explains an empty diff and, for pending changes, offers the way back to the full branch diff.
function emptyDiffHtml() {
    const files = state.snapshot?.files;
    if (!files || files.length)
        return "";
    if (scopeOf(state.review) === "pending") {
        return `<div class="card empty-diff"><strong>No uncommitted changes.</strong> The working tree matches HEAD, so there is nothing to review in this scope.`
            + ` <button data-action="scope" data-scope="all">Switch to All changes</button></div>`;
    }
    const delivered = state.review?.git?.delivered;
    if (delivered?.separation === "separated") {
        return `<div class="card empty-diff"><strong>No changes after PR #${delivered.pullRequestNumber}.</strong> Everything on this branch was delivered by the merged pull request.`
            + ` <button data-action="nav" data-view="history">Open review history</button></div>`;
    }
    return `<div class="card empty-diff"><strong>No changes to review.</strong> Nothing differs from ${esc(state.review?.base)}.</div>`;
}
const DISPOSITIONS = { active: "Unresolved", resolved: "Resolved", wontfix: "Won't fix", closed: "Closed" };
function historyMessageHtml(m) {
    const agent = m.author === "agent";
    return `<div class="msg" data-message-id="${esc(m.messageId)}">`
        + `<div class="msg-head"><span class="avatar${agent ? " agent" : ""}">${agent ? "AI" : "Me"}</span>`
        + `<span class="who">${agent ? "Copilot" : "You"}</span><span class="when" title="${esc(m.createdAt)}">${esc(ago(m.createdAt))}</span>`
        + (agent && m.outcome ? `<span class="outcome ${esc(m.outcome)}">${esc(m.outcome)}</span>` : "")
        + (m.delivery?.state === "draft" ? `<span class="badge" title="This draft was held and never sent to Copilot">Draft, never sent</span>` : "")
        + `</div>${md(m.body)}${imagesHtml(m.imageIds ?? [])}`
        + (m.verification ? `<div class="verification">Verification: ${inline(m.verification)}</div>` : "")
        + `</div>`;
}
// Read-only: history keeps each thread exactly as it was, so there is no status control or reply box.
function archivedThreadHtml(t) {
    const followUps = state.review?.threads.filter((f) => f.followUpOf === t.threadId).length ?? 0;
    return `<div class="thread archived" data-thread-id="${esc(t.threadId)}"><div class="thread-head">`
        + `<input type="checkbox" data-action="history-select" data-thread="${esc(t.threadId)}" aria-label="${esc(`Select ${locLabel(t)} for follow-up`)}"${state.historySelection.has(t.threadId) ? " checked" : ""}>`
        + `<span class="badge kind">${esc(t.kind)}</span>`
        + (t.agentReview ? `<span class="badge">${esc(t.agentReview.category)}</span>` : "")
        + `<span class="loc">${esc(locLabel(t))}</span>`
        + `<span class="badge st-${esc(t.status)}" title="Status when the pull request merged. Moving to history does not change it.">${DISPOSITIONS[t.status]}</span>`
        + (followUps ? `<span class="badge" title="Carried into the current work with Start follow-up">Followed up</span>` : "")
        + `</div><div class="thread-body">${t.messages.map(historyMessageHtml).join("")}</div></div>`;
}
function historyDiff(revisionId) {
    const known = state.historyDiffs.get(revisionId);
    if (known)
        return known;
    const loading = { status: "loading" };
    state.historyDiffs.set(revisionId, loading);
    const reviewId = state.review?.reviewId;
    void api("GET", `snapshot/${encodeURIComponent(revisionId)}`).then((value) => ({ status: "ready", snapshot: parseSnapshot(value) }), (error) => ({ status: "failed", error: errorMessage(error) })).then((entry) => {
        if (state.review?.reviewId !== reviewId)
            return;
        state.historyDiffs.set(revisionId, entry);
        if (state.view.type === "history")
            render();
    });
    return loading;
}
function historyFileHtml(revisionId, file) {
    const prefix = { add: "+", del: "-", ctx: " " };
    const body = file.binary || !file.hunks.length
        ? `<div class="muted history-note">${esc(file.note ?? (file.binary ? "Binary file" : "No textual changes"))}</div>`
        : file.hunks.map((hunk) => (hunk.gap ? "" : `<div class="hunk-head"><span class="h">${esc(hunk.header ?? "")}</span></div>`)
            + `<table class="rows"><colgroup><col style="width:52px"><col style="width:52px"><col></colgroup><tbody>`
            + hunk.rows.map((row) => `<tr class="row ${row.t}"><td class="ln">${row.o ?? ""}</td><td class="ln">${row.n ?? ""}</td>`
                + `<td class="code" data-p="${prefix[row.t]}">${esc(row.s)}</td></tr>`).join("")
            + `</tbody></table>`).join("");
    const name = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
    return `<details class="history-file" data-history-key="${esc(`${revisionId}\n${file.path}`)}"><summary><span class="badge">${STATUS_LETTER[file.status] ?? "M"}</span><span class="mono">${esc(name)}</span>`
        + `<span class="add">+${file.additions}</span><span class="del">−${file.deletions}</span></summary><div class="diff">${body}</div></details>`;
}
function historySectionHtml(completion) {
    const pr = completion.pullRequest;
    const ids = new Set(completion.archivedThreadIds);
    const threads = state.archived.filter((t) => ids.has(t.threadId));
    const unresolved = threads.filter((t) => t.status === "active").length;
    const merged = pr.mergedAt ? new Date(pr.mergedAt).toLocaleString() : "";
    const diff = completion.deliveredRevisionId ? historyDiff(completion.deliveredRevisionId) : null;
    const diffHtml = !diff ? `<p class="muted">No diff was captured before this pull request merged.</p>`
        : diff.status === "loading" ? `<p class="muted">Loading the delivered diff...</p>`
            : diff.status === "failed" ? `<p class="del">Could not load the delivered diff: ${esc(diff.error)}</p>`
                : diff.snapshot.files.length ? diff.snapshot.files.map((file) => historyFileHtml(completion.deliveredRevisionId, file)).join("")
                    : `<p class="muted">The last revision before the merge had no changes.</p>`;
    return `<section class="history-section" aria-label="Delivered in pull request ${pr.number}">`
        + `<div class="card history-summary"><strong>Completed · <a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">PR #${pr.number}</a> merged${pr.baseRefName ? ` into ${esc(pr.baseRefName)}` : ""}</strong>`
        + (merged ? ` <span class="muted" title="${esc(pr.mergedAt)}">${esc(merged)}</span>` : "")
        + `<p class="muted">This is review history. The comments below keep the status they had when the pull request merged; moving them here does not mean a finding was fixed.`
        + `${unresolved ? ` ${unresolved} ${unresolved === 1 ? "was" : "were"} still unresolved.` : ""} Select comments and use Start follow-up to continue them as new draft comments in the current work.</p></div>`
        + `<h3>Comments (${threads.length})</h3>`
        + (threads.length ? threads.map(archivedThreadHtml).join("") : `<p class="muted">No comments existed when this pull request merged.</p>`)
        + `<h3 title="${esc(completion.deliveredRevisionId ? `Revision ${completion.deliveredRevisionId}` : "")}">Delivered diff</h3>`
        + `<p class="muted">The last revision this review captured before the merge${completion.deliveredRevisionId ? ` (${esc(completion.deliveredRevisionId)})` : ""}. Read-only.</p>`
        + diffHtml
        + `</section>`;
}
function followUpButtonHtml() {
    const selected = state.historySelection.size;
    return `<button class="primary" data-action="start-follow-up" title="Create draft comments in the current work that quote the selected comments. Nothing is sent until you send or submit them."${selected && !state.followingUp ? "" : " disabled"}>`
        + `${state.followingUp ? "Starting follow-up..." : `Start follow-up${selected ? ` (${selected})` : ""}`}</button>`;
}
function renderFollowUpButton() {
    const button = document.querySelector(`[data-action="start-follow-up"]`);
    if (button)
        button.outerHTML = followUpButtonHtml();
}
async function startFollowUp() {
    const threadIds = [...state.historySelection];
    if (!threadIds.length || state.followingUp)
        return;
    state.followingUp = true;
    renderFollowUpButton();
    try {
        const res = await api("POST", "follow-up", { threadIds });
        const created = isRecord(res) && isStringArray(res.threadIds) ? res.threadIds.length : 0;
        state.historySelection.clear();
        toast(`Started ${created} follow-up ${created === 1 ? "draft" : "drafts"}. Send ${created === 1 ? "it" : "them"} when ready.`);
    }
    catch (error) {
        toast(errorMessage(error), true);
    }
    finally {
        state.followingUp = false;
        await loadState().catch(() => undefined);
    }
}
function historyView() {
    const completions = [...(state.review?.completions ?? [])].reverse();
    return `<div class="history-view"><div class="history-actions">`
        + `<h2>Review history</h2><span class="spacer"></span>${followUpButtonHtml()}</div>`
        + completions.map(historySectionHtml).join("")
        + `</div>`;
}
function overviewView() {
    const r = state.review;
    if (!r)
        return "";
    const overall = r.threads.filter((t) => t.kind === "overview" && t.status === "active");
    const unplaced = r.threads.filter((t) => t.kind !== "overview" && t.status === "active" && !isPlaced(t));
    const others = r.threads.filter((t) => t.kind !== "overview");
    const active = others.filter((t) => t.status === "active");
    const done = r.threads.filter((t) => t.status !== "active");
    const listRow = (t) => {
        const last = t.messages[t.messages.length - 1];
        const lastUser = [...t.messages].reverse().find((m) => m.author === "user");
        return `<div class="list-row"><span class="badge kind">${t.kind}</span>`
            + `<button class="link loc" data-action="jump" data-thread="${esc(t.threadId)}">${esc(locLabel(t))}</button>`
            + `<span class="snippet">${esc(last.author === "agent" ? "Copilot: " : "")}${esc(last.body.replace(/\s+/g, " ").slice(0, 160))}</span>`
            + (lastUser ? deliveryHtml(lastUser) : "")
            + `</div>`;
    };
    return emptyDiffHtml()
        + descriptionHtml()
        + `<h2>Overall discussion</h2>`
        + (overall.length ? overall.map((t) => threadHtml(t)).join("") : `<div class="empty">No overall comments yet.</div>`)
        + `<div class="thread">${composerHtml("overview:new", { kind: "overview", label: "Discuss the change or request description edits", placeholder: "Ask to revise the description, discuss the design, or request a change…", alwaysOpen: true })}</div>`
        + (unplaced.length ? `<h2>Comments outside the current diff (${unplaced.length})</h2>${unplaced.map((t) => threadHtml(t, { showLocation: true })).join("")}` : "")
        + `<h2>Active threads (${active.length})</h2><div class="card">${active.length ? active.map(listRow).join("") : `<div class="empty">No active threads. Select lines in a file to comment.</div>`}</div>`
        + (done.length ? `<h2>Closed threads (${done.length})</h2>${done.map((t) => threadHtml(t, { showLocation: true })).join("")}` : "");
}
function lessonsEmptyHint() {
    return autoSaveLearnedRules()
        ? "Copilot saves reusable guidelines here when your feedback reveals a settled preference."
        : "Copilot proposes reusable guidelines when your feedback reveals a settled preference. Use Save guideline in the thread to save one.";
}
function lessonsView() {
    const lessons = state.review?.lessons ?? [];
    if (!lessons.length)
        return `<h2>Lessons learned</h2><div class="empty">${lessonsEmptyHint()}</div>`;
    const rows = [...lessons].reverse().map((l) => `<tr><td><span class="badge">${esc(l.scope)}</span></td><td>${lessonBadge(l)}</td><td>${inline(l.rule)}</td><td class="mono muted">${esc(l.savedTo ?? "")}</td><td><button class="link" data-action="jump" data-thread="${esc(l.threadId)}">thread</button><div class="muted">${esc(ago(l.createdAt))}</div></td></tr>`).join("");
    return `<h2>Lessons learned (${lessons.length})</h2><table class="lessons-table"><thead><tr><th>Scope</th><th>Status</th><th>Rule</th><th>Saved to</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
const IMAGE_SIDES = ["old", "new"];
const IMAGE_SIDE_LABELS = { old: "Before", new: "After" };
const IMAGE_MODES = ["2-up", "swipe", "onion"];
const IMAGE_MODE_LABELS = { "2-up": "2-up", swipe: "Swipe", onion: "Onion skin" };
const DEFAULT_IMAGE_VIEW = { mode: "2-up", split: 50, opacity: 50 };
const IMAGE_UNAVAILABLE = "Preview unavailable: the image may have changed since this revision, be unsupported, or exceed 2 MB. Refresh to compare the latest version.";
// Start fetching an image this far before its block scrolls into view.
const IMAGE_PREFETCH_MARGIN = "600px";
let imageObserver = null;
const imageView = (path) => state.imageViews.get(path) ?? DEFAULT_IMAGE_VIEW;
// Cached per path and side rather than per object ID alone: paths with identical bytes can be read from different
// working-tree files, so one path's failed request must not hide another's readable preview.
const imageKey = (path, side, oid) => `${side}:${oid}:${path}`;
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const [amount, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KB"] : [bytes / (1024 * 1024), "MB"];
    return `${amount < 10 ? amount.toFixed(1) : Math.round(amount)} ${unit}`;
}
function imageMeta(entry) {
    const size = formatBytes(entry.size);
    return entry.width && entry.height ? `${entry.width} × ${entry.height} px · ${size}` : size;
}
function revokeImageUrl(entry) {
    if (entry?.status === "ready" && entry.url.startsWith("blob:"))
        URL.revokeObjectURL(entry.url);
}
function pruneImages(snapshot) {
    const referenced = new Set(snapshot?.files.flatMap((file) => IMAGE_SIDES.flatMap((side) => {
        const oid = file.imageSides?.[side];
        return oid ? [imageKey(file.path, side, oid)] : [];
    })));
    for (const [key, entry] of state.images) {
        // A failed image is retried after Refresh, which may have made its bytes readable again.
        if (referenced.has(key) && entry.status !== "failed")
            continue;
        revokeImageUrl(entry);
        state.images.delete(key);
    }
}
function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unreadable image."));
        reader.onerror = () => reject(reader.error ?? new Error("Unreadable image."));
        reader.readAsDataURL(blob);
    });
}
async function loadImage(path, side, oid) {
    const revisionId = state.snapshot?.revisionId;
    const reviewId = state.review?.reviewId;
    const key = imageKey(path, side, oid);
    if (!revisionId || !reviewId || state.images.has(key))
        return;
    const loading = { status: "loading" };
    state.images.set(key, loading);
    let loaded = { status: "failed" };
    try {
        const query = new URLSearchParams({ review: reviewId, path, side });
        const response = await fetch(`/api/diff-image/${encodeURIComponent(revisionId)}?${query}`, { headers: { "X-MR-Token": TOKEN } });
        if (!response.ok)
            throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        // A same-origin blob: SVG opened in its own tab would run scripts as this page; a data: URL has an opaque origin.
        const url = blob.type === "image/svg+xml" ? await readDataUrl(blob) : URL.createObjectURL(blob);
        loaded = { status: "ready", url, width: 0, height: 0, size: blob.size };
        const image = new Image();
        image.src = url;
        await image.decode();
        loaded = { ...loaded, width: image.naturalWidth, height: image.naturalHeight };
    }
    catch {
        revokeImageUrl(loaded);
        loaded = { status: "failed" };
    }
    // The review, revision or path moved on while this image loaded.
    if (state.images.get(key) !== loading) {
        revokeImageUrl(loaded);
        return;
    }
    state.images.set(key, loaded);
    repaintImageDiffs((file) => file.path === path);
}
function requestImages(block) {
    const path = block instanceof HTMLElement ? block.dataset.imagePath ?? "" : "";
    const file = fileOf(path);
    for (const side of IMAGE_SIDES) {
        const oid = file?.imageSides?.[side];
        if (oid)
            void loadImage(path, side, oid);
    }
}
// Rendered markup carries only object IDs; decoded URLs are attached afterwards, and missing images load as they near the viewport.
function paintImageDiffs() {
    for (const img of Array.from(document.querySelectorAll("img[data-image-key]"))) {
        const entry = state.images.get(img.dataset.imageKey ?? "");
        if (entry?.status === "ready" && img.getAttribute("src") !== entry.url)
            img.src = entry.url;
    }
    imageObserver?.disconnect();
    const pending = Array.from(document.querySelectorAll(".image-diff[data-image-pending]"));
    if (!pending.length)
        return;
    if (typeof IntersectionObserver !== "function") {
        pending.forEach(requestImages);
        return;
    }
    imageObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting)
                continue;
            imageObserver?.unobserve(entry.target);
            requestImages(entry.target);
        }
    }, { root: $("#main"), rootMargin: IMAGE_PREFETCH_MARGIN });
    for (const block of pending)
        imageObserver.observe(block);
}
function repaintImageDiffs(affects) {
    let repainted = false;
    for (const block of Array.from(document.querySelectorAll(".image-diff[data-image-path]"))) {
        const file = fileOf(block.dataset.imagePath);
        if (!file || !affects(file))
            continue;
        block.outerHTML = imageDiffHtml(file);
        repainted = true;
    }
    paintImageDiffs();
    if (repainted)
        renderRuler();
}
function imageDiffHtml(file) {
    const sides = IMAGE_SIDES.filter((side) => file.imageSides?.[side]);
    if (!state.snapshot || !state.review || !sides.length)
        return "";
    const path = esc(file.path);
    const oidOf = (side) => file.imageSides?.[side] ?? "";
    const entryOf = (side) => state.images.get(imageKey(file.path, side, oidOf(side)));
    const entries = sides.map(entryOf);
    const attrs = `class="image-diff" data-image-path="${path}"${entries.some((entry) => !entry) ? " data-image-pending" : ""}`;
    if (entries.every((entry) => entry?.status === "failed")) {
        const message = file.binary ? `${file.note ?? "Binary file not shown."} ${IMAGE_UNAVAILABLE}` : IMAGE_UNAVAILABLE;
        return `<div ${attrs}><div class="card muted">${esc(message)}</div></div>`;
    }
    const image = (side, style = "") => {
        const name = side === "old" ? file.oldPath ?? file.path : file.path;
        return `<img data-image-key="${esc(imageKey(file.path, side, oidOf(side)))}" alt="${esc(`${IMAGE_SIDE_LABELS[side]}: ${name}`)}"${style}>`;
    };
    const before = entryOf("old");
    const after = entryOf("new");
    const comparable = before?.status === "ready" && after?.status === "ready" && oidOf("old") !== oidOf("new")
        && before.width > 0 && before.height > 0 && after.width > 0 && after.height > 0;
    const view = imageView(file.path);
    const mode = comparable ? view.mode : "2-up";
    const modes = comparable
        ? `<span class="seg image-modes" role="group" aria-label="Image comparison">${IMAGE_MODES.map((m) => `<button type="button" data-action="image-mode" data-path="${path}" data-mode="${m}" aria-pressed="${m === mode}">${IMAGE_MODE_LABELS[m]}</button>`).join("")}</span>`
        : "";
    if (!comparable || mode === "2-up") {
        const figures = sides.map((side) => {
            const entry = entryOf(side);
            const body = entry?.status === "ready" ? image(side)
                : `<p class="muted">${entry?.status === "failed" ? esc(IMAGE_UNAVAILABLE) : "Loading preview…"}</p>`;
            const meta = entry?.status === "ready" ? ` <span class="image-meta">${esc(imageMeta(entry))}</span>` : "";
            return `<figure><figcaption class="${side}">${IMAGE_SIDE_LABELS[side]}${meta}</figcaption><div class="image-stage">${body}</div></figure>`;
        });
        return `<div ${attrs}>${modes}<div class="image-sides">${figures.join("")}</div></div>`;
    }
    // Both layers share one stage sized to the larger image, so pixels at the same position line up.
    const width = Math.max(before.width, after.width);
    const height = Math.max(before.height, after.height);
    const layer = (side, entry) => `<div class="image-layer ${side}">${image(side, ` style="width:${(entry.width / width) * 100}%"`)}</div>`;
    const stage = `--split:${view.split}%;--opacity:${view.opacity};aspect-ratio:${width} / ${height};width:min(100%, ${width}px, calc(50vh * ${width} / ${height}))`;
    const swipe = mode === "swipe"
        ? `<div class="image-divider" aria-hidden="true"></div><input type="range" class="image-swipe" min="0" max="100" value="${view.split}" aria-label="Swipe position: Before shows left of the divider, After right of it" data-image-control="split" data-path="${path}">`
        : "";
    const onion = mode === "onion"
        ? `<label class="image-opacity"><span>Before</span><input type="range" min="0" max="100" value="${view.opacity}" aria-label="After image opacity" data-image-control="opacity" data-path="${path}"><span>After</span></label>`
        : "";
    const legend = `<div class="image-legend">${IMAGE_SIDES.map((side) => `<span><span class="image-side-label ${side}">${IMAGE_SIDE_LABELS[side]}</span> ${esc(imageMeta(side === "old" ? before : after))}</span>`).join("")}</div>`;
    return `<div ${attrs}>${modes}<div class="image-compare ${mode}" style="${stage}">${layer("old", before)}${layer("new", after)}${swipe}</div>${onion}${legend}</div>`;
}
function fileView(file, { stacked = false, folded = false } = {}) {
    const threads = (state.review?.threads ?? []).filter((t) => t.kind !== "overview" && t.location?.path === file.path);
    const placed = new Map();
    const unplaced = [];
    for (const t of threads) {
        const p = placeThread(t, file);
        if (!p) {
            unplaced.push(t);
            continue;
        }
        const key = p.where === "file" ? "file" : p.where === "hunk" ? `h${p.hunk}` : `r${p.hunk}:${p.row}`;
        if (!placed.has(key))
            placed.set(key, []);
        placed.get(key)?.push(t);
    }
    const highlighted = new Set();
    for (const t of threads) {
        if (t.kind !== "line" || t.status !== "active" || !t.location || t.location.state === "outdated"
            || t.location.startLine === undefined || t.location.endLine === undefined)
            continue;
        for (let n = t.location.startLine; n <= t.location.endLine; n++)
            highlighted.add(`${t.location.side}:${n}`);
    }
    const letter = STATUS_LETTER[file.status] ?? "M";
    const fileKey = `file:${file.path}`;
    const activeHere = threads.filter((t) => t.status === "active").length;
    const pathHtml = stacked
        ? `<button class="link path-link" data-action="nav" data-view="file" data-path="${esc(file.path)}" title="Open only this file">${esc(file.path)}</button>`
        : esc(file.path);
    const html = [`<section class="file-section" data-file="${esc(file.path)}">`,
        `<div class="file-head${stacked ? " stacked" : ""}">`
            + (stacked ? `<span class="twisty${folded ? "" : " open"}" data-action="fold-file" data-path="${esc(file.path)}" title="${folded ? "Show diff" : "Hide diff"}">${CHEVRON}</span>` : "")
            + `<span class="status-letter ${letter}">${letter}</span><span class="path">${pathHtml}${file.oldPath && file.oldPath !== file.path ? ` <span class="muted">(from ${esc(file.oldPath)})</span>` : ""}${file.untracked ? ` <span class="badge">untracked</span>` : ""}</span>`
            + (stacked && folded && activeHere ? `<span class="count">${activeHere}</span>` : "")
            + `<span class="stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`
            + `<button data-action="open" data-key="${esc(fileKey)}" data-path="${esc(file.path)}">Comment on file</button></div>`];
    if (folded) {
        html.push(`</section>`);
        return html.join("");
    }
    html.push((placed.get("file") ?? []).map((t) => threadHtml(t)).join(""));
    if (file.oldMode !== file.newMode && (file.oldMode || file.newMode)) {
        html.push(`<div class="card muted">File mode: ${esc(file.oldMode ?? "(absent)")} to ${esc(file.newMode ?? "(absent)")}${file.typeChanged ? " (file type changed)" : ""}</div>`);
    }
    if (state.open.has(fileKey) || getDraft(fileKey) || state.pending.has(fileKey)) {
        html.push(`<div class="thread">${composerHtml(fileKey, { kind: "file", path: file.path, label: `Comment on ${file.path}`, alwaysOpen: true })}</div>`);
    }
    if (file.binary)
        html.push(imageDiffHtml(file) || `<div class="card muted">${esc(file.note ?? "Binary file not shown.")}</div>`);
    else {
        if (!file.hunks.length)
            html.push(`<div class="card muted">No textual changes (mode or rename only).</div>`);
        html.push(imageDiffHtml(file));
    }
    if (!stacked && !file.full && needsContent(file)) {
        const entry = contentEntry(file);
        const why = entry.status === "unavailable"
            ? { stale: "the working tree changed since this revision; Refresh to see the full file", "too-large": "the file is too large", missing: "the file is missing from the working tree", "base-unavailable": "the base revision cannot be read" }[entry.reason ?? ""] ?? entry.reason
            : "";
        const note = entry.status === "loading" ? "Loading full file…"
            : entry.status === "ready" ? "Showing changes only until the current line selection is closed."
                : `Showing changes only: ${esc(why)}.`;
        html.push(`<div class="muted full-note">${note}</div>`);
    }
    const sel = state.selection?.path === file.path ? state.selection : null;
    const selRange = sel ? selectionRange(file, sel) : null;
    const syntax = highlightFile(file);
    html.push(`<div class="diff${file.full ? " full" : ""}">`);
    file.hunks.forEach((hunk, h) => {
        const range = hunk.gap ? null : hunkAnchorRange(hunk);
        const changeKey = range ? `change:${file.path}:${range.side}:${range.startLine}-${range.endLine}` : null;
        if (!hunk.gap) {
            html.push(file.full
                ? `<div class="hunk-head change-bar"><span class="h muted">Change ${esc(lineLabel(range ?? {}))}</span>${range ? `<button data-action="open" data-key="${esc(changeKey)}">Discuss this change</button>` : ""}</div>`
                : `<div class="hunk-head"><span class="h" title="${esc(hunk.header)}">${esc(hunk.header)}</span>${range ? `<button data-action="open" data-key="${esc(changeKey)}">Discuss this change</button>` : ""}</div>`);
        }
        const hunkThreads = placed.get(`h${h}`) ?? [];
        const showChangeComposer = Boolean(range && changeKey && (state.open.has(changeKey) || getDraft(changeKey) || state.pending.has(changeKey)));
        if (hunkThreads.length || showChangeComposer) {
            html.push(`<div class="hunk-threads">${hunkThreads.map((t) => threadHtml(t)).join("")}`
                + (showChangeComposer && range && changeKey ? `<div class="thread">${composerHtml(changeKey, { kind: "change", path: file.path, side: range.side, startLine: range.startLine, endLine: range.endLine, label: `Discuss this change (${range.side === "old" ? "old " : ""}${lineLabel(range)})`, alwaysOpen: true })}</div>` : "")
                + `</div>`);
        }
        html.push(`<table class="rows"><colgroup><col style="width:52px"><col style="width:52px"><col style="width:22px"><col></colgroup><tbody>`);
        hunk.rows.forEach((row, i) => {
            const selected = sel && sel.hunk === h && i >= sel.from && i <= sel.to;
            const hl = (row.n != null && highlighted.has(`new:${row.n}`)) || (row.t === "del" && highlighted.has(`old:${row.o}`));
            const prefix = row.t === "add" ? "+" : row.t === "del" ? "-" : " ";
            html.push(`<tr class="row ${row.t}${selected ? " sel" : ""}${hl ? " hl" : ""}" data-h="${h}" data-i="${i}">`
                + `<td class="ln">${row.o ?? ""}</td><td class="ln">${row.n ?? ""}</td><td class="gut"><span>+</span></td>`
                + `<td class="code" data-p="${prefix}">${syntax[h][i]}</td></tr>`);
            if (row.noNewlineAtEnd) {
                const side = row.t === "del" ? "old side" : row.t === "add" ? "new side" : "both sides";
                html.push(`<tr class="eof-note"><td colspan="3"></td><td>\\ No newline at end of file (${side})</td></tr>`);
            }
            const rowThreads = placed.get(`r${h}:${i}`) ?? [];
            const composerHere = Boolean(sel && selRange && !state.dragging && sel.hunk === h && sel.to === i);
            if (rowThreads.length || (composerHere && selRange)) {
                const lineKey = composerHere && selRange ? `line:${file.path}:${selRange.side}:${selRange.startLine}-${selRange.endLine}` : "";
                html.push(`<tr class="inline"><td colspan="4">${rowThreads.map((t) => threadHtml(t)).join("")}`
                    + (composerHere && selRange ? `<div class="thread">${composerHtml(lineKey, { kind: "line", path: file.path, side: selRange.side, startLine: selRange.startLine, endLine: selRange.endLine, label: `Comment on ${selRange.side === "old" ? "old " : ""}${lineLabel(selRange)}`, alwaysOpen: true })}</div>` : "")
                    + `</td></tr>`);
            }
        });
        html.push(`</tbody></table>`);
    });
    html.push(`</div>`);
    if (unplaced.length) {
        html.push(`<h2>Comments outside the current diff (${unplaced.length})</h2>${unplaced.map((t) => threadHtml(t)).join("")}`);
    }
    html.push(`</section>`);
    return html.join("");
}
// Folder selection shows every changed file under it, stacked, like ADO's Files tab.
// Past a row budget, files start folded so huge folders stay responsive.
function folderView(dir) {
    const files = filesUnder(dir);
    const adds = files.reduce((s, f) => s + f.additions, 0);
    const dels = files.reduce((s, f) => s + f.deletions, 0);
    const html = [`<div class="folder-head">${FOLDER_ICON}<span class="path">${esc(dir === "" ? repoName() : dir)}</span>`
            + `<span class="muted">${files.length} file${files.length === 1 ? "" : "s"}</span>`
            + `<span class="stat"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>`
            + `<span class="spacer"></span><button class="link" data-action="fold-all" data-fold="1">Collapse all</button><button class="link" data-action="fold-all" data-fold="0">Expand all</button></div>`];
    let rows = 0;
    for (const f of files) {
        const size = f.hunks.reduce((s, h) => s + h.rows.length, 0);
        const folded = state.fileFold.has(f.path) ? state.fileFold.get(f.path) : rows + size > FOLDER_VIEW_ROW_BUDGET && rows > 0;
        if (!folded)
            rows += size;
        html.push(fileView(f, { stacked: true, folded }));
    }
    return html.join("");
}
// ---------- Actions ----------
let toastTimer;
function toast(text, error = false) {
    const el = $("#toast");
    if (!el)
        return;
    el.textContent = text;
    el.className = error ? "error" : "";
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        el.hidden = true;
    }, error ? 6000 : 2500);
}
function navigate(view) {
    state.view = view;
    state.selection = null;
    state.pendingJump = null;
    if (view.type === "file" || view.type === "folder")
        expandAncestors(view.path);
    saveView();
    render();
    const main = $("#main");
    if (main)
        main.scrollTop = 0;
}
function focusComposer(key) {
    const el = document.querySelector(`textarea[data-composer="${CSS.escape(key)}"]`);
    if (el) {
        el.focus();
        el.scrollIntoView({ block: "nearest" });
    }
}
function jumpToThread(threadId) {
    const review = state.review;
    if (!review)
        return;
    const t = review.threads.find((x) => x.threadId === threadId);
    if (!t) {
        if (state.archived.some((x) => x.threadId === threadId)) {
            navigate({ type: "history" });
            state.pendingJump = threadId;
            revealPendingJump();
        }
        return;
    }
    state.collapsedThreads.delete(threadId);
    if (t.status !== "active" || t.location?.state === "outdated")
        state.expanded.add(threadId);
    const path = t.location?.path;
    const inFile = t.kind !== "overview" && isPlaced(t) && fileOf(path);
    const unplacedInFile = t.kind !== "overview" && !isPlaced(t) && fileOf(t.location?.path);
    if ((inFile || unplacedInFile) && path && state.view.type === "folder" && inDir(path, state.view.path)) {
        state.fileFold.set(path, false);
        render();
    }
    else {
        navigate((inFile || unplacedInFile) && path ? { type: "file", path } : { type: "overview" });
    }
    state.pendingJump = threadId;
    revealPendingJump();
}
// Scrolls to a jumped-to thread; retried after the full file loads, since it may move or appear then.
function revealPendingJump() {
    const threadId = state.pendingJump;
    if (!threadId)
        return;
    const el = document.querySelector(`[data-thread-id="${CSS.escape(threadId)}"]`);
    if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1600);
    }
    const loading = state.view.type === "file" && [...state.content.values()].some((e) => e.status === "loading");
    if (!loading)
        state.pendingJump = null;
}
function closeComposer(key, discard) {
    pinnedComposers.delete(key);
    composerContexts.delete(key);
    if (discard) {
        setDraft(key, "");
        setDraftImages(key, []);
        imageUploads.delete(key);
    }
    state.open.delete(key);
    state.pending.delete(key);
    persistPinnedComposers();
    if (key.startsWith("line:"))
        state.selection = null;
    if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.composer === key)
        document.activeElement.blur();
    render();
}
// The composer's default action: undefined lets the server apply the delivery mode; otherwise the comment is held as a draft.
function defaultDraft() {
    return deliveryMode() === "immediate" ? undefined : true;
}
async function submit(key, draft = defaultDraft()) {
    const review = state.review;
    if (!review)
        return;
    const box = document.querySelector(`.composer[data-key="${CSS.escape(key)}"]`);
    const textarea = box?.querySelector("textarea");
    if (!box || !textarea)
        return;
    const body = textarea.value.trim();
    const imageIds = getDraftImages(key);
    if (imageUploads.has(key) || state.pending.get(key)?.sending)
        return;
    if (!body && !imageIds.length) {
        textarea.focus();
        return;
    }
    setDraft(key, textarea.value);
    const pending = state.pending.get(key) ?? { clientRequestId: uuid() };
    pending.sending = true;
    pending.error = null;
    state.pending.set(key, pending);
    const submittedKey = () => state.review?.reviewId === review.reviewId
        ? [...state.pending].find(([, entry]) => entry === pending)?.[0]
        : undefined;
    render();
    try {
        let res;
        const hold = draft === undefined ? {} : { draft };
        if (key.startsWith("reply:")) {
            res = await api("POST", `threads/${encodeURIComponent(key.slice(6))}/messages`, { body, imageIds, clientRequestId: pending.clientRequestId, descriptionVersion: review.description?.version ?? 0, ...hold });
        }
        else {
            const d = box.dataset;
            res = await api("POST", "threads", {
                kind: d.kind,
                path: d.path,
                side: d.side,
                startLine: d.start ? Number(d.start) : undefined,
                endLine: d.end ? Number(d.end) : undefined,
                revisionId: d.revision || review.currentRevisionId,
                descriptionVersion: review.description?.version ?? 0,
                body,
                imageIds,
                clientRequestId: pending.clientRequestId,
                ...hold,
            });
        }
        const sentKey = submittedKey();
        if (sentKey === undefined)
            return;
        setDraft(sentKey, "");
        setDraftImages(sentKey, []);
        pinnedComposers.delete(sentKey);
        composerContexts.delete(sentKey);
        state.pending.delete(sentKey);
        state.open.delete(sentKey);
        persistPinnedComposers();
        if (sentKey.startsWith("line:"))
            state.selection = null;
        if (document.activeElement instanceof HTMLElement)
            document.activeElement.blur();
        await loadState();
        if (isRecord(res) && typeof res.threadId === "string" && !key.startsWith("reply:")) {
            const el = document.querySelector(`[data-thread-id="${CSS.escape(res.threadId)}"]`);
            el?.classList.add("flash");
            setTimeout(() => el?.classList.remove("flash"), 1600);
        }
    }
    catch (err) {
        if (submittedKey() === undefined)
            return;
        pending.sending = false;
        pending.error = errorMessage(err);
        render();
    }
}
function dataValue(element, name) {
    return element.dataset[name] ?? "";
}
async function onClick(e) {
    if (!(e.target instanceof Element))
        return;
    const commentLink = e.target.closest("a[data-markdown-link][href]");
    if (commentLink?.tagName === "A") {
        e.preventDefault();
        try {
            await api("POST", "open-comment-link", { url: commentLink.href });
        }
        catch (error) {
            toast(errorMessage(error), true);
        }
        return;
    }
    if (e.type === "auxclick")
        return;
    const target = e.target.closest("[data-action]");
    if (!target || target instanceof HTMLSelectElement)
        return;
    const value = (name) => dataValue(target, name);
    const action = value("action");
    try {
        switch (action) {
            case "remove-image": {
                const key = value("key");
                setDraftImages(key, getDraftImages(key).filter((id) => id !== value("image")));
                render();
                focusComposer(key);
                break;
            }
            case "review-command": {
                const textarea = target.closest(".composer")?.querySelector("textarea[data-composer]");
                if (textarea && REVIEW_COMMANDS.some(({ name }) => name === target.dataset.command)) {
                    textarea.value = `/${target.dataset.command} `;
                    textarea.focus();
                    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
                    textarea.dispatchEvent(new Event("input", { bubbles: true }));
                }
                break;
            }
            case "agent-review":
                await runAgentReview();
                break;
            case "agent-review-configure":
                openAgentReview("agent-review-configure");
                break;
            case "agent-review-save-defaults":
                await startAgentReview(true);
                break;
            case "agent-review-apply-skills":
                applyReviewSkills();
                break;
            case "agent-review-start":
                await startAgentReview();
                break;
            case "agent-review-close":
                await api("POST", `agent-reviews/${encodeURIComponent(value("run"))}/close`, {});
                await loadState();
                break;
            case "discuss-finding":
                state.collapsedThreads.delete(value("thread"));
                state.expanded.add(value("thread"));
                state.open.add(`reply:${value("thread")}`);
                render();
                focusComposer(`reply:${value("thread")}`);
                break;
            case "approve-finding": {
                const id = value("thread");
                const review = state.review;
                if (!review || !id)
                    break;
                if (state.approving.has(id))
                    break;
                state.approving.add(id);
                render();
                try {
                    const res = await api("POST", `threads/${encodeURIComponent(id)}/approve`, { revisionId: review.currentRevisionId });
                    const message = isRecord(res) && typeof res.error === "string" ? res.error : null;
                    toast(message ? `Approved, but delivery failed: ${message}. Retry in the thread.` : "Approved and sent to the coding agent", Boolean(message));
                }
                finally {
                    state.approving.delete(id);
                    await loadState();
                }
                break;
            }
            case "discuss-description":
                focusComposer("overview:new");
                break;
            case "nav": {
                const view = value("view");
                const path = value("path");
                if (view === "folder" && state.view.type === "folder" && state.view.path === path) {
                    setDirCollapsed(path, !collapsedDirs().has(path));
                    render();
                }
                else {
                    if (view === "file" || view === "folder")
                        navigate({ type: view, path });
                    else if (view === "overview" || view === "lessons" || view === "agent-comments" || view === "history")
                        navigate({ type: view });
                }
                break;
            }
            case "fold":
                setDirCollapsed(value("path"), !collapsedDirs().has(value("path")));
                render();
                break;
            case "fold-tree":
                setAllDirsCollapsed(value("fold") === "1");
                render();
                break;
            case "fold-file": {
                const path = value("path");
                state.fileFold.set(path, target.classList.contains("open"));
                render();
                document.querySelector(`.file-section[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
                break;
            }
            case "image-mode": {
                const path = value("path");
                const mode = IMAGE_MODES.find((m) => m === value("mode"));
                if (!mode)
                    break;
                state.imageViews.set(path, { ...imageView(path), mode });
                repaintImageDiffs((file) => file.path === path);
                document.querySelector(`.image-diff[data-image-path="${CSS.escape(path)}"] [data-action="image-mode"][data-mode="${mode}"]`)?.focus();
                break;
            }
            case "fold-all":
                for (const f of filesUnder(state.view.type === "folder" ? state.view.path : ""))
                    state.fileFold.set(f.path, value("fold") === "1");
                render();
                break;
            case "refresh":
                target.setAttribute("disabled", "");
                await refreshReview();
                toast("Refreshed from the working tree");
                break;
            case "open":
                if (value("path"))
                    state.fileFold.set(value("path"), false);
                state.open.add(value("key"));
                render();
                focusComposer(value("key"));
                break;
            case "cancel":
                closeComposer(value("key"), true);
                break;
            case "submit": {
                const flag = value("draft");
                await submit(value("key"), flag === "1" ? true : flag === "0" ? false : defaultDraft());
                break;
            }
            case "retry":
                await api("POST", `messages/${encodeURIComponent(value("message"))}/retry`, {});
                await loadState();
                toast("Sent to Copilot again");
                break;
            case "send-draft": {
                const res = await api("POST", `messages/${encodeURIComponent(value("message"))}/send`, {});
                await loadState();
                const message = isRecord(res) && typeof res.error === "string" ? res.error : null;
                toast(message ?? "Sent to Copilot", Boolean(message));
                break;
            }
            case "discard-draft":
                await api("POST", `messages/${encodeURIComponent(value("message"))}/discard`, {});
                await loadState();
                toast("Draft discarded");
                break;
            case "submit-review": {
                if (state.submitting)
                    break;
                state.submitting = true;
                renderTop();
                try {
                    const res = await api("POST", "submit", {});
                    const submitted = isRecord(res) && typeof res.submitted === "number" ? res.submitted : 0;
                    const error = isRecord(res) && typeof res.error === "string" ? res.error : null;
                    if (error)
                        toast(error, true);
                    else
                        toast(`Sent ${submitted} ${submitted === 1 ? "comment" : "comments"} to Copilot`);
                }
                finally {
                    state.submitting = false;
                    await loadState();
                }
                break;
            }
            case "delivery-choose": {
                const mode = value("mode");
                if (mode !== "immediate" && mode !== "batch")
                    break;
                const res = await api("POST", "delivery", { mode });
                await loadState();
                const submitted = isRecord(res) && typeof res.submitted === "number" ? res.submitted : 0;
                const error = isRecord(res) && typeof res.error === "string" ? res.error : null;
                const drafts = `${submitted} waiting ${submitted === 1 ? "draft" : "drafts"}`;
                if (error)
                    toast(`Sending each comment now, but ${drafts} could not be sent: ${error}`, true);
                else
                    toast(mode === "immediate"
                        ? (submitted ? `Sending each comment now. Sent ${drafts}.` : "Sending each comment now")
                        : "Batching comments. Submit the review when you are done.");
                break;
            }
            case "delivery-reask":
                await api("POST", "delivery", { mode: null });
                await loadState();
                break;
            case "toggle": {
                const id = value("thread");
                const thread = state.review?.threads.find((t) => t.threadId === id);
                if (!thread)
                    break;
                if (threadCollapsed(thread)) {
                    state.collapsedThreads.delete(id);
                    state.expanded.add(id);
                }
                else {
                    state.expanded.delete(id);
                    if (!threadDefaultsCollapsed(thread))
                        state.collapsedThreads.add(id);
                }
                render();
                break;
            }
            case "jump":
                jumpToThread(value("thread"));
                break;
            case "history-select":
                if (target instanceof HTMLInputElement) {
                    if (target.checked)
                        state.historySelection.add(value("thread"));
                    else
                        state.historySelection.delete(value("thread"));
                    renderFollowUpButton();
                }
                break;
            case "start-follow-up":
                await startFollowUp();
                break;
            case "scope":
                {
                    const scope = value("scope");
                    if (scope === "all" || scope === "pending")
                        await switchScope(scope);
                }
                break;
            case "review-skills-refresh":
                await refreshReviewSkills();
                break;
            case "review-tab":
                if (state.dialog?.type === "agent-review" && state.dialog.tab !== value("tab")) {
                    state.dialog.tab = value("tab") === "skills" ? "skills" : "general";
                    renderDialog();
                    focusIn(`#dialog [data-action="review-tab"][data-tab="${state.dialog.tab}"]`);
                }
                break;
            case "configure":
            case "configure-parallelism":
                openConfigure(action);
                break;
            case "dialog-cancel":
                closeConfigure();
                break;
            case "dialog-backdrop":
                if (e.target === target)
                    closeConfigure();
                break;
            case "dialog-save":
                await saveConfigure();
                break;
            case "mapping-add":
                if (state.dialog?.type === "configure") {
                    state.dialog.instructionMappings.push({ pathPrefix: "", instructionRoot: "", splitLanguageSpecific: true });
                    renderDialog();
                    focusIn(`#dialog input[name="mapping-prefix"][data-index="${state.dialog.instructionMappings.length - 1}"]`);
                }
                break;
            case "mapping-remove":
                if (state.dialog?.type === "configure") {
                    const index = Number(value("index"));
                    if (Number.isInteger(index) && index >= 0 && index < state.dialog.instructionMappings.length) {
                        state.dialog.instructionMappings.splice(index, 1);
                        renderDialog();
                        focusIn('#dialog [data-action="mapping-add"]');
                    }
                }
                break;
            case "learning-set":
                if (value("enabled") === "true" || value("enabled") === "false") {
                    await updateSettings({ autoSaveLearnedRules: value("enabled") === "true" });
                    toast(autoSaveLabel());
                }
                break;
            case "save-lesson":
                {
                    const lessonId = value("lesson");
                    const candidate = target.closest("[data-lesson-form]");
                    const form = candidate?.dataset?.lessonForm ? candidate : null;
                    const renderedProposal = form
                        ? { rule: dataValue(form, "rule"), scope: dataValue(form, "scope") }
                        : { rule: value("rule"), scope: value("scope") };
                    let proposal;
                    if (form) {
                        const currentKey = JSON.stringify(destinationFormProposal(form));
                        const previewIsCurrent = form.dataset.destinationPreviewState === "ready"
                            && form.dataset.destinationPreviewKey === currentKey;
                        if (!previewIsCurrent) {
                            const resolved = await updateDestinationPreview(form);
                            if (!resolved) {
                                toast("Could not resolve the actual repository destination. Review the error above before saving.", true);
                                break;
                            }
                            const latestKey = JSON.stringify(destinationFormProposal(form));
                            if (form.dataset.destinationPreviewState !== "ready" || form.dataset.destinationPreviewKey !== latestKey) {
                                toast("The destination changed while it was resolving. Review the updated preview, then confirm the save.");
                            }
                            else {
                                toast("Destination preview updated. Review it, then confirm the save.");
                            }
                            break;
                        }
                        const resolved = await updateDestinationPreview(form);
                        if (!resolved) {
                            toast("Could not resolve the actual repository destination. Review the error above before saving.", true);
                            break;
                        }
                        proposal = {
                            ...renderedProposal, ...destinationFormProposal(form),
                            expectedSavedTo: resolved.savedTo,
                            ...(form.dataset.expectedMappings ? { expectedInstructionMappings: JSON.parse(form.dataset.expectedMappings) } : {}),
                        };
                    }
                    else {
                        proposal = JSON.parse(value("proposal"));
                    }
                    const result = await api("POST", `lessons/${encodeURIComponent(lessonId)}/save`, proposal);
                    await loadState();
                    toast(isRecord(result) && result.status === "saved" ? "Guideline saved." : "Guideline remains proposed; review its destination and try again.", !(isRecord(result) && result.status === "saved"));
                }
                break;
            case "learning-dismiss":
                await updateSettings({ dismissed: true });
                break;
            default:
                break;
        }
    }
    catch (err) {
        if (action === "refresh")
            target.removeAttribute("disabled");
        else {
            if (action === "save-lesson") {
                const candidate = target.closest("[data-lesson-form]");
                if (candidate?.dataset?.lessonForm) {
                    destinationPreviewRequests.delete(candidate);
                    await updateDestinationPreview(candidate);
                    await refreshDestinationAfterFailedSave(candidate).catch(() => undefined);
                }
            }
            toast(errorMessage(err), true);
        }
    }
}
async function onChange(e) {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement))
        return;
    if (state.dialog?.type === "configure" && el.dataset?.index !== undefined) {
        const index = Number(el.dataset.index);
        const mapping = state.dialog.instructionMappings[index];
        if (mapping) {
            if (el.name === "mapping-prefix")
                mapping.pathPrefix = el.value;
            else if (el.name === "mapping-root")
                mapping.instructionRoot = el.value;
            else if (el.name === "mapping-split" && el instanceof HTMLInputElement)
                mapping.splitLanguageSpecific = el.checked;
            return;
        }
    }
    if (el.closest?.("[data-lesson-form]")) {
        const candidate = el.closest("[data-lesson-form]");
        const form = candidate?.dataset?.lessonForm ? candidate : null;
        if (form) {
            form.dataset.destinationEdited = "true";
            void updateDestinationPreview(form);
        }
    }
    if (el instanceof HTMLInputElement && el.name === "review-skill-defaults" && state.dialog?.type === "agent-review") {
        state.dialog.saveSkillDefaults = el.checked;
        renderDialog();
        focusIn(`#dialog input[name="${el.name}"]`);
        return;
    }
    if (el instanceof HTMLInputElement && el.name === "review-skill" && state.dialog?.type === "agent-review") {
        const names = new Set(state.dialog.skillNames ?? []);
        if (el.checked)
            names.add(el.value);
        else
            names.delete(el.value);
        state.dialog.skillNames = (state.dialog.skillCatalog?.skills.map((skill) => skill.name) ?? [...names]).filter((name) => names.has(name));
        return;
    }
    if (el instanceof HTMLInputElement && (el.name === "review-save-defaults" || el.name === "review-skip-dialog") && state.dialog?.type === "agent-review") {
        state.dialog[el.name === "review-save-defaults" ? "saveDefaults" : "skipDialog"] = el.checked;
        renderDialog();
        focusIn(`#dialog input[name="${el.name}"]`);
        return;
    }
    if (el.name === "review-focus" && state.dialog?.type === "agent-review") {
        if (isReviewFocus(el.value))
            state.dialog.focus = el.value;
        return;
    }
    if ((el.name === "autoSaveLearnedRules" || el.name === "delivery" || el.name === "commentConcurrency") && state.dialog?.type === "configure") {
        if (el instanceof HTMLInputElement && el.name === "autoSaveLearnedRules")
            state.dialog.autoSaveLearnedRules = el.checked;
        if (el.name === "delivery" && (el.value === "immediate" || el.value === "batch" || el.value === "ask"))
            state.dialog.delivery = el.value;
        if (el.name === "commentConcurrency" && /^[1-4]$/.test(el.value))
            state.dialog.commentConcurrency = Number(el.value);
        return;
    }
    if (el.dataset?.action !== "status")
        return;
    const threadId = el.dataset.thread;
    if (!threadId || !isThreadStatus(el.value))
        return;
    try {
        await api("POST", `threads/${encodeURIComponent(threadId)}/status`, { status: el.value });
        if (el.value !== "active")
            state.expanded.delete(threadId);
        await loadState();
    }
    catch (err) {
        toast(errorMessage(err), true);
        await loadState().catch(() => undefined);
    }
}
function updateReviewCommands(textarea) {
    const menu = textarea.closest(".composer")?.querySelector(".review-commands");
    if (!menu)
        return;
    const commands = reviewCommandSuggestions(textarea.value);
    menu.hidden = !commands.length;
    menu.innerHTML = commands.map(({ name, description }, index) => `<button type="button" tabindex="-1" data-action="review-command" data-command="${name}"${index ? "" : ' class="selected"'}><strong>/${name}</strong> <span>${esc(description)}</span></button>`).join("");
}
function onInput(e) {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
        return;
    if (state.dialog?.type === "configure" && el.dataset?.index !== undefined) {
        const index = Number(el.dataset.index);
        const mapping = state.dialog.instructionMappings[index];
        if (mapping) {
            if (el.name === "mapping-prefix")
                mapping.pathPrefix = el.value;
            else if (el.name === "mapping-root")
                mapping.instructionRoot = el.value;
            return;
        }
    }
    const control = el.dataset?.imageControl;
    if (control === "split" || control === "opacity") {
        const path = el.dataset.path ?? "";
        const amount = Math.min(100, Math.max(0, Number(el.value) || 0));
        const view = { ...imageView(path) };
        view[control] = amount;
        state.imageViews.set(path, view);
        el.closest(".image-diff")?.querySelector(".image-compare")?.style.setProperty(`--${control}`, control === "split" ? `${amount}%` : String(amount));
        return;
    }
    const candidate = el.closest?.("[data-lesson-form]");
    const form = candidate?.dataset?.lessonForm ? candidate : null;
    if (form) {
        form.dataset.destinationEdited = "true";
        void updateDestinationPreview(form);
    }
    if ((el.name === "review-models" || el.name === "review-intent") && state.dialog?.type === "agent-review") {
        state.dialog[el.name === "review-models" ? "models" : "intent"] = el.value;
        return;
    }
    if (el.dataset?.composer) {
        setDraft(el.dataset.composer, el.value);
        el.closest(".composer")?.classList.add("open");
        if (el instanceof HTMLTextAreaElement)
            updateReviewCommands(el);
    }
}
async function onPaste(event) {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement) || !field.dataset.composer || field.disabled || !state.review)
        return;
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length)
        return;
    event.preventDefault();
    const key = field.dataset.composer;
    const reviewId = state.review.reviewId;
    if (imageUploads.has(key))
        return;
    if (getDraftImages(key).length + files.length > 4) {
        toast("A comment can attach up to four images.", true);
        return;
    }
    const upload = { key };
    imageUploads.set(key, upload);
    render();
    const active = () => state.review?.reviewId === reviewId && imageUploads.get(upload.key) === upload;
    try {
        for (const file of files) {
            if (!active())
                return;
            if (file.size > 2 * 1024 * 1024)
                throw new Error("Paste an image up to 2 MB.");
            const response = await fetch("/api/comment-images", { method: "POST",
                headers: { "X-MR-Token": TOKEN, "X-MR-Review": reviewId }, body: file });
            const result = await response.json();
            if (!active())
                return;
            if (!response.ok || !isRecord(result) || typeof result.imageId !== "string") {
                throw new Error(isRecord(result) && isRecord(result.error) && typeof result.error.message === "string"
                    ? result.error.message : "Could not attach the image.");
            }
            setDraftImages(upload.key, [...new Set([...getDraftImages(upload.key), result.imageId])]);
        }
    }
    catch (error) {
        if (active())
            toast(errorMessage(error), true);
    }
    finally {
        if (active()) {
            imageUploads.delete(upload.key);
            render();
        }
    }
}
function onKeyDown(e) {
    if (state.dialog) {
        if (e.key === "Escape") {
            e.preventDefault();
            closeConfigure();
        }
        else if (e.key === "Tab")
            trapTab(e);
        return;
    }
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement))
        return;
    const key = el.dataset.composer;
    if (!key)
        return;
    const menu = el.closest(".composer")?.querySelector(".review-commands:not([hidden])");
    if (menu && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const options = Array.from(menu.querySelectorAll("button"));
        const selected = options.findIndex((option) => option.classList.contains("selected"));
        if (e.key === "Escape") {
            e.preventDefault();
            menu.hidden = true;
            return;
        }
        if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
            e.preventDefault();
            if (e.key === "Enter")
                options[Math.max(0, selected)].click();
            else {
                const next = (selected + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                options.forEach((option, index) => option.classList.toggle("selected", index === next));
            }
            return;
        }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit(key);
    }
    else if (e.key === "Escape") {
        e.preventDefault();
        const empty = !el.value.trim() && !getDraftImages(key).length && !imageUploads.has(key);
        if (key.startsWith("reply:") && empty) {
            el.closest(".composer")?.classList.remove("open");
            el.blur();
        }
        else if (empty)
            closeComposer(key, true);
        else
            el.blur();
    }
}
function onFocusIn(e) {
    const el = e.target;
    if (el instanceof HTMLTextAreaElement && el.dataset.composer) {
        el.closest(".composer")?.classList.add("open");
        updateReviewCommands(el);
    }
}
function onFocusOut(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement))
        return;
    const key = el.dataset?.composer;
    const menu = el.closest(".composer")?.querySelector(".review-commands");
    if (menu)
        menu.hidden = true;
    if (!key || !key.startsWith("reply:"))
        return;
    setTimeout(() => {
        const box = el.closest(".composer");
        if (box && !el.value.trim() && !getDraftImages(key).length && !imageUploads.has(key) && !box.contains(document.activeElement))
            box.classList.remove("open");
    }, 150);
}
function rulerMarks(items, scrollHeight, minPx = 3) {
    const marks = [];
    for (const it of items) {
        const last = marks[marks.length - 1];
        if (last && last.kind === it.kind && it.top <= last.bottom + 1) {
            last.bottom = Math.max(last.bottom, it.top + it.height);
            continue;
        }
        marks.push({ kind: it.kind, top: it.top, bottom: it.top + it.height });
    }
    return marks.map((m) => ({
        kind: m.kind,
        top: m.top,
        topPct: (m.top / scrollHeight) * 100,
        heightPct: (Math.max(m.bottom - m.top, 0) / scrollHeight) * 100,
        minPx,
    }));
}
function renderRuler() {
    const main = $("#main");
    const ruler = $("#ruler");
    if (!main || !ruler)
        return;
    const mainRect = main.getBoundingClientRect();
    ruler.style.right = `${main.offsetWidth - main.clientWidth}px`;
    const offset = main.scrollTop - mainRect.top;
    const items = [];
    for (const el of Array.from(main.querySelectorAll("tr.row.add, tr.row.del, tr.inline"))) {
        const r = el.getBoundingClientRect();
        if (!r.height)
            continue;
        const kind = el.classList.contains("inline") ? "thread" : el.classList.contains("add") ? "add" : "del";
        items.push({ kind, top: r.top + offset, height: r.height });
    }
    const scrollable = main.scrollHeight > main.clientHeight;
    ruler.hidden = !scrollable || items.length === 0;
    if (ruler.hidden) {
        ruler.innerHTML = "";
        return;
    }
    ruler.innerHTML = rulerMarks(items, main.scrollHeight)
        .map((m) => `<div class="mark ${m.kind}" data-top="${m.top}" style="top:${m.topPct}%;height:max(${m.minPx}px, ${m.heightPct}%)"></div>`)
        .join("")
        + `<div class="viewport"></div>`;
    paintRulerViewport();
}
function paintRulerViewport() {
    const main = $("#main");
    const vp = $("#ruler .viewport");
    if (!main || !vp)
        return;
    vp.style.top = `${(main.scrollTop / main.scrollHeight) * 100}%`;
    vp.style.height = `${(main.clientHeight / main.scrollHeight) * 100}%`;
}
function onRulerClick(e) {
    const main = $("#main");
    const ruler = $("#ruler");
    if (!main || !ruler || !(e.target instanceof Element))
        return;
    const mark = e.target.closest(".mark");
    const target = mark
        ? Number(mark.dataset.top)
        : ((e.clientY - ruler.getBoundingClientRect().top) / ruler.clientHeight) * main.scrollHeight;
    main.scrollTo({ top: Math.max(0, target - main.clientHeight / 3), behavior: "smooth" });
}
// ---------- Line selection (click / shift-click / drag on line numbers or "+") ----------
function rowFromEvent(e) {
    if (!(e.target instanceof Element))
        return null;
    const tr = e.target.closest("tr.row");
    const path = tr?.closest("[data-file]")?.dataset.file;
    if (!tr || !path)
        return null;
    return { path, h: Number(tr.dataset.h), i: Number(tr.dataset.i), full: Boolean(tr.closest(".diff")?.classList.contains("full")) };
}
function paintSelection() {
    const sel = state.selection;
    for (const tr of Array.from(document.querySelectorAll("tr.row"))) {
        const on = sel && tr.closest("[data-file]")?.dataset.file === sel.path && Number(tr.dataset.h) === sel.hunk && Number(tr.dataset.i) >= sel.from && Number(tr.dataset.i) <= sel.to;
        tr.classList.toggle("sel", Boolean(on));
    }
}
function onMouseDown(e) {
    if (e.target instanceof Element && e.target.closest(".review-commands button")) {
        e.preventDefault(); // Keep the composer focused until the click chooses a command.
        return;
    }
    if (e.button !== 0 || !(e.target instanceof Element) || !e.target.closest("td.ln, td.gut"))
        return;
    const pos = rowFromEvent(e);
    if (!pos)
        return;
    e.preventDefault();
    const { path } = pos;
    const sel = state.selection;
    if (e.shiftKey && sel && sel.path === path && sel.hunk === pos.h && sel.full === pos.full) {
        sel.from = Math.min(sel.anchor, pos.i);
        sel.to = Math.max(sel.anchor, pos.i);
    }
    else {
        state.selection = { path, hunk: pos.h, anchor: pos.i, from: pos.i, to: pos.i, full: pos.full };
    }
    state.dragging = true;
    paintSelection();
}
function onMouseOver(e) {
    if (!state.dragging)
        return;
    const pos = rowFromEvent(e);
    const sel = state.selection;
    if (!pos || !sel || pos.path !== sel.path || pos.h !== sel.hunk)
        return;
    sel.from = Math.min(sel.anchor, pos.i);
    sel.to = Math.max(sel.anchor, pos.i);
    paintSelection();
}
function onMouseUp() {
    if (!state.dragging)
        return;
    state.dragging = false;
    const selection = state.selection;
    if (!selection)
        return;
    const file = displayFile(selection.path);
    if (!file)
        return;
    const r = selectionRange(file, selection);
    render();
    focusComposer(`line:${file.path}:${r.side}:${r.startLine}-${r.endLine}`);
}
// ---------- Boot ----------
document.addEventListener("click", onClick);
document.addEventListener("auxclick", (e) => {
    if (e.button === 1)
        void onClick(e);
});
document.addEventListener("change", onChange);
document.addEventListener("input", onInput);
document.addEventListener("paste", onPaste);
document.addEventListener("keydown", onKeyDown);
document.addEventListener("focusin", onFocusIn);
document.addEventListener("focusout", onFocusOut);
document.addEventListener("mousedown", onMouseDown);
document.addEventListener("mouseover", onMouseOver);
document.addEventListener("mouseup", onMouseUp);
document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("#ruler"))
        onRulerClick(e);
    else
        requestAnimationFrame(renderRuler);
});
document.addEventListener("scroll", (e) => { if (e.target instanceof HTMLElement && e.target.id === "main")
    paintRulerViewport(); }, true);
globalThis.addEventListener?.("resize", () => requestAnimationFrame(renderRuler));
setInterval(() => {
    if (!state.review || state.dragging)
        return;
    if (document.activeElement?.tagName === "TEXTAREA")
        renderTop();
    else
        render();
}, 30000);
// Pull request state changes on GitHub without any local event, so poll it while the canvas is on screen.
setInterval(() => {
    if (state.review)
        checkPullRequest();
}, PULL_REQUEST_POLL_MS);
document.addEventListener("visibilitychange", () => {
    if (state.review && Date.now() - lastPullRequestCheck >= PULL_REQUEST_POLL_MS)
        checkPullRequest();
});
if (!TOKEN) {
    requiredElement("#top").innerHTML = `<span class="del">Missing access token. Reopen the canvas.</span>`;
}
else {
    loadState()
        .catch((err) => {
        requiredElement("#top").innerHTML = `<span class="del">${esc(errorMessage(err))}</span>`;
    })
        .finally(connect);
}
