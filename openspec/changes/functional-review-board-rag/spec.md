# Specification: Functional Review Board and Report Workflow

## status

success — generated after dedicated `sdd-spec` provider failed with a network error.

## scope

This specification covers the first functional reviewer workflow slice for PG1:

- Kanban-style review board.
- Student review detail/upload screen.
- PDF/DOCX validation with a 20 MB maximum.
- Analysis stage/percentage projection.
- Markdown report summary and download.
- Truthful labeling of current CAG behavior versus future RAG/vector retrieval.

Real pgvector-backed RAG retrieval is specified as a future slice, not part of the first implementation slice.

## actors

- **Reviewer**: uploads a thesis, monitors automated analysis, downloads the Markdown report, and makes the final approval decision.
- **Coordinator**: monitors pending, urgent, reviewed, and approved submissions.
- **System**: extracts text, runs deterministic rules, runs CAG review, and generates Markdown report artifacts.

## domain states

### Board states

- `Pending`: student/submission is waiting for thesis upload or review start.
- `In Review`: upload/review is running or queued.
- `Reviewed`: automated analysis completed and report is available.
- `Approved`: human reviewer approved the thesis review as complete.

### Priority values

- `Low`
- `Normal`
- `Urgent`

### Analysis stages

- `Uploading`
- `Extracting text`
- `Running rules`
- `Generating report`
- `Completed`
- `Failed`

## functional requirements

### FR-1: Review board

The system shall provide a review board that groups thesis submissions into `Pending`, `In Review`, `Reviewed`, and `Approved`.

Acceptance criteria:

- Given the reviewer opens the board, when submissions exist, then each card appears in exactly one board column.
- Given a run is `queued`, `extracting`, `segmenting`, `validating`, `rag_reviewing`, or `reporting`, when mapped to board state, then it appears as `In Review`.
- Given a run is `completed`, when mapped to board state, then it appears as `Reviewed` unless a human approval state says `Approved`.
- Given a run is `failed` or `cancelled`, when mapped to board state, then it is visibly marked as failed/cancelled and must not be silently hidden.

### FR-2: Priority display

The board shall show each card priority as `Low`, `Normal`, or `Urgent`.

Acceptance criteria:

- Given a card has `Urgent` priority, when rendered, then the priority is visually distinct using a restrained red/terracotta accent.
- Given a card has `Normal` priority, when rendered, then it uses a neutral accent.
- Given a card has `Low` priority, when rendered, then it uses a muted low-attention accent.

### FR-3: Student detail upload

The system shall provide a student detail screen that accepts one thesis file via click or drag/drop.

Acceptance criteria:

- Given the reviewer opens a pending student, when the detail page loads, then it shows student identity, thesis title, current board state, priority, and reviewer assignment when available.
- Given the reviewer selects one `.pdf` or `.docx` under 20 MB, when they submit it, then upload is allowed.
- Given the reviewer selects an unsupported file type, when validation runs, then upload is blocked before API submission.
- Given the reviewer selects a file larger than 20 MB, when validation runs, then upload is blocked before API submission with a clear message.

### FR-4: Automatic transition to In Review

The system shall show a submission as `In Review` once a valid upload/review run starts.

Acceptance criteria:

- Given a pending student has a valid file accepted, when upload/review starts, then the UI shows the student as `In Review`.
- Given upload fails before a review run is created, then the student must remain `Pending` and show the error.

### FR-5: Analysis progress

The detail screen shall show an analysis stage and percentage while review is active.

Acceptance criteria:

- Given a review run status is known, when the detail screen renders, then it maps the lifecycle status to a user-facing stage label.
- Given only lifecycle status is available, when percentage is shown, then it must be a deterministic projection and not claim real-time worker progress.
- Given the run fails, then the progress area shows failure state and next action.

### FR-6: Markdown report access

The detail screen shall show a global summary and Markdown report download action when a report artifact is available.

Acceptance criteria:

- Given report artifacts API returns a Markdown artifact, when the detail page renders, then it shows `Download Markdown Report`.
- Given the reviewer downloads the report, then the downloaded file uses the artifact filename and `.md` content.
- Given no artifact is available yet, then the UI does not show a false-ready download state.

### FR-7: Approval remains human-controlled

The system shall not automatically move a thesis review to `Approved`.

Acceptance criteria:

- Given automated analysis completes, when the board updates, then the card moves to `Reviewed`, not `Approved`.
- Given a reviewer approves the thesis review, when approval is saved, then the card moves to `Approved`.

### FR-8: CAG/RAG truthfulness

The system shall distinguish current CAG behavior from future real vector RAG.

Acceptance criteria:

- Given vector retrieval is not implemented/configured, when the UI/report describes the analysis method, then it must not claim vector RAG was used.
- Given future vector retrieval is implemented, when retrieved sources are used, then report output must include traceable source references.

## non_functional_requirements

- UI must remain minimal, academic, and accessible.
- All new interactive controls must be keyboard reachable and have clear labels.
- Validation must happen client-side and server-side for file type and size.
- The first implementation slice should stay reviewable under the 400-line budget where practical.
- Generated reports remain Markdown-first.

## out_of_scope_for_first_slice

- PDF export.
- Real embeddings/vector retrieval.
- Full async queue infrastructure.
- Automatic approval.
- OneDrive integration.
- Heavy admin dashboard analytics.

## skill_resolution

paths-injected
