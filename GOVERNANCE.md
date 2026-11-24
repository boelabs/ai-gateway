# Governance

This document explains who decides what in AI Gateway, how people become collaborators, and how
contributions are accepted. The day-to-day rules for contributors are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Roles

| Role | Who | Can do |
|---|---|---|
| **Maintainer** | Organization owners, repository admins and the maintain role | Everything: accept issues, review and merge pull requests, change settings, publish releases. Merge their own pull requests without a second approval once CI is green. |
| **Collaborator** | People with write access | Push branches, review pull requests, triage issues, manage labels. Pull requests from collaborators skip the `accepted` requirement but still pass CI and the PR template. |
| **Contributor** | Anyone | Open issues and pull requests from forks. Pull requests need an issue labeled `accepted`. |

Repository admins are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS). Every change to the
contribution rules, the templates, the automation or the governance documents needs a maintainer's
review.

## Accepting work

- A maintainer accepts an issue by adding the `accepted` label. Acceptance means the change is
  wanted; it does not promise a merge date.
- Maintainers decide scope. A change that conflicts with the architecture in [AGENTS.md](AGENTS.md)
  or with a published contract is declined, with the reason written in the issue.
- Decisions that change the public API, the wire contracts or the operating model are discussed in
  the issue before anyone writes code.

## Becoming a collaborator

Collaborator access is granted by a maintainer, not requested. We look for:

- several accepted, merged pull requests that were small, focused and passed review;
- useful triage: reproducing bugs, closing duplicates, answering questions accurately;
- agreement with this document, CONTRIBUTING.md and the Code of Conduct.

A maintainer proposes the person to the other maintainers. Access is given with the least privilege
that fits the work (triage before write). Collaborators who stop contributing for a long time may
lose the role; it is returned on request.

## Protecting the project

- `main` is protected by the two rulesets in [`.github/rulesets/`](.github/rulesets/):
  - **Protect main** applies to everyone, with no bypass: changes arrive through pull requests, are
    squash-merged, and merge only when CI is green and review threads are resolved.
  - **Require review on main** asks for one approval from a code owner. Maintainers bypass it, so they
    merge their own pull requests without waiting for another person, and so do agents working
    under a maintainer's account. A contributor's pull request always needs a maintainer's approval.
- Pull requests from people outside the maintainer team are gated on an accepted issue. Maintainers
  may close a pull request that does not follow this, or one with no activity for 30 days.
- Security reports are handled privately through [SECURITY.md](SECURITY.md).
- During a spike of unsolicited activity, maintainers may restrict who can comment or open issues and
  pull requests on the repository. Restrictions are lifted when the spike ends.

## Changing this document

Propose a change in a pull request. Changes to this document need approval from a maintainer.
