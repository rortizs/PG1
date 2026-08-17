import {
	ChangeDetectionStrategy,
	Component,
	type OnInit,
	computed,
	signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import {
	REVIEW_BOARD_CARDS_API_PATH,
	mapReviewBoardApiItemsToCards,
	selectReviewBoardDisplayCards,
	type ReviewBoardCardsApiResponse,
} from "./review-board-api";
import {
	type ReviewBoardInputCard,
	buildReviewBoardColumns,
} from "./review-board-view";
import { buildReviewProgressView } from "./review-progress-view";

export const DEMO_FALLBACK_REVIEW_BOARD_CARDS: readonly ReviewBoardInputCard[] =
	[
		{
			id: "ana-martinez",
			studentName: "Ana Martínez",
			thesisTitle: "Inclusive assessment practices in first-year programming",
			priority: "Urgent",
			status: "rag_reviewing",
			reviewerName: "Dr. Rivera",
			reportReady: false,
		},
		{
			id: "leo-santos",
			studentName: "Leo Santos",
			thesisTitle: "Rubric calibration for capstone projects",
			priority: "Normal",
			status: null,
			reviewerName: "Unassigned",
			reportReady: false,
		},
		{
			id: "mila-perez",
			studentName: "Mila Pérez",
			thesisTitle: "Feedback cycles in academic writing studios",
			priority: "Low",
			status: "completed",
			approvalState: "not_approved",
			reviewerName: "Prof. Chen",
			reportReady: true,
		},
		{
			id: "nora-ibarra",
			studentName: "Nora Ibarra",
			thesisTitle: "Peer review traceability in research seminars",
			priority: "Normal",
			status: "completed",
			approvalState: "approved",
			reviewerName: "Dr. Gómez",
			reportReady: true,
		},
	];

/**
 * Review board shell that prefers durable API cards and falls back to a clearly
 * named demo projection only when the API is unavailable.
 */
@Component({
	selector: "app-review-board-page",
	imports: [RouterLink],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
    <main aria-labelledby="review-board-title">
      <h1 id="review-board-title">Thesis review board</h1>
      <p>Method shown: Rules + CAG review, grounded with RAG-retrieved normative context.</p>
      @if (displayCards().source === 'api') {
        <p>Showing durable board data from {{ apiPath }}.</p>
      } @else {
        <p>Demo fallback board data is shown because API board data is unavailable.</p>
      }

      <section aria-label="Review board columns">
        @for (column of columns(); track column.state) {
          <article>
            <h2>{{ column.state }} ({{ column.cards.length }})</h2>
            @if (column.cards.length === 0) {
              <p>No submissions.</p>
            }
            <ul>
              @for (card of column.cards; track card.id) {
                <li [attr.data-priority]="card.priority">
                  <a [routerLink]="['/students', card.id, 'review']">
                    {{ card.studentName }}
                  </a>
                  <p>{{ card.thesisTitle }}</p>
                  <p>Priority: {{ card.priority }}</p>
                  <p>Reviewer: {{ card.reviewerName || 'Unassigned' }}</p>
                  <p>Stage: {{ stageFor(card.status) }}</p>
                  @if (card.attentionText || card.attention) {
                    <p role="alert">Needs attention: {{ card.attentionText || card.attention }}</p>
                  }
                  @if (card.reportReady) {
                    <p>Markdown report available.</p>
                  }
                </li>
              }
            </ul>
          </article>
        }
      </section>
    </main>
  `,
})
export class ReviewBoardPage implements OnInit {
	protected readonly apiPath = REVIEW_BOARD_CARDS_API_PATH;
	private readonly apiCards = signal<readonly ReviewBoardInputCard[] | null>(
		null,
	);
	protected readonly displayCards = computed(() =>
		selectReviewBoardDisplayCards({
			apiCards: this.apiCards(),
			demoFallbackCards: DEMO_FALLBACK_REVIEW_BOARD_CARDS,
		}),
	);
	protected readonly columns = computed(() =>
		buildReviewBoardColumns(this.displayCards().cards),
	);

	ngOnInit(): void {
		void this.loadApiCards();
	}

	protected stageFor(status: string | null): string {
		return status ? buildReviewProgressView(status).stage : "Awaiting upload";
	}

	private async loadApiCards(): Promise<void> {
		try {
			const response = await fetch(REVIEW_BOARD_CARDS_API_PATH);
			if (!response.ok) return;

			const payload = (await response.json()) as ReviewBoardCardsApiResponse;
			this.apiCards.set(mapReviewBoardApiItemsToCards(payload.items ?? []));
		} catch {
			this.apiCards.set(null);
		}
	}
}
