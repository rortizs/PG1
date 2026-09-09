# Pull request checklist

## Linked issue

Closes #000

> Replace `#000` with the approved issue number before merge. If this repository has no issue workflow yet, document the maintainer-approved exception in **Policy exception**.

## PR type

Select exactly one and add the matching `type:*` label to the PR.

- [ ] Bug fix (`type:bug`)
- [ ] New feature (`type:feature`)
- [ ] Documentation only (`type:docs`)
- [ ] Code refactoring (`type:refactor`)
- [ ] Maintenance/tooling (`type:chore`)
- [ ] Breaking change (`type:breaking-change`)

## Summary

-
-
-

## Changes

| Area | Change |
| ---- | ------ |
|      |        |

## Review path

1.
2.
3.

## Chain context

Complete this section for chained or stacked PRs. Delete it for small standalone PRs.

- Previous PR:
- Next PR:
- Current slice:
- Review budget: `<additions + deletions>` changed lines

```text
main -> previous -> 📍 current -> next
```

## Test plan

- [ ] Unit tests: `<command>`
- [ ] Integration tests: `<command or N/A>`
- [ ] UI/e2e tests: `<command or N/A>`
- [ ] Lint/typecheck/format: `<command or N/A>`
- [ ] Manual verification: `<steps or N/A>`

## Policy exception

Use only when the repository cannot satisfy a checklist item yet, and name the maintainer approval.

- Exception: N/A
- Approved by: N/A
- Reason: N/A

## Contributor checklist

- [ ] Linked an approved issue or documented a maintainer-approved policy exception.
- [ ] Added exactly one `type:*` label, or documented why repository labels are unavailable.
- [ ] Kept the PR focused and reviewable.
- [ ] Included tests/docs with the behavior they verify.
- [ ] Ran the verification commands listed above and recorded exact results.
- [ ] Used Conventional Commit messages.
- [ ] Confirmed there are no `Co-Authored-By` trailers.
