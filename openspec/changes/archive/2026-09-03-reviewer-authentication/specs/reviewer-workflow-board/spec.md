# Delta for Reviewer Workflow Board

## MODIFIED Requirements

### Requirement: Priority and Approval Workflow State

The system MUST persist reviewer workflow metadata separately from
automated analysis status: priority can be `low`, `normal`, or `urgent`,
and approval can only be set by an explicit reviewer action. The recorded
`reviewer_name` for an approval MUST be derived from the authenticated
session, and the system MUST ignore any `reviewerName`/`reviewer_name`
value submitted in the request body.
(Previously: approval accepted a client-submitted `reviewer_name` as
unverified free text.)

#### Scenario: Priority is updated without changing analysis status

- GIVEN a board card exists
- WHEN a reviewer changes priority to `urgent`
- THEN the card priority becomes `urgent`
- AND the underlying review-run lifecycle status is unchanged

#### Scenario: Approval is human-controlled

- GIVEN a review run has completed
- WHEN a reviewer approves the item
- THEN the board state becomes `approved`
- AND the transition is recorded as reviewer workflow metadata, not as automated analysis output

#### Scenario: Approval identity comes from the session, not the request body

- GIVEN an authenticated reviewer session belonging to "Dr. Ana Ruiz"
- WHEN `POST /api/v1/review-board/cards/{id}/approval` is called with `reviewerName: "Someone Else"` in the body
- THEN the persisted `reviewer_name` is "Dr. Ana Ruiz"
- AND the submitted body value is discarded, never written
