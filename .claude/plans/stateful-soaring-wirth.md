# HawkTalk — AI Book Club App for Fishhawk, Lithia FL

## Vision

A real book club app for Justin's wife and the Fishhawk community. When you're reading your book, you highlight a passage, tag it, and save it for Tuesday's discussion. When the group meets, everyone's highlights are there — organized by chapter, theme, and who flagged what. AI helps generate discussion questions, summarize what you missed, and recommend what to read next.

This is not a tech demo. Real people will use this. Design matters. Mobile matters. The reading experience matters.

## Stack

- **Web**: Next.js 16 on Vercel
- **Database**: PostgreSQL (Neon via Vercel Marketplace)
- **Auth**: Clerk (Vercel Marketplace)
- **Mobile**: React Native or Expo (cross-platform)
- **AI**: BrainstormRouter for all LLM calls
- **Design**: shadcn/ui + Tailwind, dark mode, mobile-first
- **Integrations**: GoodReads, Open Library, Google Books API

## Core Features

1. **Book Clubs** — create/join clubs, invite members, set reading schedule
2. **Reading Tracker** — mark progress by chapter/page, see who's caught up
3. **Passage Tagging** — highlight text, add notes, tag for discussion ("let's talk about this")
4. **Discussion Prep** — AI generates questions per chapter based on tagged passages
5. **Catch-Up Summaries** — fell behind? AI summarizes what you missed with key themes
6. **Book Recommendations** — AI suggests next reads based on club's taste
7. **Meeting Scheduler** — set next meeting, RSVP, agenda from tagged passages
8. **GoodReads Sync** — import shelves, ratings, reviews

## Ground Rules

1. **Brainstorm tools preferred** — use `storm --lfg` and `brainstorm run --tools` as much as possible. When Brainstorm can't do something, do it directly and journal WHY it couldn't.
2. **BrainstormRouter for all AI** — every LLM call routes through BR
3. **Fix forward** — when Brainstorm breaks, fix it, push, rebuild, journal, continue
4. **Journal everything** — bugs, model behaviors, routing decisions, workarounds
5. **Recursive improvement** — after every phase, review the code, then add a new improvement phase
6. **Ask Justin when stuck** — don't guess on UX decisions for his wife's book club
7. **Perfection is the goal** — this should be as good as anything Claude Code could build
8. **Research first** — study existing book club apps (Bookclubz, Fable, Literati) before building

## Execution Protocol

1. **Find actionable phase**: Read this plan. Find the first phase not marked ✅.
2. **Build**: Use `storm --lfg` or `brainstorm run --tools` where possible. Direct coding allowed when Brainstorm can't handle it — but journal why.
3. **When Brainstorm breaks**: Switch to brainstorm repo, fix the bug, push, rebuild CLI, journal in `~/Projects/hawktalk/docs/bug-journal.md`, switch back.
4. **After each phase completes**: Mark it ✅, then:
   a. Code review the work (use /code-review:code-review skill if there's a PR, otherwise self-review)
   b. Journal: bugs found, models used, costs, time in `~/Projects/hawktalk/docs/build-journal.md`
   c. Append a NEW improvement phase at the bottom of this plan based on review findings
   d. Ask Justin to `/compact` if context is getting long
5. **Continue**: Immediately start the next phase. Never stop to ask unless it's a UX decision.
6. **Research phases**: Use web search, read competitor apps, study APIs before building

## Hard Limits

| Limit | Value |
|-------|-------|
| Max wall clock per phase | 30 minutes |
| Build failure retries | 2 attempts, then journal and skip |
| /loop duration | 7 days |
| Stop condition | Justin says stop, or /loop expires |

---

## Phase 0: Stabilize Brainstorm Chat + Vault

**Status**: ✅ (vault set up, password masking fixed, provider resolution fixed)

---

## Phase 1: Research — Book Club App Landscape

**Status**: ✅ Complete

**Objective**: Understand what exists, what works, what's missing. Design HawkTalk to be better.

**Tasks**:
- Research top book club apps: Bookclubz, Fable, Literati, Libro.fm clubs, The StoryGraph
- Research GoodReads API (or lack thereof — may need scraping)
- Research Open Library API, Google Books API
- Research passage highlighting/annotation UX patterns (Kindle highlights, Readwise, Hypothesis)
- Study: what do real book club members actually need? (Reddit r/bookclub, forums)
- Document findings in `~/Projects/hawktalk/docs/research.md`
- Create initial feature priority list based on research

**Verify**: research.md has competitor analysis, API options, and feature priorities.

---

## Phase 2: Project Setup + Private GitHub Repo

**Status**: ✅ Complete (landing page via Brainstorm CLI, Vercel deployed, 5 Brainstorm bugs fixed)

**Objective**: Scaffold HawkTalk as a Vercel Next.js app with PostgreSQL.

**Tasks**:
- `mkdir -p ~/Projects/hawktalk && cd ~/Projects/hawktalk`
- `git init && gh repo create justinjilg/hawktalk --private --source=. --push`
- Initialize Next.js 16 project with TypeScript, Tailwind, shadcn/ui
- Set up Vercel project: `vercel link`
- Set up Neon PostgreSQL via Vercel Marketplace
- Set up Clerk auth via Vercel Marketplace
- Create BRAINSTORM.md for the project
- Create `docs/bug-journal.md`, `docs/build-journal.md`, `docs/model-journal.md`
- Deploy initial "Coming Soon" page to Vercel

**Verify**: Vercel deployment live. PostgreSQL connected. Clerk auth working.

---

## Phase 3: Database Schema + API Foundation

**Status**: Not started

**Objective**: PostgreSQL schema for books, clubs, members, passages, discussions.

**Tasks**:
- Drizzle ORM setup with Neon PostgreSQL
- Schema: users, clubs, club_members, books, club_books, reading_progress, passages (tagged highlights), discussions, discussion_comments
- Migration system
- Seed data: 10 popular book club books, sample club "Fishhawk Readers"
- API routes: CRUD for clubs, books, members

**Verify**: Migrations run. Seed data loads. API routes return JSON.

---

## Phase 4: Core UI — Landing + Auth + Club Dashboard

**Status**: Not started

**Objective**: Users can sign up, create/join a club, see the dashboard.

**Tasks**:
- Landing page: hero, features, CTA "Start Your Book Club"
- Clerk auth: sign up, sign in, profile
- Club dashboard: current book, reading progress of members, upcoming meeting
- Club creation: name, description, invite link
- Club discovery: browse public clubs (Fishhawk community)
- Mobile-responsive from day 1

**Verify**: Can sign up, create club, see dashboard on mobile browser.

---

## Phase 5: Book Management + Reading Progress

**Status**: Not started

**Objective**: Add books to club, track reading progress.

**Tasks**:
- Book search (Open Library API / Google Books API)
- Add book to club reading list
- Set reading schedule (chapters per week)
- Mark reading progress (chapter/page)
- Progress visualization: who's caught up, who's behind
- Book detail page: cover, description, author, club activity

**Verify**: Can search, add book, track progress, see club members' progress.

---

## Phase 6: Passage Tagging — The Killer Feature

**Status**: Not started

**Objective**: Highlight and tag passages for discussion.

**Tasks**:
- Passage creation: enter text (typed or pasted from ebook), page number, chapter
- Tag system: "discuss this", "favorite quote", "confused", "disagree", custom tags
- Passage feed per book per club: see everyone's highlights
- Filter by chapter, by member, by tag
- Discussion thread per passage: comment on someone's highlight
- Mobile-optimized: quick-add passage while reading

**Verify**: Can add passages, see others' passages, comment on them. Works on phone.

---

## Phase 7: AI Features — Discussion Prep + Summaries

**Status**: Not started

**Objective**: AI that helps the book club prepare for meetings.

**Tasks**:
- API: Generate discussion questions from tagged passages + book context
- API: "Catch me up" — summarize chapters you haven't read yet based on club's passages
- API: Theme analysis — what themes is the club highlighting most?
- API: Book recommendations based on club's reading history and ratings
- All AI routes through BrainstormRouter
- Test with multiple models: cheap for summaries, quality for nuanced analysis
- Show which model generated each response (transparency)

**Verify**: Discussion questions are insightful. Summaries are accurate. Recommendations are relevant.

---

## Phase 8: Meeting Management

**Status**: Not started

**Objective**: Schedule meetings, generate agendas from tagged passages.

**Tasks**:
- Meeting scheduler: date, time, location (in-person or virtual)
- RSVP system
- Auto-generated agenda from most-tagged passages since last meeting
- Meeting notes: capture discussion highlights
- Post-meeting: rate the book, vote on next book

**Verify**: Can schedule, RSVP, see agenda, take notes, vote.

---

## Phase 9: Integrations — GoodReads + External

**Status**: Not started

**Objective**: Connect HawkTalk to the broader reading ecosystem.

**Tasks**:
- GoodReads import (web scraping since API is restricted)
- Google Books API for metadata and covers
- Open Library API for free book data
- Share to social: "Our club is reading X"
- Export reading list to GoodReads format

**Verify**: Can import GoodReads shelf. Book metadata auto-populates.

---

## Phase 10: Mobile App (React Native / Expo)

**Status**: Not started

**Objective**: Native mobile experience for tagging passages while reading.

**Tasks**:
- Research: Expo vs React Native CLI
- Scaffold mobile app
- Shared API with web app
- Core screens: Club dashboard, Book view, Add passage, Discussion feed
- Push notifications: new passages, meeting reminders, discussion replies
- Offline support: cache recent book/passages for reading without connection

**Verify**: App runs on iOS simulator. Core flows work. Push notifications fire.

---

## Phase 11: Design Polish + Fishhawk Customization

**Status**: Not started

**Objective**: Make it beautiful and personal for the Fishhawk community.

**Tasks**:
- Professional design system: typography, colors, spacing
- Book cover gallery views
- Reading streak / gamification
- Club themes (Fishhawk Readers gets a custom theme)
- Onboarding flow for non-technical book club members
- Accessibility: screen reader, high contrast, font size

**Verify**: Non-technical person can sign up, join club, add a passage in under 2 minutes.

---

## Phase 12: Brainstorm Stress Test + Multi-Model Workflows

**Status**: Not started

**Objective**: Push Brainstorm to the limit building advanced HawkTalk features.

**Tasks**:
- Use `brainstorm workflow run implement-feature` for a complex feature
- Spawn parallel subagents to build multiple components
- Test context compaction during long sessions
- Run /dream to consolidate memories
- Run `brainstorm eval --all-models` on HawkTalk codebase
- Journal model performance data extensively

**Verify**: Workflow produces working code. Eval scorecard generated. Journal complete.

---

## Phase 13: Documentation + Final Review

**Status**: Not started

**Objective**: Ship-quality documentation and honest Brainstorm assessment.

**Tasks**:
- HawkTalk README with screenshots, architecture, setup guide
- docs/bug-journal.md — every Brainstorm bug found and fixed
- docs/build-journal.md — the build story, decisions made, time/cost
- docs/model-journal.md — which models work for what
- docs/brainstorm-vs-claude-code.md — honest comparison from building a real app
- Final Brainstorm eval with all findings fed back

**Verify**: A stranger could clone and deploy HawkTalk. Brainstorm docs are honest and useful.

---

<!-- NEW PHASES GET APPENDED BELOW THIS LINE -->
<!-- After each phase completes, the review findings generate a new improvement phase here -->
