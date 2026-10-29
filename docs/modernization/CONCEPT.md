# Concept — AiDM modernization cycle 4

## Problem

AiDM already offers broad download coverage, but its next constraint is not feature count. Untrusted browser/renderer data crosses privileged boundaries, some core flows are not keyboard- or failure-friendly, and the current machine cannot produce a green test/build baseline. Users need a download manager that is safe, understandable, and dependable under real browsing and failure conditions.

## Target users

Windows users who capture files and media from browsers, manage queues and schedules, and expect downloads to resume and complete without understanding engine internals.

## Core jobs

1. Add or capture a download, choose the right media/quality, and control where it goes.
2. Monitor, pause, resume, retry, and locate completed files with accurate status.
3. Configure browser integration, bandwidth, schedules, post-processing, and credentials safely.
4. Recover from dead links, authentication requirements, disk failures, and interrupted state.

## Success metrics

- No open P0/P1 findings in the verified release scope.
- Full suite runs without fail-fast omissions; previously untested behavior gains regression coverage.
- Windows installer builds and its packaged contents are verified.
- Add/capture, quality selection, filtering/sorting, settings, and error recovery are usable keyboard-only with clear loading/empty/error states.
- No known npm vulnerabilities at release check; no credential fields exposed through renderer reads or exported/persisted rows.

## Constraints

- Preserve the Electron + vanilla JavaScript architecture and existing download engine; no framework or engine rewrite.
- Windows-first, with the Chrome extension treated as part of the same product.
- Small vertical slices, security fixes before features, existing visual identity refined rather than replaced.
- No production publish, push, installer replacement, credential access, or termination of the running installed app without separate approval.

## Explicit non-goals

- New download providers, captcha bypass, link-container support, or an engine rewrite.
- Cross-platform packaging, localization, queue-model restructuring, or broad module splitting in this cycle.
- Dependency majors merely because newer versions exist.

## Riskiest assumptions

1. Security, reliability, and accessibility should take precedence over adding another feature in this cycle.
2. A Fluent-inspired refinement of the current blue, light/dark desktop UI is preferable to a brand-level redesign.
3. Existing installed AiDM processes and user data remain untouched; offscreen/mocked UI and local test fixtures are acceptable until a separate live-test handoff.
