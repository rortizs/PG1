export type BoardState = "Pending" | "In Review" | "Reviewed" | "Approved";
export type ReviewPriority = "Low" | "Normal" | "Urgent";
export type ApprovalState = "approved" | "not_approved" | null | undefined;
export type BoardAttention = "failed" | "cancelled" | null;

export interface ReviewBoardInputCard {
	readonly id: string;
	readonly studentName: string;
	readonly thesisTitle: string;
	readonly priority: ReviewPriority;
	readonly status: string | null;
	readonly approvalState?: ApprovalState;
	readonly reviewerName?: string | null;
	readonly reportReady?: boolean;
	readonly currentReviewRunId?: string | null;
	readonly attentionText?: string | null;
}

export interface ReviewBoardCard extends ReviewBoardInputCard {
	readonly boardState: BoardState;
	readonly attention: BoardAttention;
}

export interface ReviewBoardColumn {
	readonly state: BoardState;
	readonly cards: ReviewBoardCard[];
}

export const BOARD_STATES: readonly BoardState[] = [
	"Pending",
	"In Review",
	"Reviewed",
	"Approved",
];

const IN_REVIEW_STATUSES = new Set([
	"queued",
	"extracting",
	"segmenting",
	"validating",
	"rag_reviewing",
	"reporting",
	"failed",
	"cancelled",
]);
const PRIORITY_WEIGHT: Record<ReviewPriority, number> = {
	Urgent: 0,
	Normal: 1,
	Low: 2,
};

export function mapReviewRunToBoardState({
	status,
	approvalState,
}: {
	readonly status: string | null;
	readonly approvalState?: ApprovalState;
}): BoardState {
	if (approvalState === "approved") return "Approved";
	if (!status) return "Pending";
	if (status === "completed") return "Reviewed";
	return IN_REVIEW_STATUSES.has(status) ? "In Review" : "Pending";
}

export function buildReviewBoardColumns(
	cards: readonly ReviewBoardInputCard[],
): ReviewBoardColumn[] {
	const columns = BOARD_STATES.map((state) => ({
		state,
		cards: [] as ReviewBoardCard[],
	}));
	const columnByState = new Map(
		columns.map((column) => [column.state, column.cards]),
	);

	for (const card of cards) {
		const boardState = mapReviewRunToBoardState(card);
		const attention =
			card.status === "failed" || card.status === "cancelled"
				? card.status
				: null;
		columnByState.get(boardState)?.push({ ...card, boardState, attention });
	}

	for (const column of columns) column.cards.sort(compareCardsForBoard);
	return columns;
}

function compareCardsForBoard(
	left: ReviewBoardCard,
	right: ReviewBoardCard,
): number {
	return (
		PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority] ||
		left.studentName.localeCompare(right.studentName)
	);
}
