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
	styles: [`
    :host {
      display: block;
      padding: var(--pg1-page-margin) var(--pg1-space-gutter);
    }

    main > h1 {
      margin-bottom: var(--pg1-node-gap);
    }

    /* Both "showing durable board data" and "demo fallback" states share
       one clearly-visible mono banner treatment; only one of the two
       renders at a time, so this always targets whichever is shown. */
    main > p:nth-of-type(1) {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      letter-spacing: var(--pg1-label-mono-sm-tracking);
      color: var(--pg1-color-outline);
      text-transform: uppercase;
      margin-bottom: calc(var(--pg1-space-unit) * 2);
    }

    main > p:nth-of-type(2) {
      display: inline-block;
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-size);
      color: var(--pg1-color-ink);
      border: 1px solid var(--pg1-color-outline-variant);
      padding: calc(var(--pg1-space-unit) * 2) var(--pg1-node-gap);
      margin-bottom: var(--pg1-space-gutter);
    }

    section[aria-label='Review board columns'] {
      display: flex;
      align-items: flex-start;
      gap: 0;
      border-top: var(--pg1-border-structural);
    }

    article {
      flex: 1 1 0;
      min-width: 0;
      padding: var(--pg1-container-padding) var(--pg1-space-gutter);
    }

    article:not(:first-child) {
      border-left: var(--pg1-border-structural);
    }

    article h2 {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-size);
      line-height: var(--pg1-label-mono-line);
      font-weight: var(--pg1-label-mono-weight);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--pg1-color-ink);
      padding-bottom: calc(var(--pg1-space-unit) * 2);
      border-bottom: var(--pg1-border-hairline);
      margin-bottom: var(--pg1-node-gap);
    }

    article > p {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      color: var(--pg1-color-outline);
    }

    ul {
      display: flex;
      flex-direction: column;
      gap: var(--pg1-node-gap);
    }

    li {
      position: relative;
      background: var(--pg1-color-surface);
      border: var(--pg1-border-hairline);
      padding: var(--pg1-node-gap);
      padding-top: calc(var(--pg1-node-gap) + var(--pg1-label-mono-sm-line));
    }

    li:hover {
      background: var(--pg1-ink-wash-05);
      border-color: var(--pg1-color-ink);
    }

    /* Priority chip rendered from the existing [data-priority] hook as
       bracket-wrapped monospace text, per the design system — no template
       change required. */
    li[data-priority]::before {
      content: '[' attr(data-priority) ']';
      position: absolute;
      top: var(--pg1-node-gap);
      right: var(--pg1-node-gap);
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      font-weight: var(--pg1-label-mono-weight);
      letter-spacing: var(--pg1-label-mono-sm-tracking);
      text-transform: uppercase;
    }

    li[data-priority='Urgent']::before {
      color: var(--pg1-color-deep-crimson);
    }

    li[data-priority='Normal']::before {
      color: var(--pg1-color-ink);
    }

    li[data-priority='Low']::before {
      color: var(--pg1-color-ink);
      opacity: 0.6;
    }

    li a {
      display: block;
      font-family: var(--pg1-font-serif);
      font-weight: 600;
      color: var(--pg1-color-ink);
      margin-bottom: calc(var(--pg1-space-unit) * 2);
    }

    li a:hover,
    li a:focus-visible {
      color: var(--pg1-color-academic-blue);
    }

    li > p {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      line-height: var(--pg1-label-mono-sm-line);
      letter-spacing: var(--pg1-label-mono-sm-tracking);
      color: var(--pg1-color-outline);
      margin-bottom: calc(var(--pg1-space-unit) * 1);
    }

    li > p:first-of-type {
      font-family: var(--pg1-font-serif);
      font-size: var(--pg1-body-md-size);
      line-height: 1.4;
      letter-spacing: normal;
      color: var(--pg1-color-ink);
      margin-bottom: calc(var(--pg1-space-unit) * 2);
    }

    li p:last-child {
      margin-bottom: 0;
    }

    li [role='alert'] {
      margin-top: calc(var(--pg1-space-unit) * 2);
    }
  `],
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
