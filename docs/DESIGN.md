# Ajo: the shared ledger

## Audit before implementation — 1 October 2026

The product is a shared record for Nigerian rotating savings groups. Members need to know their obligation, whether payment is confirmed, and whose turn is next. Administrators also coordinate membership, account approvals, bank reconciliation and manual payouts. Trust and control matter more than novelty. The primary conversion is successful, understood task completion, not marketing clicks.

The application is one server-rendered HTML shell with browser JavaScript, CSS, an Express API and PostgreSQL/Prisma. Its three views are authentication, the group directory and a group workspace. Account recovery uses fragment tokens. Payment checkout leaves the application and returns through a query parameter. There is no frontend framework, image library or existing illustration asset to retain. The backend already enforces financial invariants and must stay authoritative.

### Findings

- Every group section is visible at once, mixing frequent member tasks with infrequent administration. Payout receipt confirmation can be buried below other panels on phones.
- The directory uses identical large cards, foregrounding a potentially misleading estimated balance instead of group identity and state. It has no search or status filter.
- Four boxed metrics compete equally. Guidance is an undifferentiated paragraph. The current member's next action is not explicitly explained.
- Rotation communicates order but not the current cycle's position. Moving a recipient replaces the focused DOM element; keyboard focus is lost.
- The financial record prints raw audit JSON, and has neither a search control nor contextual empty states.
- Tabs are styled buttons without tab semantics, arrow-key navigation or linked panels. The dialog has no accessible name. Several controls are smaller than a comfortable touch target. Metadata is often 10–11px.
- Authentication takes substantial vertical space before the form on small phones. All account actions are permanently exposed. Password visibility cannot be toggled.
- Initial session lookup produces a blank content area. Submissions disable buttons without showing progress. Network failure has no local retry action. Success can be announced outside an open modal where it is not discoverable.
- Navigation does not survive reload or support browser back between groups. Loading another group briefly leaves old data visible.
- Rounded white containers dominate the layout. Border, number and spacing hierarchies are weak, although the existing forest/paper palette provides a useful starting point.
- Performance is a strength: small static assets and no runtime framework. Preserve this. Do not introduce remote fonts, decorative images, cursor tracking or scroll handlers.

### Preserved contracts

Authentication, CSRF, email verification/recovery, create/join, fixed membership cycles, bank approvals, payout ordering, payment idempotency, payment verification, ledger exports, recipient confirmation/disputes, financial review, bank attestations, member removal, admin transfer and archive remain connected to their existing API endpoints. Money and permission decisions remain on the server. Estimated ledger funds must never be described as verified bank funds.

## Direction and system

Two signatures: a joined circular mark representing a rotating group, and numbered, ruled ledger rows that connect group discovery, contribution obligations and payout order. The interface should feel like an accountable shared record rather than a generic finance dashboard.

- Paper surfaces, evergreen ink, a restrained ochre accent for the active turn. Red and amber only for destructive or unresolved states.
- Editorial serif headings; familiar system sans for tasks; tabular numbers for money; monospaced references. No external font requests.
- A 4px spacing rhythm, bounded reading width, predominantly square surfaces with 4–8px control corners. Rules separate information; cards only when a distinct task warrants a surface.
- Desktop: broad ledger directory, financial summary strip, two-column round workspace. Tablet: tighter columns and recomposed summary. Phone: compact header, direct access to authentication, touch-sized controls, naturally scrolling content and a sheet-style dialog.
- Three workspace tabs: This round, Ledger, Group details. Put a state-aware next step above the round's obligations. Group settings and secondary administration live in details.
- 120ms control feedback, 180ms state changes, 240ms dialog entrance. Animate opacity and small transforms only; no blocking exits, number counters or scroll hijacking. Reduced motion removes movement.
- Semantic landmarks, native forms/dialog/details, complete tab semantics, visible focus, polite state announcements, meaningful progress and explicit error recovery.

## Verification contract

Test the real HTML/CSS/JS under the application's security headers, with deterministic API fixtures for visual and interaction coverage. Test backend accounting separately with the existing PostgreSQL suite. Browser fixtures are synthetic and never presented in the product as real usage statistics. Cover small/large phone, tablet, laptop, desktop and wide displays; authentication and recovery; directory empty/search/error; every workspace tab; each financial state; dialogs; keyboard and reduced motion. Include automated accessibility checks, console-error checks and page-overflow checks. Inspect screenshots in addition to assertions.

## Verification results

25 Chromium browser checks pass across 320, 390, 768, 1024, 1440 and 1920px layouts. Automated WCAG A/AA checks report no violations in the tested authentication, group states, ledger and dialog screens. Keyboard tab navigation, focus restoration, browser back/reload, search, retry, payment handoff and reduced motion are covered. The 11 domain/provider/migration tests pass; production dependency audit reports zero known vulnerabilities. CI additionally runs the PostgreSQL integration suite.

Visual inspection found and corrected small-phone currency wrapping, long-name overflow and a missing space when the login heading recomposed on mobile. The next task now appears before the balance summary. No runtime dependencies, external fonts or image requests were added beyond the local SVG mark. The HTML, CSS, JavaScript and mark together remain under 100 KB uncompressed. This is an asset-size check, not a claim of measured field Core Web Vitals.

Screenshots below use synthetic browser fixtures, not customer accounts or real balances.

- [Desktop round workspace](previews/round-desktop.png)
- [Mobile login](previews/login-mobile.png)
