## Summary

<!-- What changes and why. Two to five sentences. -->

## Linked issue

<!--
Required. Write `Closes #<number>` for the issue this pull request implements.
Contributors need an issue labeled `accepted` (see CONTRIBUTING.md). Maintainers may write `N/A` with a reason.
-->

Closes #

## Type

<!-- Tick one. -->

- [ ] Bug fix
- [ ] Feature
- [ ] Provider adapter or model
- [ ] Refactor
- [ ] Docs
- [ ] Breaking change to a public contract

## Checklist

<!-- Tick only what is true. Delete a line only if it does not apply to this change. -->

- [ ] `bun run check`, `bun run typecheck`, and `bun run test` pass locally
- [ ] Integration tests run if database, router, rate limiting, or admin endpoints changed (`bun run --filter @boelabs/ai-gateway-api test:integration`)
- [ ] Tests added or updated for the change
- [ ] `apps/api/openapi.yaml` regenerated if an OpenAPI Zod schema changed (`openapi:generate`)
- [ ] New migration added instead of editing an applied one; works with the previous release (N−1)
- [ ] Docs updated in English and Spanish if behavior or the public contract changed
- [ ] `packages/ai-sdk-provider` updated if the public wire contract changed
- [ ] English only, no unrelated formatter churn, no secrets or production connection strings

## Notes for reviewers

<!-- Trade-offs, risks, follow-ups. Delete this section if there are none. -->
