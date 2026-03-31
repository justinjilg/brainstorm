# SDLC Industry Tools Map — What We Use vs. What Exists

> Maps every phase of the software development lifecycle to the industry tools available,
> what the Brainstorm workspace currently uses, and where gaps or upgrade opportunities exist.
>
> Last updated: 2026-03-31

---

## How to Read This Document

Each SDLC phase lists:

- **Industry Tools** — the major options teams use worldwide
- **We Use** — what's active in our workspace today
- **Gap / Opportunity** — where we're missing coverage or could consolidate

---

## Phase 1: Ideation & Discovery

The "what should we build and why" phase — user research, market analysis, competitive intelligence.

### 1a. User Research & Feedback

| Category          | Industry Tools                                 | We Use                                | Notes                                       |
| ----------------- | ---------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| User interviews   | Dovetail, Grain, Otter.ai, EnjoyHQ             | —                                     | No dedicated tool; ad-hoc                   |
| Survey/forms      | Typeform, SurveyMonkey, Google Forms, Tally    | —                                     | No formal surveys                           |
| Session recording | Hotjar, FullStory, PostHog, LogRocket, Clarity | —                                     | Gap: no session recording on any product    |
| Product analytics | Amplitude, Mixpanel, PostHog, Heap, Pendo      | **Vercel Analytics** (brainstormhive) | Minimal — only page views, no event funnels |
| Feature voting    | Canny, ProductBoard, Fider, Upvoty             | —                                     | Gap: no user-facing feature request system  |
| Beta testing      | TestFlight, LaunchDarkly, Statsig              | **TestFlight** (peer10 via Fastlane)  | iOS only                                    |

### 1b. Competitive Intelligence & Market Research

| Category             | Industry Tools                              | We Use                          | Notes           |
| -------------------- | ------------------------------------------- | ------------------------------- | --------------- |
| Competitive analysis | Crayon, Klue, SimilarWeb, G2, Gartner       | **Ahrefs** (brainstorm-gtm)     | SEO focus only  |
| Market data          | PitchBook, Crunchbase, CBInsights, Statista | —                               | Manual research |
| Social listening     | Brandwatch, Mention, SparkToro, Brand24     | **Reddit API** (brainstorm-gtm) | Reddit only     |

---

## Phase 2: Planning & Requirements

The "what exactly are we building" phase — PRDs, specs, roadmaps, prioritization.

### 2a. Project Management & Issue Tracking

| Category            | Industry Tools                                               | We Use                     | Notes                             |
| ------------------- | ------------------------------------------------------------ | -------------------------- | --------------------------------- |
| Issue tracking      | Jira, Linear, GitHub Issues, Shortcut, Asana, ClickUp, Plane | **GitHub Issues/Projects** | Primary across all projects       |
| Roadmapping         | Productboard, Aha!, Linear Roadmaps, Notion                  | —                          | No dedicated roadmap tool         |
| Sprint planning     | Jira Sprints, Linear Cycles, Shortcut Iterations             | **GitHub Projects**        | Kanban boards, no formal sprints  |
| Requirements / PRDs | Notion, Confluence, Google Docs, Slite                       | **Markdown in repo**       | PRDs live in `/docs/` as markdown |
| OKR tracking        | Lattice, 15Five, Weekdone, Gtmhub                            | —                          | Not applicable (solo/small team)  |

### 2b. Design & Wireframing

| Category       | Industry Tools                         | We Use                              | Notes                                                |
| -------------- | -------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| UI/UX design   | Figma, Sketch, Adobe XD, Penpot        | —                                   | Gap: no design tool; code-first with shadcn/Tailwind |
| Wireframing    | Balsamiq, Whimsical, Excalidraw, Miro  | —                                   | Gap: straight to code                                |
| Prototyping    | Figma, InVision, Framer, ProtoPie      | **v0** (Vercel)                     | AI-generated prototypes                              |
| Design system  | Figma Libraries, Storybook, Zeroheight | **Storybook 8** (peer10, eventflow) | Component docs but no design tokens doc              |
| Design handoff | Zeplin, Figma Dev Mode, Avocode        | —                                   | Not needed (code-first)                              |

### 2c. Architecture & Diagramming

| Category              | Industry Tools                                        | We Use                         | Notes                               |
| --------------------- | ----------------------------------------------------- | ------------------------------ | ----------------------------------- |
| Architecture diagrams | Excalidraw, draw.io, Mermaid, Lucidchart, Structurizr | **Mermaid** (in markdown docs) | In-repo diagrams                    |
| API design            | Stoplight, Swagger Editor, Postman, Insomnia          | **OpenAPI** (brainstormrouter) | YAML spec, hand-maintained          |
| ADRs                  | MADR, adr-tools, Notion                               | **Markdown ADRs**              | In `/docs/` directories             |
| Threat modeling       | OWASP Threat Dragon, IriusRisk, Microsoft TMT         | —                              | Gap: no formal threat modeling tool |

---

## Phase 3: Development

The "building it" phase — coding, version control, environments, dependencies.

### 3a. IDEs & Code Editors

| Category            | Industry Tools                                                      | We Use          | Notes                       |
| ------------------- | ------------------------------------------------------------------- | --------------- | --------------------------- |
| IDE                 | VS Code, JetBrains (WebStorm, PyCharm, GoLand), Neovim, Zed, Cursor | **VS Code**     | Primary IDE                 |
| AI coding assistant | Claude Code, GitHub Copilot, Cursor, Cody, Windsurf, Codex          | **Claude Code** | Primary across all projects |
| AI code generation  | v0, Bolt, Lovable, Replit Agent                                     | **v0** (Vercel) | UI generation               |

### 3b. Version Control & Collaboration

| Category       | Industry Tools                                      | We Use                     | Notes                       |
| -------------- | --------------------------------------------------- | -------------------------- | --------------------------- |
| VCS hosting    | GitHub, GitLab, Bitbucket, Gitea                    | **GitHub**                 | All repositories            |
| Git workflow   | trunk-based, Gitflow, GitHub Flow                   | **GitHub Flow**            | Feature branches → main     |
| Code review    | GitHub PRs, Gerrit, Phabricator, ReviewBoard        | **GitHub PRs**             | Standard PR reviews         |
| AI code review | CodeRabbit, Sourcery, Codium PR-Agent, Vercel Agent | —                          | Gap: no automated PR review |
| Git hooks      | Husky, pre-commit, lefthook, simple-git-hooks       | **Husky** + **pre-commit** | Split by project language   |

### 3c. Package & Dependency Management

| Category               | Industry Tools                           | We Use                            | Notes                                  |
| ---------------------- | ---------------------------------------- | --------------------------------- | -------------------------------------- |
| JS package manager     | npm, pnpm, yarn, bun                     | **npm** + **pnpm**                | npm primary, pnpm for brainstormrouter |
| Python packages        | pip, uv, poetry, pdm, conda              | **pip** + **uv**                  | Migrating to uv                        |
| Dependency updates     | Dependabot, Renovate, Snyk               | —                                 | Gap: no automated dependency updates   |
| License compliance     | FOSSA, Snyk, WhiteSource, License Finder | —                                 | Gap: no license scanning               |
| Vulnerability scanning | Snyk, npm audit, pip-audit, Trivy        | **detect-secrets** (secrets only) | Gap: no CVE scanning                   |

### 3d. Build Systems

| Category     | Industry Tools                                      | We Use                           | Notes              |
| ------------ | --------------------------------------------------- | -------------------------------- | ------------------ |
| Monorepo     | Turborepo, Nx, Lerna, Rush, Bazel, moon             | **Turborepo**                    | 4 monorepos        |
| JS bundlers  | Turbopack, Vite, Webpack, esbuild, Rollup, Rolldown | **tsup** + **tsdown** + **Vite** | Per-project choice |
| Python build | setuptools, hatchling, flit, maturin                | **setuptools** + **hatchling**   | Standard           |
| Go build     | `go build`, goreleaser, ko                          | **go build**                     | Standard           |

### 3e. Local Development Environment

| Category           | Industry Tools                                    | We Use                  | Notes                         |
| ------------------ | ------------------------------------------------- | ----------------------- | ----------------------------- |
| Containers         | Docker Desktop, Podman, Colima, OrbStack, Rancher | **Docker** + **Podman** | Docker primary                |
| Dev environments   | Codespaces, Gitpod, DevPod, Devbox, Nix           | —                       | Local only                    |
| Environment config | dotenv, direnv, envchain, 1Password CLI           | **1Password CLI**       | `op read` from Dev Keys vault |
| Local services     | Docker Compose, Tilt, Skaffold                    | **Docker Compose**      | For multi-service projects    |

---

## Phase 4: Code Quality & Standards

The "keeping it clean" phase — linting, formatting, type safety, conventions.

### 4a. Linting & Formatting

| Category          | Industry Tools                     | We Use                          | Notes                                |
| ----------------- | ---------------------------------- | ------------------------------- | ------------------------------------ |
| JS/TS linting     | ESLint, Biome, oxlint, deno lint   | **ESLint** + **oxlint**         | oxlint for brainstormrouter (faster) |
| JS/TS formatting  | Prettier, Biome, dprint, oxfmt     | **Prettier** + **oxfmt**        | oxfmt for brainstormrouter           |
| Python linting    | Ruff, flake8, pylint, pyflakes     | **Ruff** + **flake8**           | Migrating to Ruff                    |
| Python formatting | Black, Ruff format, yapf, autopep8 | **Black** + **Ruff**            |                                      |
| Python typing     | mypy, pyright, pytype              | **mypy**                        | brainstormCLI only                   |
| Go linting        | golangci-lint, go vet, staticcheck | **go vet**                      | Minimal                              |
| Swift linting     | SwiftLint, SwiftFormat             | **SwiftLint** + **SwiftFormat** | peer10 mobile                        |
| Shell linting     | ShellCheck, shfmt                  | **ShellCheck**                  | brainstormrouter                     |

### 4b. Code Quality Platforms

| Category                | Industry Tools                               | We Use | Notes                                       |
| ----------------------- | -------------------------------------------- | ------ | ------------------------------------------- |
| Code quality dashboards | SonarQube, CodeClimate, Codacy, DeepSource   | —      | Gap: no quality dashboard                   |
| Technical debt tracking | SonarQube, CodeScene, Stepsize               | —      | Gap: manual tracking only                   |
| Conformance / standards | Turborepo Conformance, ESLint configs, Biome | —      | Gap: no enforced standards across monorepos |

---

## Phase 5: Testing

The "does it work" phase — unit, integration, E2E, performance, security testing.

### 5a. Unit & Integration Testing

| Category           | Industry Tools                                    | We Use                               | Notes                        |
| ------------------ | ------------------------------------------------- | ------------------------------------ | ---------------------------- |
| JS test runner     | Vitest, Jest, Mocha, AVA, Node test runner        | **Vitest** + **Jest**                | Vitest primary, Jest legacy  |
| Python test runner | pytest, unittest, nose2                           | **pytest**                           | 6500+ tests in brainstormmsp |
| Go test runner     | `go test`, testify, ginkgo                        | **go test**                          | Standard                     |
| Mocking            | Vitest mocks, MSW, nock, unittest.mock, responses | **Vitest mocks** + **unittest.mock** | Standard                     |
| Property-based     | Hypothesis, fast-check, QuickCheck                | **Hypothesis**                       | brainstormmsp only           |
| Mutation testing   | mutmut, Stryker, pitest                           | **mutmut**                           | brainstormmsp only           |
| Snapshot testing   | Vitest snapshots, Jest snapshots                  | **Vitest snapshots**                 |                              |

### 5b. End-to-End & UI Testing

| Category          | Industry Tools                             | We Use                  | Notes                     |
| ----------------- | ------------------------------------------ | ----------------------- | ------------------------- |
| Browser E2E       | Playwright, Cypress, Selenium, WebdriverIO | **Playwright**          | 5+ projects               |
| Visual regression | Chromatic, Percy, Applitools, Lost Pixel   | —                       | Gap: no visual regression |
| Component testing | Storybook, Ladle, Histoire                 | **Storybook 8**         | 3 projects                |
| Accessibility     | axe-core, Pa11y, Lighthouse CI, WAVE       | **axe-core/playwright** | E2E a11y checks           |

### 5c. Performance & Load Testing

| Category         | Industry Tools                                 | We Use                    | Notes                |
| ---------------- | ---------------------------------------------- | ------------------------- | -------------------- |
| Load testing     | k6, Locust, Artillery, Gatling, JMeter         | —                         | Gap: no load testing |
| Lighthouse / CWV | Lighthouse CI, PageSpeed Insights, WebPageTest | **Vercel Speed Insights** | brainstormhive only  |
| Profiling        | Chrome DevTools, py-spy, pprof, clinic.js      | —                         | Ad-hoc only          |

### 5d. Security Testing

| Category            | Industry Tools                                               | We Use             | Notes                            |
| ------------------- | ------------------------------------------------------------ | ------------------ | -------------------------------- |
| SAST                | Semgrep, CodeQL, Snyk Code, SonarQube                        | —                  | Gap: no static security analysis |
| DAST                | OWASP ZAP, Burp Suite, Nuclei                                | —                  | Gap: no dynamic security testing |
| Dependency scanning | Snyk, Dependabot, Trivy, Grype                               | —                  | Gap: no automated CVE scanning   |
| Secret scanning     | detect-secrets, TruffleHog, GitLeaks, GitHub secret scanning | **detect-secrets** | brainstormrouter only            |
| Container scanning  | Trivy, Snyk Container, Grype, Docker Scout                   | —                  | Gap: no container scanning       |

---

## Phase 6: CI/CD & Release

The "shipping it" phase — build pipelines, deployment, release management.

### 6a. Continuous Integration

| Category         | Industry Tools                                          | We Use                      | Notes                   |
| ---------------- | ------------------------------------------------------- | --------------------------- | ----------------------- |
| CI platform      | GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite | **GitHub Actions**          | All projects            |
| CI linting       | actionlint, act (local run), zizmor                     | **actionlint** + **zizmor** | brainstormrouter        |
| Build caching    | Turborepo Remote Cache, Nx Cloud, BuildJet              | **Turborepo Remote Cache**  | Via Vercel              |
| Artifact storage | GitHub Artifacts, S3, DO Spaces                         | **DO Spaces**               | Terraform state + media |

### 6b. Continuous Deployment

| Category           | Industry Tools                                        | We Use                                                     | Notes                               |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| Deploy platforms   | Vercel, Netlify, AWS Amplify, Fly.io, Railway, Render | **Vercel** + **DO App Platform** + **Fly.io** + **Render** | Multi-platform                      |
| Container registry | GHCR, Docker Hub, ECR, GCR                            | **GHCR**                                                   | brainstorm-gtm                      |
| Mobile deploy      | Fastlane, App Center, Bitrise, Codemagic              | **Fastlane**                                               | peer10 iOS                          |
| Feature flags      | LaunchDarkly, Statsig, Unleash, Vercel Flags, PostHog | —                                                          | Gap: no feature flags in production |
| Canary / rollout   | Vercel Rolling Releases, Argo Rollouts, Flagger       | —                                                          | Gap: no progressive rollout         |

### 6c. Release Management

| Category           | Industry Tools                                                 | We Use              | Notes                        |
| ------------------ | -------------------------------------------------------------- | ------------------- | ---------------------------- |
| Versioning         | Changesets, semantic-release, release-please, standard-version | —                   | Gap: no automated versioning |
| Changelog          | Changesets, conventional-changelog, auto-changelog             | —                   | Gap: manual changelogs       |
| Release notes      | GitHub Releases, Release Drafter                               | **GitHub Releases** | Manual                       |
| Package publishing | npm publish, PyPI (twine), goreleaser                          | —                   | brainstorm not yet published |

---

## Phase 7: Infrastructure & Operations

The "running it" phase — hosting, IaC, networking, compute.

### 7a. Infrastructure as Code

| Category          | Industry Tools                                | We Use        | Notes                       |
| ----------------- | --------------------------------------------- | ------------- | --------------------------- |
| IaC               | Terraform, Pulumi, AWS CDK, Ansible, OpenTofu | **Terraform** | BrainstormOps               |
| Config management | Ansible, Chef, Puppet, Salt                   | —             | Not needed (PaaS-heavy)     |
| Service mesh      | Istio, Linkerd, Consul Connect                | —             | Not needed at current scale |

### 7b. Compute & Hosting

| Category     | Industry Tools                                           | We Use                                                     | Notes                   |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| PaaS         | Vercel, Heroku, Railway, Render, DO App Platform, Fly.io | **DO App Platform** + **Vercel** + **Fly.io** + **Render** | Multi-platform strategy |
| IaaS         | AWS EC2, DO Droplets, GCE, Azure VMs                     | **DO Droplet**                                             | openclaw only           |
| Serverless   | AWS Lambda, Vercel Functions, Cloudflare Workers         | **Vercel Functions**                                       | brainstormhive          |
| Edge compute | Cloudflare Workers, Vercel Edge, Deno Deploy, Fastly     | **Vercel Edge**                                            | brainstormhive          |

### 7c. Databases (Managed)

| Category         | Industry Tools                                      | We Use                                            | Notes                 |
| ---------------- | --------------------------------------------------- | ------------------------------------------------- | --------------------- |
| Managed Postgres | DO Managed PG, Neon, Supabase, RDS, Cloud SQL       | **DO Managed PostgreSQL** (3 clusters) + **Neon** |                       |
| Managed Redis    | Upstash, ElastiCache, Redis Cloud, DO Managed Redis | **Redis** (self-managed via Docker)               | Gap: no managed Redis |
| Auth platform    | Supabase Auth, Clerk, Auth0, Firebase Auth          | **Supabase Auth**                                 | JWT in cookies        |

### 7d. DNS & Networking

| Category   | Industry Tools                                | We Use                                               | Notes           |
| ---------- | --------------------------------------------- | ---------------------------------------------------- | --------------- |
| DNS        | Cloudflare, Route53, DO DNS, Google Cloud DNS | **Cloudflare**                                       | All domains     |
| CDN        | Cloudflare, Vercel Edge, CloudFront, Fastly   | **Cloudflare** + **Vercel Edge** + **DO Spaces CDN** |                 |
| VPN / mesh | Tailscale, WireGuard, ZeroTier, Nebula        | **Tailscale**                                        | openclaw server |
| SSL        | Let's Encrypt, Cloudflare, DigiCert           | **Cloudflare** (auto) + **DigiCert** (code signing)  |                 |

---

## Phase 8: Monitoring & Incident Response

The "is it working" phase — observability, alerting, incident management.

### 8a. Observability

| Category             | Industry Tools                                       | We Use                            | Notes                       |
| -------------------- | ---------------------------------------------------- | --------------------------------- | --------------------------- |
| APM                  | Datadog, New Relic, Sentry, Honeycomb, Grafana Cloud | —                                 | Gap: no APM                 |
| Distributed tracing  | Jaeger, Zipkin, OpenTelemetry, Honeycomb             | **OpenTelemetry** (brainstormmsp) | Configured but minimal      |
| Metrics              | Prometheus, Datadog, Grafana, CloudWatch             | **Prometheus** (brainstorm-gtm)   | Limited                     |
| Log aggregation      | Datadog, Loki, ELK, Papertrail, Logtail              | —                                 | Gap: no centralized logging |
| Uptime monitoring    | Better Uptime, UptimeRobot, Pingdom, Checkly         | —                                 | Gap: no uptime monitoring   |
| Error tracking       | Sentry, Bugsnag, Rollbar, TrackJS                    | —                                 | Gap: no error tracking      |
| Real user monitoring | Vercel Speed Insights, SpeedCurve, Akamai mPulse     | **Vercel Speed Insights**         | brainstormhive only         |
| Web analytics        | Vercel Analytics, PostHog, Plausible, Fathom, GA4    | **Vercel Analytics**              | brainstormhive only         |

### 8b. Alerting & Incident Response

| Category            | Industry Tools                                 | We Use             | Notes                          |
| ------------------- | ---------------------------------------------- | ------------------ | ------------------------------ |
| Alerting            | PagerDuty, Opsgenie, Grafana Alerting, Datadog | **Slack webhooks** | Cost alerts + lead notifs only |
| Incident management | PagerDuty, Incident.io, FireHydrant, Rootly    | —                  | Gap: no incident management    |
| Status pages        | Statuspage.io, Instatus, Cachet, Betteruptime  | —                  | Gap: no public status page     |
| On-call scheduling  | PagerDuty, Opsgenie, Squadcast                 | —                  | Not needed (solo/small team)   |
| Post-mortems        | Notion, Confluence, Blameless, Jeli            | —                  | Ad-hoc markdown                |

---

## Phase 9: Documentation & Knowledge

The "how does it work" phase — technical docs, API docs, knowledge management.

### 9a. Documentation

| Category            | Industry Tools                                           | We Use                            | Notes                            |
| ------------------- | -------------------------------------------------------- | --------------------------------- | -------------------------------- |
| Docs site generator | Mintlify, Docusaurus, Nextra, GitBook, ReadMe, VitePress | **Custom MDX** (brainstormrouter) | Hand-built site                  |
| API documentation   | Stoplight, Swagger UI, Redoc, ReadMe                     | **OpenAPI + Swagger**             | brainstormrouter only            |
| Component docs      | Storybook, Ladle, Histoire, Styleguidist                 | **Storybook 8**                   | peer10, eventflow, platform-gold |
| AI context docs     | CLAUDE.md, .cursorrules, AGENTS.md                       | **CLAUDE.md** + **llms.txt**      | Every project                    |
| Runbooks            | Notion, Confluence, Backstage, GitBook                   | **Markdown in repo**              | Minimal                          |

### 9b. Knowledge Management

| Category              | Industry Tools                                | We Use              | Notes               |
| --------------------- | --------------------------------------------- | ------------------- | ------------------- |
| Wiki / knowledge base | Notion, Confluence, Outline, Slite, BookStack | —                   | Gap: no team wiki   |
| Decision records      | MADR, Notion databases, Confluence            | **Markdown ADRs**   | In repo             |
| Onboarding docs       | Notion, Confluence, Swimm                     | **CLAUDE.md files** | AI-first onboarding |

---

## Phase 10: Communication & Collaboration

The "working together" phase — messaging, meetings, async collaboration.

### 10a. Team Communication

| Category       | Industry Tools                    | We Use                                       | Notes                      |
| -------------- | --------------------------------- | -------------------------------------------- | -------------------------- |
| Messaging      | Slack, Teams, Discord, Mattermost | **Slack** (webhooks) + **Discord** (bot SDK) | Alerts only, not team chat |
| Video meetings | Zoom, Google Meet, Teams, Around  | —                                            | Not applicable             |
| Async video    | Loom, Screen Studio, Zight, Tango | —                                            |                            |
| Email          | Gmail, Outlook, Superhuman, HEY   | —                                            |                            |

### 10b. Collaboration

| Category         | Industry Tools                              | We Use | Notes                          |
| ---------------- | ------------------------------------------- | ------ | ------------------------------ |
| Code collab      | VS Code Live Share, CodeSandbox, StackBlitz | —      | Not needed (AI-first workflow) |
| Whiteboards      | Miro, FigJam, Excalidraw, tldraw            | —      | Gap: no visual collaboration   |
| Shared documents | Google Docs, Notion, Confluence, HackMD     | —      | Markdown in repos              |

---

## Phase 11: Security & Compliance

The "is it safe" phase — access control, auditing, compliance.

### 11a. Access & Identity

| Category          | Industry Tools                                           | We Use                | Notes                            |
| ----------------- | -------------------------------------------------------- | --------------------- | -------------------------------- |
| Secret management | 1Password, HashiCorp Vault, AWS Secrets Manager, Doppler | **1Password CLI**     | Dev Keys vault                   |
| SSO / IdP         | Okta, Auth0, Azure AD, Keycloak                          | **Supabase Auth**     | Per-app, not centralized SSO     |
| RBAC              | Custom, Casbin, OPA, Cerbos                              | **Open Policy Agent** | brainstormmsp/edge, brainstormVM |
| Key rotation      | Vault, AWS Secrets Manager, 1Password                    | **1Password**         | Manual rotation                  |

### 11b. Compliance & Auditing

| Category            | Industry Tools                      | We Use                     | Notes                         |
| ------------------- | ----------------------------------- | -------------------------- | ----------------------------- |
| SOC 2               | Vanta, Drata, Secureframe, Laika    | —                          | Gap: no compliance automation |
| Audit logging       | Custom, DataDog, Splunk             | **Custom audit_log table** | brainstorm/packages/db        |
| SBOM / supply chain | Syft, CycloneDX, SPDX, GitHub SBOM  | —                          | Gap: no SBOM generation       |
| Penetration testing | HackerOne, Bugcrowd, Cobalt, custom | —                          | Gap: no formal pen testing    |

---

## Phase 12: Analytics & Business Intelligence

The "is it working (for users)" phase — product analytics, revenue, growth.

### 12a. Product Analytics

| Category        | Industry Tools                                           | We Use               | Notes                        |
| --------------- | -------------------------------------------------------- | -------------------- | ---------------------------- |
| Event analytics | Amplitude, Mixpanel, PostHog, Heap                       | **Vercel Analytics** | Page views only — no funnels |
| Session replay  | FullStory, Hotjar, PostHog, LogRocket                    | —                    | Gap: no session replay       |
| A/B testing     | LaunchDarkly, Statsig, Optimizely, PostHog, Vercel Flags | —                    | Gap: no experimentation      |
| NPS / surveys   | Delighted, Wootric, Typeform                             | —                    | Gap: no user surveys         |

### 12b. Business Metrics

| Category          | Industry Tools                                        | We Use                              | Notes               |
| ----------------- | ----------------------------------------------------- | ----------------------------------- | ------------------- |
| Revenue / billing | Stripe Dashboard, ChartMogul, Baremetrics, ProfitWell | **Stripe**                          | Dashboard only      |
| Cost tracking     | Infracost, DO billing API, Vercel usage               | **DO cost monitoring** (GH Actions) | Budget alerts       |
| CRM               | HubSpot, Salesforce, Pipedrive, Attio                 | **HubSpot**                         | brainstorm-gtm only |

---

## Gap Analysis Summary

### Critical Gaps (High Impact)

| Gap                                  | Impact                              | Recommended Tool                           | Effort            | Status                                                                                                               |
| ------------------------------------ | ----------------------------------- | ------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| **No error tracking**                | Silent failures in production       | Sentry (free tier)                         | Low — SDK install | **DONE** — `@sentry/node` wired into CLI (`packages/shared/src/sentry.ts`). Set `SENTRY_DSN` env var to activate.    |
| **No uptime monitoring**             | Downtime undetected                 | Better Uptime or UptimeRobot (free)        | Low — URL config  | **READY** — Monitoring manifest at `docs/internal/monitoring-manifest.json` with all 11 endpoints. Sign up + import. |
| **No dependency updates**            | Security vulnerabilities accumulate | Renovate (free, self-hosted) or Dependabot | Low — config file | **DONE** — Dependabot config at `.github/dependabot.yml`. Run `npm run setup:tooling` to propagate to all 20 repos.  |
| **No centralized logging**           | Can't debug production issues       | Axiom, Logtail, or DO log forwarding       | Medium            | Pending — evaluate Axiom free tier                                                                                   |
| **No SAST / vulnerability scanning** | Undetected CVEs in dependencies     | Snyk or GitHub Advanced Security           | Medium            | **DONE** — CodeQL workflow at `.github/workflows/codeql.yml`. Run `npm run setup:tooling` to propagate.              |

### Moderate Gaps (Worth Considering)

| Gap                                          | Impact                                | Recommended Tool                      | Effort | Status                                                                                                                        |
| -------------------------------------------- | ------------------------------------- | ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **No visual regression testing**             | UI regressions slip through           | Chromatic (Storybook integration)     | Low    | Pending                                                                                                                       |
| **No feature flags**                         | All-or-nothing deploys                | Vercel Flags or PostHog               | Medium | Pending                                                                                                                       |
| **No automated versioning**                  | Manual version bumps, no changelogs   | Changesets (already Turborepo-native) | Low    | **DONE** — Changesets installed + configured (`.changeset/config.json`). Release workflow at `.github/workflows/release.yml`. |
| **No load testing**                          | Performance issues discovered in prod | k6 (free, scriptable)                 | Medium | Pending                                                                                                                       |
| **No product analytics** (beyond page views) | Flying blind on user behavior         | PostHog (free, self-hostable)         | Medium | Pending                                                                                                                       |
| **No AI code review**                        | Manual review bottleneck              | CodeRabbit or Vercel Agent            | Low    | Pending                                                                                                                       |
| **No SBOM / supply chain visibility**        | Can't audit dependencies              | CycloneDX                             | Low    | **DONE** — `npm run sbom` generates CycloneDX 1.5 SBOM (920 packages cataloged).                                              |

### Acceptable Gaps (Not Needed Now)

| Gap                              | Why It's OK                                             |
| -------------------------------- | ------------------------------------------------------- |
| No dedicated design tool (Figma) | Code-first with shadcn/Tailwind; v0 for prototyping     |
| No wiki / knowledge base         | CLAUDE.md files + markdown docs serve the same purpose  |
| No incident management platform  | Solo/small team — Slack alerts sufficient               |
| No on-call scheduling            | Same — not yet needed                                   |
| No SOC 2 automation              | Pre-revenue; address when enterprise customers arrive   |
| No cloud dev environments        | Local development is fast, Docker covers isolation      |
| No team messaging platform       | AI-first workflow; GitHub Issues for async coordination |

---

## Consolidation Opportunities

### Tools That Could Be Replaced or Unified

| Current                                    | Replace With                    | Why                                                           |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------- |
| **Jest** (brainstormmsp)                   | **Vitest**                      | Already standard everywhere else; Jest is legacy              |
| **flake8 + Black + isort** (brainstormCLI) | **Ruff**                        | Single tool replaces all three, already used in brainstormLLM |
| **ESLint + Prettier** (5+ projects)        | **Biome** or **oxlint + oxfmt** | Already proven in brainstormrouter; much faster               |
| **pip** (brainstormmsp, brainstorm-gtm)    | **uv**                          | Already adopted in brainstormLLM, mirofish; 10x faster        |
| **SendGrid** (3 projects)                  | **Resend**                      | Already in peer10; modern, better DX, React Email             |
| **Redis (self-hosted Docker)**             | **Upstash Redis**               | Managed, serverless, Vercel Marketplace                       |

### The PostHog Question

**PostHog** could fill 4+ gaps simultaneously:

- Product analytics (event funnels, user paths)
- Session replay
- Feature flags
- A/B testing
- Surveys

Self-hostable, generous free tier, single SDK. Worth evaluating as a consolidation play for Phases 1, 5c, 6b, and 12a.

---

## Tool Count by SDLC Phase

| Phase                      | Tools In Use | Industry Avg | Coverage                                | Changes (2026-03-31)                        |
| -------------------------- | ------------ | ------------ | --------------------------------------- | ------------------------------------------- |
| 1. Ideation & Discovery    | 3            | 6-10         | Minimal                                 |                                             |
| 2. Planning & Requirements | 4            | 8-12         | Lean (intentional)                      |                                             |
| 3. Development             | 25+          | 15-20        | Heavy (polyglot)                        |                                             |
| 4. Code Quality            | 15+          | 8-12         | Strong                                  |                                             |
| 5. Testing                 | 12+          | 8-12         | Strong (unit/E2E), weak (perf/security) |                                             |
| 6. CI/CD & Release         | 8 → 11       | 8-12         | **Good** (was: weak release)            | +Changesets, +Release workflow, +Dependabot |
| 7. Infrastructure          | 10+          | 8-12         | Good                                    |                                             |
| 8. Monitoring & Incident   | 4 → 6        | 8-14         | Improving (was: weakest)                | +Sentry (ready), +Uptime manifest (ready)   |
| 9. Documentation           | 6            | 6-8          | Good (AI-first approach)                |                                             |
| 10. Communication          | 2            | 6-10         | Minimal (by design)                     |                                             |
| 11. Security               | 4 → 7        | 8-12         | **Good** (was: moderate)                | +CodeQL, +SBOM, +Dependabot security alerts |
| 12. Analytics & BI         | 3            | 6-10         | Weak                                    |                                             |

**Pattern**: Development and code quality remain strongest. Security jumped from moderate to good (+CodeQL, +SBOM, +Dependabot). Monitoring improving (+Sentry, +uptime manifest). Release management fixed (+Changesets). Analytics still weakest — PostHog is the next move.
