# Brainstorm SDLC Matrix — Hallucination-Proof Software Development

> The complete mapping of software development from cradle to grave.
> 14 phases. 12 virtual roles. Every work product validated. Zero tolerance for fabricated data.

---

## The Prime Directive

**Hallucinations must be impossible.**

A PRD based on hallucinated data is worse than no PRD. An architecture document referencing non-existent APIs is worse than no architecture document. Every claim made by every agent must be verifiable against ground truth — the actual codebase, the actual data, the actual infrastructure.

This document defines the complete framework for AI-powered software development where every critical artifact passes through forensic verification, multi-agent consensus, and evidence chain tracking before it can influence decisions.

---

## Table of Contents

1. [The 14 SDLC Phases](#the-14-sdlc-phases)
2. [The 12 Virtual Roles](#the-12-virtual-roles)
3. [The Master Matrix (Phase × Role × Work Product)](#the-master-matrix)
4. [Anti-Hallucination Framework (5 Layers)](#anti-hallucination-framework)
5. [Work Product Schemas](#work-product-schemas)
6. [Validation Gates](#validation-gates)
7. [Evidence Chain Protocol](#evidence-chain-protocol)
8. [Forensic Verification Protocol](#forensic-verification-protocol)
9. [Multi-Agent Consensus Protocol](#multi-agent-consensus-protocol)
10. [Failure Mode Catalog](#failure-mode-catalog)
11. [Integration with Brainstorm Ecosystem](#integration-with-brainstorm-ecosystem)
12. [Industry Framework Alignment](#industry-framework-alignment)

---

## The 14 SDLC Phases

### Phase 1: Discovery & Research

**Purpose:** Understand the problem space before building anything.
**Entry Criteria:** New project, new feature request, or strategic initiative.
**Exit Criteria:** Problem validated, market understood, feasibility confirmed.

| Attribute              | Detail                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Duration**           | 1–4 weeks                                                                                                                                  |
| **Lead Role**          | Product Strategist                                                                                                                         |
| **Supporting Roles**   | Data Analyst, Product Manager                                                                                                              |
| **Key Activities**     | Stakeholder interviews, user research, competitive analysis, market sizing, feasibility studies, technology survey                         |
| **Work Products**      | Discovery report, competitive analysis, user research synthesis, market size estimate, feasibility assessment                              |
| **Anti-Hallucination** | All market data must cite sources (URLs, reports, databases). All competitive claims must reference real products. No invented statistics. |
| **Validation Gate**    | Forensic verification of all external claims                                                                                               |

### Phase 2: Requirements & PRD

**Purpose:** Define what to build, for whom, and why.
**Entry Criteria:** Discovery complete, problem validated.
**Exit Criteria:** PRD approved by stakeholders, acceptance criteria defined.

| Attribute              | Detail                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–3 weeks                                                                                                                                                                       |
| **Lead Role**          | Product Manager                                                                                                                                                                 |
| **Supporting Roles**   | Architect (feasibility), QA Engineer (testability)                                                                                                                              |
| **Key Activities**     | User story creation, acceptance criteria definition (BDD: Given/When/Then), scope negotiation, priority ranking, dependency mapping                                             |
| **Work Products**      | PRD document, user stories, acceptance criteria, requirements traceability matrix, story map                                                                                    |
| **Anti-Hallucination** | Every referenced codebase entity must exist (forensic verification). No invented API endpoints. No assumed database schemas. If referencing existing code, must cite file:line. |
| **Validation Gate**    | Forensic verification + human approval                                                                                                                                          |

### Phase 3: Architecture & System Design

**Purpose:** Design the system before writing code.
**Entry Criteria:** PRD approved, requirements clear.
**Exit Criteria:** Architecture approved, interfaces defined, ADRs recorded.

| Attribute              | Detail                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–2 weeks                                                                                                                                                                                                  |
| **Lead Role**          | Software Architect                                                                                                                                                                                         |
| **Supporting Roles**   | Tech Lead, Security Engineer                                                                                                                                                                               |
| **Key Activities**     | Component design, data flow modeling, API contract definition, technology selection, security threat modeling, scalability analysis, ADR creation                                                          |
| **Work Products**      | Architecture Decision Records (ADRs), component diagrams (Mermaid), API contracts, data models, sequence diagrams, threat model                                                                            |
| **Anti-Hallucination** | All referenced components must exist in the codebase or be explicitly marked as "TO CREATE". API contracts must not reference non-existent endpoints. Dependencies must be real packages at real versions. |
| **Validation Gate**    | Forensic verification + human approval                                                                                                                                                                     |

### Phase 4: Sprint Planning

**Purpose:** Break work into executable tasks with estimates and dependencies.
**Entry Criteria:** Architecture approved, implementation approach clear.
**Exit Criteria:** Sprint backlog defined, tasks estimated, dependencies mapped.

| Attribute              | Detail                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–2 days                                                                                                                     |
| **Lead Role**          | Tech Lead                                                                                                                    |
| **Supporting Roles**   | Senior Developer, Product Manager                                                                                            |
| **Key Activities**     | Task decomposition, effort estimation, dependency identification, risk assessment, sprint goal definition, capacity planning |
| **Work Products**      | Sprint backlog, task cards with estimates, dependency graph, risk register, sprint goal statement                            |
| **Anti-Hallucination** | Estimates must reference historical data or complexity metrics. Dependencies must reference real packages/services.          |
| **Validation Gate**    | Auto (confidence check)                                                                                                      |

### Phase 5: Implementation

**Purpose:** Write the code.
**Entry Criteria:** Sprint planned, tasks assigned, architecture clear.
**Exit Criteria:** Code compiles, tests pass, follows patterns.

| Attribute              | Detail                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–4 weeks (per sprint)                                                                                                 |
| **Lead Role**          | Senior Developer / Developer                                                                                           |
| **Supporting Roles**   | Architect (guidance), QA (test patterns)                                                                               |
| **Key Activities**     | Feature development, bug fixing, refactoring, unit test writing, code documentation                                    |
| **Work Products**      | Source code, unit tests, inline documentation, git commits                                                             |
| **Anti-Hallucination** | Read-before-write enforced. Build must pass after every edit. Self-review on every file write. No blind file creation. |
| **Validation Gate**    | Build verification (automatic)                                                                                         |

### Phase 6: Code Review

**Purpose:** Catch bugs, enforce standards, share knowledge.
**Entry Criteria:** Implementation complete, build passing.
**Exit Criteria:** All critical findings resolved, reviewers approve.

| Attribute              | Detail                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–3 days                                                                                                                      |
| **Lead Role**          | Code Reviewer (peer)                                                                                                          |
| **Supporting Roles**   | Security Engineer, QA Engineer                                                                                                |
| **Key Activities**     | Correctness review, security review, style review, performance review, architectural conformance check                        |
| **Work Products**      | Review findings (critical/high/medium/low), approval/rejection, suggestions                                                   |
| **Anti-Hallucination** | Reviewers must cite specific file:line for every finding. No generic comments. Parallel 3-agent review with consensus voting. |
| **Validation Gate**    | Multi-agent consensus (2-of-3 must approve)                                                                                   |

### Phase 7: Testing

**Purpose:** Verify the software works correctly across all dimensions.
**Entry Criteria:** Code review approved, implementation stable.
**Exit Criteria:** Test suite passes, coverage meets thresholds.

| Attribute              | Detail                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Duration**           | 1–2 weeks                                                                                                                                                                            |
| **Lead Role**          | QA Engineer                                                                                                                                                                          |
| **Supporting Roles**   | Developer (fixes), Security Engineer (security tests)                                                                                                                                |
| **Key Activities**     | Unit testing, integration testing, E2E testing, security testing (SAST/DAST), performance testing, accessibility testing, regression testing                                         |
| **Work Products**      | Test plan, test cases, test execution reports, coverage reports, performance benchmarks, security scan results                                                                       |
| **Anti-Hallucination** | Test results must be from actual test execution (not fabricated pass/fail). Coverage numbers must come from real coverage tools. Performance numbers must come from real benchmarks. |
| **Validation Gate**    | Build verification + forensic verification of test results                                                                                                                           |

### Phase 8: CI/CD Pipeline

**Purpose:** Automate build, test, and deployment processes.
**Entry Criteria:** Tests pass locally, pipeline configured.
**Exit Criteria:** Pipeline green, artifacts generated, quality gates pass.

| Attribute              | Detail                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Duration**           | Continuous                                                                                                 |
| **Lead Role**          | DevOps/SRE                                                                                                 |
| **Supporting Roles**   | Developer (pipeline fixes)                                                                                 |
| **Key Activities**     | Build automation, test automation, quality gate configuration, artifact versioning, environment management |
| **Work Products**      | CI/CD configuration files, build logs, quality gate reports, release artifacts                             |
| **Anti-Hallucination** | Pipeline results must come from actual pipeline execution. No fabricated build statuses.                   |
| **Validation Gate**    | Auto (pipeline pass/fail)                                                                                  |

### Phase 9: Staging & QA

**Purpose:** Validate in a production-like environment before release.
**Entry Criteria:** CI/CD pipeline green, artifacts deployed to staging.
**Exit Criteria:** QA sign-off, UAT complete, no P0/P1 bugs.

| Attribute              | Detail                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–5 days                                                                                                                      |
| **Lead Role**          | QA Engineer                                                                                                                   |
| **Supporting Roles**   | Product Manager (UAT), DevOps (environment)                                                                                   |
| **Key Activities**     | Manual exploratory testing, user acceptance testing (UAT), regression testing, environment validation, data migration testing |
| **Work Products**      | QA sign-off document, bug reports, UAT results, regression report                                                             |
| **Anti-Hallucination** | QA findings must reference actual test sessions with timestamps. Screenshots/recordings for UI issues.                        |
| **Validation Gate**    | Human approval                                                                                                                |

### Phase 10: Deployment

**Purpose:** Ship to production safely.
**Entry Criteria:** QA approved, deployment plan reviewed, rollback plan ready.
**Exit Criteria:** Production deployment successful, monitoring confirms health.

| Attribute              | Detail                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Duration**           | Hours to 1 day                                                                                             |
| **Lead Role**          | DevOps/SRE                                                                                                 |
| **Supporting Roles**   | Developer (on-call), QA (smoke tests)                                                                      |
| **Key Activities**     | Canary/blue-green deployment, feature flag activation, smoke testing, monitoring watch, rollback readiness |
| **Work Products**      | Deployment runbook, rollback plan, release notes, changelog entry                                          |
| **Anti-Hallucination** | Deployment status must reflect actual infrastructure state. Health checks must query real endpoints.       |
| **Validation Gate**    | Build verification + human approval for production                                                         |

### Phase 11: Monitoring & Observability

**Purpose:** Know what's happening in production.
**Entry Criteria:** Deployment complete, monitoring configured.
**Exit Criteria:** SLOs defined, alerts configured, dashboards live.

| Attribute              | Detail                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Duration**           | Continuous                                                                                                  |
| **Lead Role**          | DevOps/SRE                                                                                                  |
| **Supporting Roles**   | Developer (instrumentation), Data Analyst (metrics)                                                         |
| **Key Activities**     | Log aggregation, metric collection, alert configuration, SLO definition, dashboard creation, trace analysis |
| **Work Products**      | Monitoring configuration, alert rules, dashboards, SLO definitions, on-call runbooks                        |
| **Anti-Hallucination** | All metrics must come from real monitoring systems. No assumed error rates. No invented SLO numbers.        |
| **Validation Gate**    | Auto (metrics baseline established)                                                                         |

### Phase 12: Incident Response

**Purpose:** Detect, respond to, and learn from production issues.
**Entry Criteria:** Incident detected (alert, user report, monitoring).
**Exit Criteria:** Incident resolved, post-mortem complete, improvements identified.

| Attribute              | Detail                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | Hours to days                                                                                                                      |
| **Lead Role**          | DevOps/SRE (on-call)                                                                                                               |
| **Supporting Roles**   | Developer (diagnosis), Product Manager (communication)                                                                             |
| **Key Activities**     | Incident detection, severity classification, triage, mitigation, root cause analysis, post-mortem                                  |
| **Work Products**      | Incident timeline, root cause analysis, post-mortem document, action items                                                         |
| **Anti-Hallucination** | Incident timelines must reference real log entries with timestamps. Root causes must cite actual code paths. No speculative blame. |
| **Validation Gate**    | Forensic verification of root cause + human review                                                                                 |

### Phase 13: Documentation & Knowledge

**Purpose:** Record decisions, APIs, and processes for future reference.
**Entry Criteria:** Feature complete, deployed, stable.
**Exit Criteria:** Docs updated, API reference current, runbooks reviewed.

| Attribute              | Detail                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | 1–3 days                                                                                                                                              |
| **Lead Role**          | Technical Writer                                                                                                                                      |
| **Supporting Roles**   | Developer (technical accuracy), Architect (architecture docs)                                                                                         |
| **Key Activities**     | API documentation, architecture docs, user guides, runbooks, ADR updates, changelog maintenance, README updates                                       |
| **Work Products**      | API reference, architecture docs, user guides, operational runbooks, ADRs, changelogs                                                                 |
| **Anti-Hallucination** | All code examples must compile. All API endpoints must exist. All configuration examples must be valid. Forensic verification of all code references. |
| **Validation Gate**    | Forensic verification of code/API references                                                                                                          |

### Phase 14: Maintenance & Evolution

**Purpose:** Keep the system healthy and evolving.
**Entry Criteria:** System in production, ongoing usage.
**Exit Criteria:** (Continuous — never fully exits)

| Attribute              | Detail                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Duration**           | Continuous                                                                                                                   |
| **Lead Role**          | Tech Lead                                                                                                                    |
| **Supporting Roles**   | Developer, Security Engineer, DevOps                                                                                         |
| **Key Activities**     | Tech debt tracking, dependency updates, security patching, performance optimization, feature deprecation, migration planning |
| **Work Products**      | Tech debt inventory, dependency audit, security patch log, performance reports, deprecation notices                          |
| **Anti-Hallucination** | Dependency versions must be verified against actual package.json/lockfile. Vulnerability reports must reference real CVEs.   |
| **Validation Gate**    | Forensic verification of dependency/security claims                                                                          |

---

## The 12 Virtual Roles

Each role maps to a Brainstorm agent configuration with specific model selection, tool permissions, system prompts, and output schemas.

### Role 1: Product Strategist

| Attribute                 | Detail                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `product-strategist`                                                                                    |
| **Subagent Type**         | `research`                                                                                              |
| **Model Strategy**        | Quality-first (Opus for market analysis)                                                                |
| **Tool Access**           | web_search, web_fetch, file_read, grep, glob                                                            |
| **Primary Phases**        | Discovery, Requirements                                                                                 |
| **Key Outputs**           | Discovery reports, competitive analyses, market sizing                                                  |
| **Anti-Hallucination**    | Every market stat must cite a URL. Every competitive claim must reference a real product at a real URL. |
| **Confidence Threshold**  | 0.8 (high — strategic decisions)                                                                        |

### Role 2: Product Manager

| Attribute                 | Detail                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `product-manager`                                                                                                                                           |
| **Subagent Type**         | `plan`                                                                                                                                                      |
| **Model Strategy**        | Quality-first (Opus for requirements)                                                                                                                       |
| **Tool Access**           | file_read, grep, glob, task_create, task_update                                                                                                             |
| **Blocked Tools**         | file_write, shell, git_commit                                                                                                                               |
| **Primary Phases**        | Requirements, Sprint Planning, Staging (UAT)                                                                                                                |
| **Key Outputs**           | PRDs, user stories, acceptance criteria, UAT results                                                                                                        |
| **Anti-Hallucination**    | User stories must reference real entities from codebase analysis. Acceptance criteria must be testable. No invented user personas without research backing. |
| **Confidence Threshold**  | 0.8                                                                                                                                                         |

### Role 3: Software Architect

| Attribute                 | Detail                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `architect`                                                                                                                                               |
| **Subagent Type**         | `plan`                                                                                                                                                    |
| **Model Strategy**        | Quality-first (Opus for design)                                                                                                                           |
| **Tool Access**           | file_read, grep, glob, git_status, git_diff, git_log                                                                                                      |
| **Blocked Tools**         | file_write, file_edit, shell, git_commit                                                                                                                  |
| **Primary Phases**        | Architecture, Code Review (architectural conformance)                                                                                                     |
| **Key Outputs**           | ADRs, component diagrams, API contracts, data models                                                                                                      |
| **Anti-Hallucination**    | Every component referenced must exist or be marked "TO CREATE". Every import path must be valid. Every package dependency must be real at a real version. |
| **Confidence Threshold**  | 0.85 (high — architectural decisions are expensive to reverse)                                                                                            |

### Role 4: Tech Lead

| Attribute                 | Detail                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `tech-lead`                                                                                                |
| **Subagent Type**         | `decompose`                                                                                                |
| **Model Strategy**        | Combined (balance speed + quality)                                                                         |
| **Tool Access**           | file_read, grep, glob, task_create, task_update, task_list                                                 |
| **Primary Phases**        | Sprint Planning, Implementation (oversight), Maintenance                                                   |
| **Key Outputs**           | Sprint backlogs, task decompositions, effort estimates, dependency maps                                    |
| **Anti-Hallucination**    | Estimates must reference complexity metrics or historical data. Dependencies must reference real packages. |
| **Confidence Threshold**  | 0.7                                                                                                        |

### Role 5: Senior Developer

| Attribute                 | Detail                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `coder` (quality tier)                                                                                                                                      |
| **Subagent Type**         | `code`                                                                                                                                                      |
| **Model Strategy**        | Quality-first (Sonnet for implementation)                                                                                                                   |
| **Tool Access**           | ALL tools                                                                                                                                                   |
| **Primary Phases**        | Implementation, Code Review, Testing, Maintenance                                                                                                           |
| **Key Outputs**           | Production code, unit tests, refactored code, bug fixes                                                                                                     |
| **Anti-Hallucination**    | Read before write (enforced). Build must pass after every edit. Self-review on every file write. Code must match the spec (forensic verification optional). |
| **Confidence Threshold**  | 0.7                                                                                                                                                         |

### Role 6: Developer

| Attribute                 | Detail                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Brainstorm Agent Role** | `coder` (cost tier)                                                                              |
| **Subagent Type**         | `code`                                                                                           |
| **Model Strategy**        | Cost-first (Haiku/Gemini Flash for routine tasks)                                                |
| **Tool Access**           | file_read, file_write, file_edit, glob, grep, shell                                              |
| **Blocked Tools**         | git_commit, git_branch, process_spawn                                                            |
| **Primary Phases**        | Implementation (routine), Testing (unit tests)                                                   |
| **Key Outputs**           | Standard implementations, unit tests, simple bug fixes                                           |
| **Anti-Hallucination**    | Same as Senior Developer. Additional: blocked from committing directly (must go through review). |
| **Confidence Threshold**  | 0.6                                                                                              |

### Role 7: Security Engineer

| Attribute                 | Detail                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `security-engineer`                                                                                                                                                                            |
| **Subagent Type**         | `review`                                                                                                                                                                                       |
| **Model Strategy**        | Quality-first (Opus for security analysis)                                                                                                                                                     |
| **Tool Access**           | file_read, grep, glob, shell (for security scanning), web_search (for CVE lookup)                                                                                                              |
| **Primary Phases**        | Architecture (threat modeling), Code Review (security review), Testing (security testing), Maintenance (patching)                                                                              |
| **Key Outputs**           | Threat models, security review findings, vulnerability reports, SAST/DAST results, patch recommendations                                                                                       |
| **Anti-Hallucination**    | CVE references must be real (verifiable at nvd.nist.gov). OWASP references must cite real categories. Vulnerability findings must cite file:line. No imagined attack vectors without evidence. |
| **Confidence Threshold**  | 0.9 (critical — security misses are catastrophic)                                                                                                                                              |

### Role 8: QA Engineer

| Attribute                 | Detail                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brainstorm Agent Role** | `qa-engineer`                                                                                                                                                                                    |
| **Subagent Type**         | `review` + `code` (for test writing)                                                                                                                                                             |
| **Model Strategy**        | Quality-first (Sonnet)                                                                                                                                                                           |
| **Tool Access**           | file_read, grep, glob, shell, git_status, git_diff                                                                                                                                               |
| **Primary Phases**        | Requirements (testability review), Testing, Staging, Code Review                                                                                                                                 |
| **Key Outputs**           | Test plans, test cases, test execution reports, coverage analysis, bug reports                                                                                                                   |
| **Anti-Hallucination**    | Test results must come from actual test execution. No fabricated pass/fail. Coverage numbers must come from real coverage tools. Bug reports must include reproduction steps that actually work. |
| **Confidence Threshold**  | 0.8                                                                                                                                                                                              |

### Role 9: DevOps/SRE

| Attribute                 | Detail                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `devops-sre`                                                                                                                                            |
| **Subagent Type**         | `code`                                                                                                                                                  |
| **Model Strategy**        | Combined                                                                                                                                                |
| **Tool Access**           | ALL tools (needs shell for infra operations)                                                                                                            |
| **Primary Phases**        | CI/CD, Deployment, Monitoring, Incident Response                                                                                                        |
| **Key Outputs**           | CI/CD configs, deployment runbooks, monitoring dashboards, incident post-mortems, SLO definitions                                                       |
| **Anti-Hallucination**    | Infrastructure references must point to real resources. Deployment targets must be real endpoints. Monitoring queries must reference real metric names. |
| **Confidence Threshold**  | 0.8                                                                                                                                                     |

### Role 10: Technical Writer

| Attribute                 | Detail                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `technical-writer` (maps to `analyst`)                                                                                                                                                                   |
| **Subagent Type**         | `plan`                                                                                                                                                                                                   |
| **Model Strategy**        | Quality-first (for clarity and accuracy)                                                                                                                                                                 |
| **Tool Access**           | file_read, grep, glob, git_log                                                                                                                                                                           |
| **Blocked Tools**         | file_write (writes to docs/ only), shell                                                                                                                                                                 |
| **Primary Phases**        | Documentation, Requirements (review for clarity)                                                                                                                                                         |
| **Key Outputs**           | API reference, architecture docs, user guides, changelogs, READMEs                                                                                                                                       |
| **Anti-Hallucination**    | All code examples must compile. All API endpoints must exist and return the documented response. All configuration examples must be valid TOML/YAML/JSON. Forensic verification on every code reference. |
| **Confidence Threshold**  | 0.85                                                                                                                                                                                                     |

### Role 11: Data Analyst

| Attribute                 | Detail                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm Agent Role** | `data-analyst` (maps to `analyst`)                                                                                                                 |
| **Subagent Type**         | `research`                                                                                                                                         |
| **Model Strategy**        | Combined                                                                                                                                           |
| **Tool Access**           | file_read, grep, glob, web_search, web_fetch, shell (for data queries)                                                                             |
| **Primary Phases**        | Discovery (market data), Monitoring (metrics), Maintenance (analytics)                                                                             |
| **Key Outputs**           | Data analyses, metric dashboards, usage reports, A/B test results                                                                                  |
| **Anti-Hallucination**    | All statistics must cite data sources. No invented sample sizes or confidence intervals. Query results must come from actual database/API queries. |
| **Confidence Threshold**  | 0.85                                                                                                                                               |

### Role 12: Forensic Verifier

| Attribute                 | Detail                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brainstorm Agent Role** | `forensic`                                                                                                                                                   |
| **Subagent Type**         | `forensic` (NEW)                                                                                                                                             |
| **Model Strategy**        | Quality-first (Opus for verification accuracy)                                                                                                               |
| **Tool Access**           | file_read, grep, glob, list_dir, git_status, git_diff, git_log                                                                                               |
| **Blocked Tools**         | ALL write tools (read-only by design)                                                                                                                        |
| **Primary Phases**        | ALL (verification happens after artifact generation)                                                                                                         |
| **Key Outputs**           | Forensic verification reports with per-claim VERIFIED/DISPUTED status                                                                                        |
| **Anti-Hallucination**    | This IS the anti-hallucination mechanism. Must read files before asserting. Must cite file:line for every verification. Must never confirm without evidence. |
| **Confidence Threshold**  | 0.95 (highest — the verifier must be trustworthy)                                                                                                            |

---

## The Master Matrix

### Phase × Role × Work Product × Validation

```
Phase                  Lead Role              Work Products                              Validation Gates
─────────────────────────────────────────────────────────────────────────────────────────────────────────
1. Discovery           Product Strategist     Discovery report, competitive analysis     Forensic (external claims)
2. Requirements        Product Manager        PRD, user stories, acceptance criteria     Forensic + Human approval
3. Architecture        Architect              ADRs, diagrams, API contracts              Forensic + Human approval
4. Sprint Planning     Tech Lead              Sprint backlog, estimates, deps            Auto (confidence)
5. Implementation      Sr. Developer          Code, unit tests, commits                  Build verification
6. Code Review         Code Reviewer ×3       Review findings, approval/rejection        Consensus (2-of-3)
7. Testing             QA Engineer            Test plan, results, coverage               Build + Forensic (results)
8. CI/CD               DevOps/SRE             Pipeline config, quality gates             Auto (pipeline pass/fail)
9. Staging             QA + PM                QA sign-off, UAT results                   Human approval
10. Deployment         DevOps/SRE             Runbook, rollback plan, release notes      Build + Human approval
11. Monitoring         DevOps/SRE             Alerts, dashboards, SLOs                   Auto (metrics baseline)
12. Incident Response  DevOps/SRE             Timeline, RCA, post-mortem                 Forensic (RCA) + Human
13. Documentation      Technical Writer       API docs, guides, changelogs               Forensic (code refs)
14. Maintenance        Tech Lead              Debt inventory, dep audit, patches          Forensic (dep versions)
```

### Artifact Flow Between Phases

```
Discovery Report ──→ PRD ──→ Architecture ──→ Sprint Plan ──→ Code
                                   │                            │
                                   │                            ▼
                                   │                    Code Review ←── Security Review
                                   │                            │
                                   ▼                            ▼
                            API Contracts ──→ Test Plan ──→ Test Results
                                                               │
                                                               ▼
                                                        CI/CD Pipeline
                                                               │
                                                               ▼
                                                     Staging ──→ Deploy
                                                                  │
                                                                  ▼
                                                        Monitoring ──→ Incident Response
                                                                          │
                                                                          ▼
                                                                    Post-Mortem ──→ Maintenance
```

Every arrow represents an artifact dependency. The receiving phase MUST verify the source artifact's claims before building on them.

---

## Anti-Hallucination Framework

### 5 Layers of Verification

#### Layer 1: Ground Truth Anchoring (Zero Cost — Always Active)

Every agent must operate from real data:

- **Read before write**: Agent must read a file before modifying it (enforced in tool layer)
- **Git diff verification**: After every edit, diff must match stated intent
- **Path validation**: File paths referenced in output must exist on disk
- **Import validation**: Import statements must reference real modules

#### Layer 2: Evidence Chain (Minimal Cost — Middleware)

Passive tracking of every tool call during agent execution:

- Every `file_read` recorded with path + line range
- Every `grep`/`glob` result recorded
- Every `shell` command + output recorded
- Provenance attached to every artifact automatically
- Enables post-hoc audit: "How did the agent arrive at this conclusion?"

#### Layer 3: Forensic Verification (~$0.05/artifact)

Independent agent reads codebase and verifies claims:

- Extract all verifiable claims from artifact (file refs, function names, API endpoints)
- Spawn read-only forensic subagent
- For each claim: read the referenced file, confirm entity exists, confirm it matches description
- Return per-claim VERIFIED/DISPUTED with evidence
- Disputes block phase progression

**When to trigger:**

- ALWAYS after: PRD, architecture, security assessment
- OPTIONALLY after: code review, documentation, incident RCA
- NEVER after: implementation (use build verification instead — cheaper and more reliable)

#### Layer 4: Multi-Agent Consensus (~$0.15/vote)

Three independent agents review the same artifact:

- Use DIFFERENT models (Opus, Gemini Pro, GPT-5) to prevent groupthink
- Each agent independently produces structured findings
- 2-of-3 must approve for consensus
- Disagreements escalate to quality model for tie-break

**When to trigger:**

- ALWAYS for: code review (already implemented — 3 parallel reviewers)
- OPTIONALLY for: architecture review, security assessment
- NEVER for: routine implementation (too expensive)

#### Layer 5: Human-in-the-Loop (Zero Cost — Time Only)

Pipeline pauses for human approval:

- PRD approval before architecture begins
- Architecture approval before implementation begins
- Deploy approval before production push
- Budget threshold gate (pause if estimated cost > configurable limit)
- Confidence threshold gate (pause if agent confidence < 0.7)

### Anti-Hallucination Rules Per Artifact Type

| Artifact Type         | L1 Ground Truth | L2 Evidence |          L3 Forensic           | L4 Consensus | L5 Human |
| --------------------- | :-------------: | :---------: | :----------------------------: | :----------: | :------: |
| Discovery Report      |        ✓        |      ✓      |      ✓ (external claims)       |      —       |    —     |
| PRD                   |        ✓        |      ✓      |         ✓ (code refs)          |      —       |    ✓     |
| Architecture / ADR    |        ✓        |      ✓      |       ✓ (component refs)       |   Optional   |    ✓     |
| Sprint Plan           |        ✓        |      ✓      |               —                |      —       |    —     |
| Code (Implementation) |        ✓        |      ✓      | — (build verification instead) |      —       |    —     |
| Code Review           |        ✓        |      ✓      |               —                |  ✓ (2-of-3)  |    —     |
| Test Results          |        ✓        |      ✓      |   ✓ (verify real execution)    |      —       |    —     |
| Security Assessment   |        ✓        |      ✓      |          ✓ (CVE refs)          |      ✓       |    —     |
| Deployment Runbook    |        ✓        |      ✓      |       ✓ (endpoint refs)        |      —       |    ✓     |
| Incident Post-Mortem  |        ✓        |      ✓      |          ✓ (log refs)          |      —       |    ✓     |
| Documentation         |        ✓        |      ✓      |       ✓ (code examples)        |      —       |    —     |
| Dependency Audit      |        ✓        |      ✓      |    ✓ (version verification)    |      —       |    —     |

---

## Work Product Schemas

Every work product has a defined schema with mandatory fields. All schemas include:

```yaml
required_fields:
  confidence: number (0.0 - 1.0)
  evidenceChain:
    - claim: string
      source: string (file:line or URL)
      verified: boolean
```

### PRD Document Schema

```yaml
title: string
problem_statement: string (must reference real user research)
target_users: string[]
user_stories:
  - as_a: string
    i_want_to: string
    so_that: string
    acceptance_criteria:
      - given: string
        when: string
        then: string
scope:
  in_scope: string[]
  out_of_scope: string[]
  dependencies: string[] (must reference real packages/services)
success_metrics:
  - metric: string
    target: number
    measurement_method: string
risks:
  - risk: string
    probability: high|medium|low
    impact: high|medium|low
    mitigation: string
```

### Architecture Decision Record (ADR) Schema

```yaml
title: string
status: proposed|accepted|deprecated|superseded
context: string (must reference real system constraints)
decision: string
alternatives_considered:
  - option: string
    pros: string[]
    cons: string[]
    reason_rejected: string
consequences:
  - consequence: string
    type: positive|negative|neutral
components_affected: string[] (must reference real files/modules)
api_contracts:
  - method: string
    path: string
    request_schema: object
    response_schema: object
data_models:
  - entity: string
    fields: object[]
    relationships: string[]
```

### Security Assessment Schema

```yaml
threat_model:
  assets: string[] (must reference real data stores/services)
  threat_actors: string[]
  attack_vectors:
    - vector: string
      affected_component: string (must reference real component)
      severity: critical|high|medium|low
      mitigation: string
      cve_reference: string (optional, must be real CVE)
vulnerabilities:
  - id: string
    type: string (OWASP category)
    file: string (file:line)
    description: string
    remediation: string
    severity: critical|high|medium|low
compliance:
  - standard: string (e.g., "OWASP Top 10 2024")
    status: compliant|non-compliant|partial
    findings: string[]
```

### Forensic Verification Report Schema

```yaml
artifact_id: string
verification_timestamp: ISO8601
verifier_model: string
claims_verified: number
claims_disputed: number
claims_unverifiable: number
overall_verdict: verified|partially-verified|disputed
claims:
  - claim: string
    referenced_file: string
    referenced_line: number
    status: verified|disputed|unverifiable
    evidence: string (what was actually found)
    actual_content: string (the real content at that location)
confidence: number (0.0 - 1.0)
```

---

## Validation Gates

### Gate Types

| Type               | Trigger                  | Block?               | Cost      | When to Use                     |
| ------------------ | ------------------------ | -------------------- | --------- | ------------------------------- |
| **Auto**           | Confidence < threshold   | Yes                  | $0        | Every phase                     |
| **Build Verify**   | Build/test command       | Yes                  | $0        | After code changes              |
| **Forensic**       | Spawns forensic subagent | Yes (if disputed)    | ~$0.05    | After specs, architecture, docs |
| **Consensus**      | 3-agent parallel review  | Yes (if rejected)    | ~$0.15    | Code review, security review    |
| **Human Approval** | Pauses pipeline          | Yes (until approved) | $0 (time) | PRD, architecture, deploy       |

### Default Gate Configuration Per Phase

```yaml
discovery:
  gates: [forensic]
requirements:
  gates: [forensic, human-approval]
architecture:
  gates: [forensic, human-approval]
sprint-planning:
  gates: [auto]
implementation:
  gates: [build-verify]
code-review:
  gates: [consensus]
testing:
  gates: [build-verify, forensic]
ci-cd:
  gates: [auto]
staging:
  gates: [human-approval]
deployment:
  gates: [build-verify, human-approval]
monitoring:
  gates: [auto]
incident-response:
  gates: [forensic, human-approval]
documentation:
  gates: [forensic]
maintenance:
  gates: [forensic]
```

---

## Evidence Chain Protocol

### What Gets Tracked

Every agent turn automatically records:

1. **Files read**: path, line range, content hash
2. **Search results**: grep/glob patterns, matched files
3. **Shell commands**: command, exit code, stdout/stderr summary
4. **Tool sequence**: ordered list of all tool calls
5. **External fetches**: URLs accessed, response summaries

### How It's Stored

```json
{
  "artifactId": "spec-001",
  "provenance": {
    "filesRead": [
      { "path": "src/auth/middleware.ts", "lines": [1, 45], "hash": "a1b2c3" },
      { "path": "src/routes/api.ts", "lines": [12, 30], "hash": "d4e5f6" }
    ],
    "toolCallsUsed": ["file_read", "grep", "file_read", "task_create"],
    "claimsToVerify": [
      {
        "claim": "The auth middleware exports verifyToken()",
        "evidence": "file_read src/auth/middleware.ts:12 — export function verifyToken(token: string)",
        "sourceFile": "src/auth/middleware.ts",
        "sourceLine": 12
      }
    ],
    "parentArtifactIds": [],
    "generatedAt": 1711756800000,
    "generatedBy": "product-manager-agent",
    "modelUsed": "claude-opus-4.6"
  }
}
```

### Audit Trail

Every artifact in the manifest includes its full provenance. This enables:

- **Post-hoc verification**: "How did the agent know X?" → check filesRead
- **Blame tracking**: "Which agent introduced this claim?" → check generatedBy
- **Dependency analysis**: "What artifacts depend on this one?" → check parentArtifactIds
- **Compliance reporting**: "Prove every decision was evidence-based" → export provenance chain

---

## Forensic Verification Protocol

### Claim Extraction

The forensic verifier extracts claims from artifacts using pattern matching:

1. **File references**: `path/to/file.ts`, `path/to/file.ts:42`
2. **Function/class names**: "The `verifyToken()` function in auth.ts"
3. **API endpoints**: "GET /api/users", "POST /v1/chat/completions"
4. **Package dependencies**: "@brainstorm/router@0.12.1"
5. **Database schemas**: "The `users` table has a `role` column"
6. **Configuration values**: "The `maxSteps` config defaults to 10"

### Verification Process

For each extracted claim:

1. **File existence**: Does the referenced file exist? (`glob`)
2. **Line content**: Does the referenced line contain what's claimed? (`file_read` with offset)
3. **Entity existence**: Does the function/class/endpoint exist? (`grep` for definition)
4. **Version accuracy**: Does the package exist at the claimed version? (`file_read package.json`)
5. **Schema accuracy**: Does the table/column exist? (`grep` migration files or schema)

### Verdict Categories

- **VERIFIED**: Claim confirmed with evidence. Source file read, entity found, content matches.
- **DISPUTED**: Claim contradicted by evidence. File exists but entity not found, or content differs.
- **UNVERIFIABLE**: Cannot confirm or deny. File doesn't exist, or claim is about external system.

### Dispute Handling

When a claim is DISPUTED:

1. The forensic report includes what was ACTUALLY found at the referenced location
2. The generating agent receives the dispute with the correct information
3. The artifact is flagged as `verificationStatus: "disputed"`
4. Pipeline progression is BLOCKED until the dispute is resolved (agent regenerates with correct info, or human overrides)

---

## Multi-Agent Consensus Protocol

### Why Different Models

If three instances of the same model review the same code, they will likely agree (same training biases). True consensus requires diverse perspectives:

| Agent      | Model           | Perspective                          |
| ---------- | --------------- | ------------------------------------ |
| Reviewer A | Claude Opus 4.6 | Deep reasoning, security-focused     |
| Reviewer B | Gemini 3.1 Pro  | Broad knowledge, performance-focused |
| Reviewer C | GPT-5.4         | Pattern matching, style-focused      |

### Voting Mechanism

1. Each reviewer independently produces a structured review (same schema)
2. Reviews are collected after all three complete (parallel execution)
3. Each review contains: overall verdict (approve/reject), critical findings, severity ratings
4. Consensus rule: 2-of-3 must approve for passage
5. If 2+ reject: artifact is sent back with aggregated findings
6. If split (1 approve, 1 reject, 1 conditional): escalate to Opus for tie-break review

### Cost Controls

- Consensus is EXPENSIVE (~$0.15 per vote, $0.45 for a full 3-agent review)
- Only triggered for: code review (always), security assessment (optional), architecture (optional)
- Never triggered for: routine implementation, documentation, sprint planning
- Budget enforcement: if remaining budget < $0.50, skip consensus and use single-agent review

---

## Failure Mode Catalog

### Hallucination Types and Detection

| Failure Mode                  | Description                                                 | Detection Method                                         | Prevention                  |
| ----------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | --------------------------- |
| **Phantom file reference**    | Agent references file that doesn't exist                    | Forensic: `glob` for file                                | Ground truth anchoring      |
| **Phantom function**          | Agent references function that doesn't exist                | Forensic: `grep` for definition                          | Read-before-reference       |
| **Invented API endpoint**     | Agent claims endpoint exists when it doesn't                | Forensic: `grep` for route definition                    | Evidence chain tracking     |
| **Wrong version number**      | Agent cites wrong package version                           | Forensic: `file_read package.json`                       | Version pinning in evidence |
| **Fabricated test results**   | Agent claims tests pass when they don't                     | Build verification: actually run tests                   | Mandatory test execution    |
| **Invented metric**           | Agent cites statistics without data source                  | Evidence chain: check web_fetch/shell history            | Source citation requirement |
| **Stale information**         | Agent references code that was recently changed             | Evidence chain: check file hash vs current               | Re-read before asserting    |
| **Confident wrong answer**    | Agent is confidently incorrect about behavior               | Multi-agent consensus: diverse models disagree           | Consensus voting            |
| **Hallucinated architecture** | Agent describes system structure that doesn't match reality | Forensic: cross-reference against actual imports/exports | Architecture verification   |
| **Phantom dependency**        | Agent assumes package exists or is installed                | Forensic: `file_read package.json` + lockfile            | Dependency verification     |

### Recovery Procedures

When a hallucination is detected:

1. **Flag**: Mark artifact as `verificationStatus: "disputed"`
2. **Diagnose**: Forensic report shows what was claimed vs what exists
3. **Correct**: Regenerate artifact with forensic report as context (agent now knows the truth)
4. **Verify**: Re-run forensic verification on the corrected artifact
5. **Learn**: Record the failure pattern in trajectory data for BrainstormLLM training

---

## Integration with Brainstorm Ecosystem

### How Each Product Contributes

```
BRAINSTORM CLI (The Interface)
├── Runs the 14-phase pipeline via `storm workflow run full-sdlc "task"`
├── Manages virtual roles via /architect, /sr-developer, /qa, etc.
├── Provides 42+ tools that agents use during each phase
├── Captures trajectories for LLM training
└── Presents evidence chains and forensic reports to the user

BRAINSTORMROUTER (The Intelligence)
├── Routes each phase's agent call to the optimal model
├── Thompson sampling learns which model is best for each phase × role combo
├── Streaming guardrails catch PII/injection during artifact generation
├── Evidence ledger records every routing decision for audit
├── Budget forecasting prevents cost overruns across the pipeline
└── Memory system persists cross-session context for long projects

BRAINSTORMLLM (The Learning)
├── Predicts which phases are needed (skip unnecessary ones → cost savings)
├── Trained on real trajectories including hallucination failures
├── Phase prediction improves with every pipeline run
├── Learns per-codebase patterns (which phases THIS project needs)
└── ONNX inference adds <2ms to routing decision
```

### DORA Metrics Integration

The SDLC framework naturally produces DORA metrics:

- **Deployment Frequency**: Tracked by Phase 10 (deploy) execution count
- **Lead Time for Changes**: Time from Phase 2 (spec) to Phase 10 (deploy)
- **Mean Time to Recovery**: Time from Phase 12 (incident) detection to resolution
- **Change Failure Rate**: Ratio of Phase 12 incidents to Phase 10 deployments

---

## Industry Framework Alignment

### SAFe (Scaled Agile Framework)

- Phases 1-4 map to SAFe's "Program Increment Planning"
- Phases 5-10 map to SAFe's "Iteration Execution"
- Phases 11-14 map to SAFe's "Inspect & Adapt"

### Microsoft SDL (Security Development Lifecycle)

- Phase 3 Architecture → SDL's "Design Phase" (threat modeling)
- Phase 6 Code Review → SDL's "Implementation Phase" (security review)
- Phase 7 Testing → SDL's "Verification Phase" (security testing)
- Phase 10 Deploy → SDL's "Release Phase" (final security review)

### OWASP SDLC Integration

- Phase 2 Requirements → OWASP security requirements
- Phase 3 Architecture → OWASP threat modeling
- Phase 6 Code Review → OWASP code review guide
- Phase 7 Testing → OWASP testing guide
- Phase 14 Maintenance → OWASP vulnerability management

### Google SRE Practices

- Phase 10 Deployment → SRE's error budgets and release management
- Phase 11 Monitoring → SRE's service level objectives (SLOs)
- Phase 12 Incident Response → SRE's incident management and blameless post-mortems

---

_This document is the foundation for Brainstorm's AI-powered SDLC system. Every concept defined here will be implemented as code in the Brainstorm CLI, validated through BrainstormRouter's intelligence layer, and improved through BrainstormLLM's trajectory learning._
