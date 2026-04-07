---
name: github-collaboration
description: Full GitHub workflow mastery — PRs, code review, CI/CD, releases, security, search, and team collaboration patterns for enterprise engineering teams
---

## Overview

This skill covers the complete GitHub collaboration lifecycle: from creating branches and PRs through code review, CI integration, release management, and security monitoring. It enables agents to operate as a full GitHub power user across 8 tool domains and 60+ actions.

## When to Use

Activate this skill when:

- Creating, reviewing, or merging pull requests
- Managing issues (triage, label, assign, track progress)
- Performing or responding to code reviews
- Monitoring CI/CD pipelines (GitHub Actions)
- Creating releases and managing versioning
- Searching code, issues, or commits across repos
- Responding to security alerts (Dependabot, CodeQL, secret scanning)
- Understanding repository settings, branch protection, and team permissions

## Available Tools

| Tool          | Actions                                                                               | Permission       |
| ------------- | ------------------------------------------------------------------------------------- | ---------------- |
| `gh_pr`       | create, list, view, merge, close, reopen, diff, checks, comment, ready                | confirm          |
| `gh_issue`    | create, list, view, comment, close, reopen, edit, label, assign, pin, unpin, transfer | confirm          |
| `gh_review`   | list, create, approve, request-changes, comment, view-comments                        | confirm          |
| `gh_actions`  | workflows, runs, view-run, trigger, cancel, rerun, logs, artifacts                    | confirm          |
| `gh_release`  | create, list, view, delete, upload, download                                          | confirm          |
| `gh_search`   | code, issues, commits, repos, prs                                                     | auto (read-only) |
| `gh_security` | dependabot, code-scanning, secret-scanning, sbom                                      | confirm          |
| `gh_repo`     | info, collaborators, branch-protection, topics, labels, milestones, fork, clone-url   | auto (read-only) |

## Core Workflows

### Pull Request Lifecycle

```
1. Create branch → make changes → commit
2. gh_pr create (title, body, reviewers, labels)
3. gh_actions runs (monitor CI status)
4. gh_pr checks (verify all checks pass)
5. gh_review approve / request-changes
6. gh_pr merge (squash/merge/rebase)
```

**Best practices:**

- Always check CI status (`gh_pr checks`) before merging
- Use `draft: true` for work-in-progress PRs
- Request specific reviewers who own the changed code
- Write PR descriptions that explain _why_, not just _what_
- Use `gh_pr diff` to verify the changeset before merging
- Prefer squash merge for feature branches (clean history)

### Code Review Protocol

```
1. gh_pr view (understand the PR: files, additions, deletions)
2. gh_pr diff (read the actual changes)
3. gh_review create with event: COMMENT / APPROVE / REQUEST_CHANGES
4. gh_review comment (inline comments on specific files/lines)
```

**Review quality checklist:**

- Read the full diff before commenting
- Focus on bugs and logic errors, not style (linters handle style)
- Use inline comments with file path + line number for precision
- When requesting changes, explain _what_ to fix and _why_
- Approve with a brief summary of what you verified
- Never approve without reading the diff

### CI/CD Integration

```
1. gh_actions workflows (list available workflows)
2. gh_actions runs (check recent run status)
3. gh_actions view-run (see job details)
4. gh_actions logs (debug failures)
5. gh_actions rerun (retry after transient failure)
6. gh_actions trigger (manually dispatch workflow)
```

**Patterns:**

- Before merging: always verify CI passes via `gh_pr checks`
- Failed CI: use `gh_actions logs` to get failure details, then fix
- Manual workflows: use `trigger` with `workflow_dispatch` inputs
- Cache issues: check `gh_actions artifacts` for build artifacts

### Issue Management

```
1. gh_issue create (title, body, labels, assignees, milestone)
2. gh_issue list (filter by state, label, assignee)
3. gh_issue comment (updates, findings, decisions)
4. gh_issue close (with reason: completed or not_planned)
```

**Triage workflow:**

- New issues: add labels (bug, feature, documentation, etc.)
- Assign to owner based on code area
- Link to milestone for release tracking
- Cross-reference related issues and PRs in comments

### Release Management

```
1. Verify CI passes on release branch
2. gh_release create (tag, title, generate-notes)
3. gh_release upload (attach build artifacts)
4. gh_issue close (close issues resolved in this release)
```

**Versioning:**

- Follow semver: MAJOR.MINOR.PATCH
- Use `--generate-notes` for automatic changelog from commits
- Tag format: `v1.2.3`
- Prerelease for beta/rc: `v1.2.3-beta.1`

### Security Monitoring

```
1. gh_security dependabot (check for vulnerable dependencies)
2. gh_security code-scanning (check for code vulnerabilities)
3. gh_security secret-scanning (check for exposed secrets)
4. gh_security sbom (export dependency list for compliance)
```

**Response protocol:**

- Critical/high Dependabot alerts: create PR to update dependency
- Secret scanning alerts: rotate the credential immediately
- CodeQL alerts: review and fix or dismiss with justification
- SBOM: export for compliance audits

### Cross-Repo Search

```
1. gh_search code (find implementations, patterns, usage)
2. gh_search issues (find related bugs, prior discussions)
3. gh_search commits (find when something changed)
4. gh_search repos (discover relevant projects)
```

**Search syntax tips:**

- `repo:owner/repo` limits to specific repo
- `language:typescript` filters by language
- `path:src/` limits to specific directory
- `filename:*.test.ts` finds test files
- `"exact phrase"` for exact matches

## Enterprise Patterns

### Branch Protection Awareness

Before attempting operations, check branch protection:

```
gh_repo branch-protection (branch: "main")
```

This reveals:

- Required status checks (which CI must pass)
- Required reviewers (how many approvals needed)
- Dismiss stale reviews (re-review after push)
- Restrictions (who can push)

**Never attempt to merge a PR that violates branch protection rules.**

### Team Collaboration

```
gh_repo collaborators (see who has access)
gh_repo info (repo metadata, default branch)
gh_repo labels (organizational labels)
gh_repo milestones (release planning)
```

### Multi-Repo Workflows

For monorepos or multi-service architectures:

1. Use `gh_search code` to find dependencies across repos
2. Create linked issues across repos for coordinated changes
3. Reference cross-repo PRs in comments using `owner/repo#123` format

## Red Flags

- Merging without CI checks passing
- Approving PRs without reading the diff
- Creating releases without a changelog
- Dismissing security alerts without investigation
- Force-pushing to protected branches
- Creating PRs with bodies that don't explain the _why_
- Assigning issues without context for the assignee

## Verification

Before completing any GitHub workflow:

- [ ] CI status checked and passing
- [ ] PR description explains motivation, not just changes
- [ ] Reviewers appropriate for the code area
- [ ] Labels applied for categorization
- [ ] Related issues linked or referenced
- [ ] Security alerts reviewed (no new critical/high)
- [ ] Branch protection rules respected
