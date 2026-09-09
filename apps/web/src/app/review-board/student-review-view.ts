import type { ReviewRunResponse } from "../thesis-api-client";
import {
	type ReportArtifact,
	selectMarkdownReportArtifact,
} from "../results/report-download-view";
import {
	normalizeReviewBoardPriority,
	type ReviewBoardApiCard,
} from "./review-board-api";
import type { ReviewPriority } from "./review-board-view";

/**
 * Pure, framework-free view-model logic for the student review detail page —
 * mirrors `results-view.ts`'s pattern: the decision of "what to render" is a
 * plain function, directly unit-testable with `node:test` without an Angular
 * TestBed/jsdom harness. `student-review-page.ts` consumes this to decide
 * both its template branch and the fields it displays.
 */
export type StudentReviewViewModel =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "not_found"; studentId: string }
	| {
			kind: "found";
			studentName: string;
			thesisTitle: string;
			boardState: string;
			priority: ReviewPriority;
			reviewerName: string;
			status: string | null;
			reportArtifact: ReportArtifact | null;
	  };

export function buildStudentReviewViewModel({
	studentId,
	cards,
	loadError,
	run,
	reportArtifacts,
}: {
	readonly studentId: string;
	readonly cards: readonly ReviewBoardApiCard[] | null;
	readonly loadError: string | null;
	readonly run: ReviewRunResponse | null;
	readonly reportArtifacts: readonly ReportArtifact[] | null;
}): StudentReviewViewModel {
	if (loadError) return { kind: "error", message: loadError };
	if (cards === null) return { kind: "loading" };

	const card = cards.find((item) => item.id === studentId) ?? null;
	if (!card) return { kind: "not_found", studentId };

	return {
		kind: "found",
		studentName: card.student_name,
		thesisTitle: card.thesis_title,
		boardState: card.board_state,
		priority: normalizeReviewBoardPriority(card.priority),
		reviewerName: card.reviewer_label ?? "Unassigned",
		status: run?.status ?? card.review_run_status,
		reportArtifact: selectMarkdownReportArtifact(reportArtifacts ?? []),
	};
}
