# Delta for Vertical Slice CAG Review

## MODIFIED Requirements

### Requirement: UI-Driven Thesis Upload

The system MUST let an authenticated reviewer select and submit exactly one
PDF or DOCX file from the Angular app, and the API MUST persist the
accepted upload as a real row in `thesis_document` (not in-memory), reusing
the existing validation contract. The persisted row's
`uploaded_by_user_id` MUST be the authenticated session's reviewer id,
never the placeholder `0`.
(Previously: upload required no session, and `uploaded_by_user_id` was
hardcoded to `0`.)

#### Scenario: Valid PDF upload succeeds end to end

- GIVEN the Angular upload page is open, Postgres is reachable, and the reviewer has a valid session
- WHEN the user selects one valid PDF and submits
- THEN the API returns `201` with `upload_status: "uploaded"`
- AND a row exists in `thesis_document` with matching `sha256`, `content_type`, `storage_key`

#### Scenario: Unsupported file type is rejected

- GIVEN the upload page is open
- WHEN the user submits a file whose content type is not PDF or DOCX
- THEN the API returns `415 unsupported_media_type` with `review_run_created: false`
- AND no `thesis_document` row is created

#### Scenario: Zero or multiple files are rejected

- GIVEN the upload page is open
- WHEN the user submits zero files or more than one file in a single request
- THEN the API returns `422 validation_error` naming the `files` field
- AND no `thesis_document` row is created

#### Scenario: Upload without a session is rejected

- GIVEN no valid session token is presented
- WHEN a client submits an upload request
- THEN the API returns `401 unauthorized`
- AND no `thesis_document` row is created

#### Scenario: Upload records the real authenticated reviewer, never the placeholder

- GIVEN a reviewer with session identity `reviewer_id: 7` uploads a thesis
- WHEN the upload is persisted
- THEN the `thesis_document.uploaded_by_user_id` column equals `7`
- AND it is never the hardcoded value `0`
