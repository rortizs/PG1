# Delta for LLM Provider Admin

## REMOVED Requirements

### Requirement: Admin Shared-Secret Access Gate (Temporary MVP)

(Reason: superseded by the `reviewer-authentication` capability's
session-based route protection on `/api/v1/admin/*`. `ADMIN_SHARED_SECRET`,
`AdminSecretGuard`, and `checkAdminSecretHeader` are retired.)
(Migration: `401 unauthorized` on a missing/invalid credential is preserved
by the new session gate. The `403 forbidden` this requirement returned for
a present-but-wrong shared secret has no replacement — no distinct admin
role exists, and any authenticated reviewer now has the access this gate
protected.)
