export type ReviewProgressState =
	| "active"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export interface ReviewProgressView {
	readonly status: string;
	readonly stage: string;
	readonly percent: number;
	readonly state: ReviewProgressState;
	readonly isProjected: true;
	readonly nextAction: string | null;
}

type ProgressTemplate = Omit<ReviewProgressView, "status">;

const retryUpload = "Review the error and upload the thesis again when ready.";
const startNewRun = "Start a new review run when the thesis is ready.";
const refreshStatus = "Refresh the review run before making a decision.";

const active = (stage: string, percent: number): ProgressTemplate => ({
	stage,
	percent,
	state: "active",
	isProjected: true,
	nextAction: null,
});

const PROGRESS_BY_STATUS: Record<string, ProgressTemplate> = {
	queued: active("Uploading", 10),
	extracting: active("Extracting text", 30),
	segmenting: active("Extracting text", 45),
	validating: active("Running rules", 60),
	rag_reviewing: active("Running review", 75),
	reporting: active("Generating report", 90),
	completed: {
		stage: "Completed",
		percent: 100,
		state: "completed",
		isProjected: true,
		nextAction: null,
	},
	failed: {
		stage: "Failed",
		percent: 100,
		state: "failed",
		isProjected: true,
		nextAction: retryUpload,
	},
	cancelled: {
		stage: "Cancelled",
		percent: 100,
		state: "cancelled",
		isProjected: true,
		nextAction: startNewRun,
	},
};

const UNKNOWN_PROGRESS: ProgressTemplate = {
	stage: "Review status unavailable",
	percent: 0,
	state: "unknown",
	isProjected: true,
	nextAction: refreshStatus,
};

export function buildReviewProgressView(status: string): ReviewProgressView {
	return { status, ...(PROGRESS_BY_STATUS[status] ?? UNKNOWN_PROGRESS) };
}
