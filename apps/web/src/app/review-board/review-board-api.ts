import type { ReviewBoardInputCard, ReviewPriority } from "./review-board-view";

export const REVIEW_BOARD_CARDS_API_PATH = "/api/v1/review-board/cards";

export interface ReviewBoardApiCard {
	readonly id: string;
	readonly student_name: string;
	readonly thesis_title: string;
	readonly priority: string;
	readonly board_state: string;
	readonly review_run_status: string | null;
	readonly reviewer_label?: string | null;
	readonly report_ready?: boolean;
	readonly current_review_run_id?: string | null;
	readonly attention_text?: string | null;
}

export interface ReviewBoardCardsApiResponse {
	readonly items: readonly ReviewBoardApiCard[];
}

export type ReviewBoardDisplaySource = "api" | "demo_fallback";

export interface ReviewBoardDisplaySelection {
	readonly source: ReviewBoardDisplaySource;
	readonly cards: readonly ReviewBoardInputCard[];
}

export function mapReviewBoardApiItemsToCards(
	items: readonly ReviewBoardApiCard[],
): ReviewBoardInputCard[] {
	return items.map((item) => ({
		id: item.id,
		studentName: item.student_name,
		thesisTitle: item.thesis_title,
		priority: normalizeReviewBoardPriority(item.priority),
		status: item.review_run_status,
		approvalState:
			item.board_state === "approved" ? "approved" : "not_approved",
		reviewerName: item.reviewer_label ?? null,
		reportReady: item.report_ready ?? false,
		...(item.current_review_run_id
			? { currentReviewRunId: item.current_review_run_id }
			: {}),
		...(item.attention_text ? { attentionText: item.attention_text } : {}),
	}));
}

export function selectReviewBoardDisplayCards({
	apiCards,
	demoFallbackCards,
}: {
	readonly apiCards: readonly ReviewBoardInputCard[] | null;
	readonly demoFallbackCards: readonly ReviewBoardInputCard[];
}): ReviewBoardDisplaySelection {
	return apiCards
		? { source: "api", cards: apiCards }
		: { source: "demo_fallback", cards: demoFallbackCards };
}

function normalizeReviewBoardPriority(priority: string): ReviewPriority {
	switch (priority.toLowerCase()) {
		case "low":
			return "Low";
		case "urgent":
			return "Urgent";
		default:
			return "Normal";
	}
}
