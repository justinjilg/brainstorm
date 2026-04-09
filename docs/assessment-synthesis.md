# Stochastic Assessment Synthesis v2 — Post-Fix

Date: 2026-04-08 | Previous: 3.2/10

## Score Distribution Table

| Dimension             | Opt | Pes | Cust | Aud | Oper | Atk | Comp | Inv | Hire | Chaos | Min | Max | Mean | StdDev |
| --------------------- | --- | --- | ---- | --- | ---- | --- | ---- | --- | ---- | ----- | --- | --- | ---- | ------ |
| Code Completeness     | 6   | 4   | 5    | 5   | 5    | 5   | 5    | 5   | 5    | 5     | 4   | 6   | 5.0  | 0.4    |
| Wiring                | 5   | 4   | 5    | 4   | 4    | 4   | 4    | 4   | 4    | 5     | 4   | 5   | 4.3  | 0.5    |
| Test Reality          | 4   | 3   | 4    | 3   | 4    | 3   | 4    | 3   | 4    | 3     | 3   | 4   | 3.5  | 0.5    |
| Production Evidence   | 5   | 3   | 4    | 4   | 4    | 5   | 5    | 5   | 4    | 5     | 3   | 5   | 4.4  | 0.7    |
| Operational Readiness | 3   | 2   | 3    | 2   | 2    | 3   | 3    | 3   | 3    | 4     | 2   | 4   | 2.8  | 0.6    |
| Security Posture      | 6   | 5   | 6    | 6   | 5    | 4   | 5    | 4   | 4    | 4     | 4   | 6   | 4.9  | 0.9    |
| Documentation         | 5   | 4   | 5    | 5   | 4    | 3   | 3    | 3   | 3    | 2     | 2   | 5   | 3.7  | 1.1    |
| Failure Handling      | 6   | 5   | 5    | 5   | 5    | 6   | 6    | 6   | 5    | 7     | 5   | 7   | 5.6  | 0.7    |
| Scale Readiness       | 3   | 2   | 3    | 3   | 3    | 2   | 3    | 2   | 3    | 3     | 2   | 3   | 2.7  | 0.5    |
| Ship Readiness        | 4   | 2   | 3    | 3   | 3    | 3   | 3    | 2   | 3    | 4     | 2   | 4   | 3.0  | 0.6    |

## Overall Scores by Assessor

| Assessor        | Score |
| --------------- | ----- |
| 1 Optimist      | 4.7   |
| 2 Pessimist     | 3.4   |
| 3 Customer      | 4.3   |
| 4 Auditor       | 4.0   |
| 5 Operator      | 3.9   |
| 6 Attacker      | 3.8   |
| 7 Competitor    | 4.1   |
| 8 Investor      | 3.7   |
| 9 New Hire      | 3.8   |
| 10 Chaos Monkey | 4.2   |

**Overall Mean: 4.0/10 (StdDev: 0.35)**
**Previous: 3.2/10 — Delta: +0.8**

## UNCERTAIN Dimensions (StdDev > 1.0)

- **Documentation (StdDev 1.1)**: Optimist/Customer/Auditor scored 5 (README exists, covers key areas). Chaos Monkey scored 2 (no runbook for failure states). Both are correct — docs exist for happy path but not for operations.

## Risk Register (sorted by count)

| Risk                                                                    | Count | Agents          |
| ----------------------------------------------------------------------- | ----- | --------------- |
| activeSkills disconnected (App.tsx empty array, SkillsView local state) | 8/10  | 1,2,3,4,5,7,8,9 |
| Zero integration tests against real backend                             | 8/10  | 1,2,3,4,5,6,8,9 |
| Plan/Workflows non-functional (3/10 views are shells)                   | 7/10  | 1,2,3,5,7,8,10  |
| Chat messages lost on mode switch                                       | 6/10  | 2,3,7,8,9,10    |
| No distributable ever produced (dist script untested)                   | 6/10  | 1,2,4,5,8,9     |
| spawnRetries never resets (cumulative crashes = permanent death)        | 4/10  | 6,9,10          |
| Disconnected banner says "port 3100" in Electron mode                   | 4/10  | 2,3,5,10        |
| IPC params not validated (arbitrary JSON to allowed methods)            | 3/10  | 4,6,10          |
| preload.ts source diverged from preload.cjs runtime                     | 3/10  | 2,4,9           |
| process.env passed wholesale to child (leaks secrets)                   | 3/10  | 2,5,6           |
| No CSP headers                                                          | 3/10  | 1,2,6           |

## What Improved (delta from 3.2)

| Dimension           | Before | After | Delta | Driver                                 |
| ------------------- | ------ | ----- | ----- | -------------------------------------- |
| Production Evidence | 1.8    | 4.4   | +2.6  | Real chat E2E proven, 8/8 IPC verified |
| Failure Handling    | 4.4    | 5.6   | +1.2  | Auto-respawn, timeout, pending cleanup |
| Security Posture    | 4.3    | 4.9   | +0.6  | IPC allowlist, config scrubbing        |
| Documentation       | 1.7    | 3.7   | +2.0  | README written                         |
| Code Completeness   | 5.0    | 5.0   | 0.0   | No new features (correct)              |

## Synthesis

The fixes moved the score from 3.2 to 4.0 — a +0.8 improvement with tight consensus (StdDev 0.35). The biggest gains were in Production Evidence (+2.6, chat proven E2E), Documentation (+2.0, README), and Failure Handling (+1.2, respawn/timeout/cleanup). Security improved modestly (+0.6, allowlist).

The remaining blockers for 7.0+ are: (1) wire the disconnected state variables (activeSkills, Plan, Workflows), (2) add integration tests, (3) produce a distributable, (4) persist chat messages across mode switches. These are engineering tasks, not architecture problems.
