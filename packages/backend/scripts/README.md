# Hanami metrics (HM-IMPLEMENT)

## Implementation and verification status

P1–P4 are implemented: management is now at **`/admin/hanami`**, with seven tabs,
summary/breakdown/errors, improvement candidates, what-if, top reacted notes and
five REST timeline counters. Trends and operations intentionally remain P6
placeholders. P5–P7 settings changes are not included. Existing settings were moved
out of Performance, not removed. The complete P1 gate passed before P2 work began.

The continuation reused the existing verification database and running local
server: **no new database, server deployment, or service restart was performed**.
Backend source/test/federation types and 75 Hanami suites (979 tests, including the
existing PostgreSQL contracts) pass. SDK types and frontend types pass; frontend
Hanami units pass. Real-DB P1/P3/P4 numerical checks and API authorization pass.

**Visual acceptance remains open, for a different reason after reinvestigation.**
The original `APP_IMPORT` failure was a verification-procedure error: raw Vite
output had omitted the normal `LocaleInliner` post-build step. Running the existing
inliner into the scratch output produced all 408 Japanese chunks with zero
localization warnings and resolved the missing `/vite/ja-JP/…js` resource. No
application routing or build-framework change was needed.

Reinvestigation also fixed the new judge SearchMarker's static label expression,
an invalid day locale key in overview, and an undefined share-bar CSS class. Final
frontend verification, including the GPU trial condition, is **9 files / 139 tests
passed, vue-tsc passed**. Existing unrelated CSS/search-label/chunk-size build
warnings remain; the new Hanami-specific warnings are gone.

The browser subsequently loaded the page's summary/breakdown/errors responses
without recorded runtime exceptions or metrics API failures, but CDP
`Runtime.evaluate` timed out. The single retry also timed out (including its
debugger diagnostic), so all seven tabs have **not** been visually accepted. This
does not yet distinguish a renderer stall from a browser-automation problem.
The old startup-error image is not evidence of a successful screen. Evidence is
in `browser-diagnostics.json` in the existing scratch directory. No additional DB,
deployment or service restart was used; a representative-scale benchmark remains
unperformed.

The original `hanami-foryou-review.mjs` legacy per-user mode remains available.
The new anonymous comparison mode is:

```sh
node scripts/hanami-foryou-review.mjs --metrics --from YYYY-MM-DD --to YYYY-MM-DD --json
```

`DATABASE_URL`/standard PostgreSQL environment variables select the connection.
Never publish legacy per-user output or credentials.

## Approved definition amendments

- Engagement is **reaction + reply + renote**, independently DISTINCT/0-or-1 per
  served record and type. Reaction plus reply counts **two**, not a union of one.
  This supersedes the ambiguous union wording in the 2026-09-20 specification.
- A served cohort uses the immutable original `createdAt`, not the mutable latest
  `occurredAt` maintained for provenance lookback. Outcomes use
  `COALESCE(occurredAt, createdAt)` in the inclusive 336-hour window after serving.
- Exact period users and cross-dimension filters use restricted internal facts,
  never a sum of daily unique counts. The daily aggregate has no identifiers.
- All day labels and date boundaries are JST. The ordinary Misskey chart API is
  explicitly UTC; the supplementary timeline counters are authoritative for JST.
- Low-user rows (1–4 served users) are omitted with `suppressed` keys. Shares and
  lift use **visible-row denominators**, reported as `denominator: "visible"`, to
  avoid recovering a suppressed cell by subtraction. Counts/rates that would
  disclose small cells are null. This conservative change applies to the
  independent review comparator as well.
- Missing history/instrumentation is not observed zero. `coverage` and nullable
  values distinguish unavailable history; only covered empty days are zero-filled.
  Initial migration backfill copies remaining observations and does not backdate
  production coverage. Diagnostic snapshots describe a specific current inventory,
  not reconstructed historical selection decisions.
- Errors expose fixed identifier-free messages. Daily HMAC buckets require a
  persistent `HANAMI_METRICS_SALT` secret; without it recent personal errors are
  unavailable. Do not rotate the master secret daily: the HMAC derives daily keys.
  Personal error cohorts and failure kinds also require at least five users.

## Private supplementary storage

`hanami_metrics_event`, `hanami_metrics_judgement`, `hanami_metrics_refresh`,
`hanami_metrics_timeline`, `hanami_metrics_page`, and `hanami_metrics_candidate`
are internal, have PUBLIC access revoked, and are never
exposed by an event-level API. Grant access only to the application/migration
database role. User/note foreign keys cascade on erasure. No note text is copied.
Triggers capture observations before existing short-lived source cleanup, and
do not modify the source's retention or recommendation policy.

Internal identifying facts expire after **105 days** (90-day requests plus the
14-day attribution window and finalization margin). The daily job finalizes
yesterday plus the preceding fourteen days before pruning. Anonymous aggregate
snapshots can remain. Chart uniqueness arrays are temporary, internal and never
returned; metrics retention also clears old arrays after long cleaner outages.
The existing chart framework buffers UTC updates. Supplemental JST request writes
are awaited without the former pending-write drop limit. A failed write remains
nonfatal to serving; the collector persists uncertainty as a gap. Unclosed or
stale collector sessions prevent incomplete historical counts from being reported
as exact. Current-day values are explicitly provisional. Anonymous-only timeline
cells are suppressed and excluded from the visible request-share denominator.

Exact arbitrary-range unique users, cross-dimension filters and percentiles are
computed from the retained internal facts rather than incorrectly adding daily
unique counts or averaging daily percentiles. Daily rollups remain durable and
identifier-free. This is the approved supplementary-storage amendment to the
original aggregate-only design. What-if counts unique served exploration notes
with the current prompt's judgement, not a replay of every serving eligibility
rule. Judge aggregate's optional cohort uses that same definition. Hidden-cost
rates use captured candidate opportunities; unavailable normal-TL exposure
denominators are explicitly flagged, never fabricated. Historical capture gaps
and still-open 14-day outcome windows are also flagged.

Deploy only after complete acceptance: migration → restart backend →
`hanami:metrics-rollup --from <14 days ago> [--to <yesterday>]` → verify APIs and
the completed management page. Backfill does not run generation or seed jobs.
The isolated metrics CLI deliberately avoids the ordinary CoreModule lifecycle.

## Reusing the existing verification fixture

`hanami-metrics-verify.mjs` is intentionally restricted to loopback PostgreSQL,
database `hanami_contract_test`, and dedicated schema `hm_metrics_gate`. It refuses
to overwrite an existing schema. It loads credentials in memory, never accepts an
arbitrary write-target URL, and writes private configuration only into the approved
scratch directory. Fixtures are **synthetic, not a production backfill**.

The owner ran it using a scratch SWC loader (no build outputs in the repository):

```sh
node --loader /tmp/hanami-metrics-verification/loader.mjs scripts/hanami-metrics-verify.mjs --setup
node --loader /tmp/hanami-metrics-verification/loader.mjs scripts/hanami-metrics-verify.mjs --cli --verify
node --loader /tmp/hanami-metrics-verification/loader.mjs scripts/hanami-metrics-verify.mjs --units
node --loader /tmp/hanami-metrics-verification/loader.mjs scripts/hanami-metrics-verify.mjs --insights-migrate --p3
```

The `--units` command enables existing DB contract suites only against the existing
database; each uses a private disposable schema. Never point it at `misskey`.
The optional dedicated Redis process is on loopback port 56313 without persistence.
The continuation did **not** run `--setup` or start Redis. `--insights-migrate`
applies the second migration transactionally only when it is not already present;
`--p3` reuses the existing synthetic fixture. It exercises real capture, savepoint
recovery after a FK failure, page-weighted demand, allocation parity, what-if
monotonicity, visibility rechecks, five chart kinds, failed-write gap suppression,
and HTTP 401/403/200 guards. Configuration/secrets stay in memory or existing
private scratch files, never in source or reports.

## Caller/invariant audit

| Changed/new functions | Callers and invariant |
| --- | --- |
| Migration `up/down`; SQL `hanami_metrics_locator`, `hanami_metrics_capture_event`, event/judgement/refresh trigger functions | Migration runner and source-table writes. Source identities and transaction atomicity are retained; new archival writes participate in the same transaction. No source deletion trigger resurrects archived data. Erasure cascades, while ordinary source TTL deletion does not remove the archive. |
| `classifyHanamiMetricsFailure` | `runUserFeedGeneration` → `resolveFailure`. Classification does not decide lease ownership or retry eligibility. Safe persisted messages never echo input. |
| `runUserFeedGeneration`, `resolveFailure`, `publishBatch`, `reconcileBatch` | Generation lifecycle processor/reconciler. Existing user→state→epoch→batch→refresh lock order, claim/CAS predicates, deadlines, stale outcomes and retry limits remain. Failure metadata is written under the same guards and cleared on publication. |
| Generation processor `process` | Queue dispatcher. Delegates lifecycle exactly as before; only adds classified-kind logging. |
| Request service constructor/`requestRefresh` | Timeline request port. Existing refresh transaction, idempotency and rate decision are unchanged; Redis instrumentation is optional and failure-isolated, after the decision for increments. |
| `jstDay`, `assertMetricsDay`, `shiftMetricsDay`, `resolveRange`, `rangeDays`, `rangeParameters` | Rollup/query and diagnostics. Strict real calendar labels, inclusive bounded date ranges, explicit JST boundaries. |
| `metricRatio`, `isSuppressed`, `metricsCohortSql`, `metricsGenerationSql` | Rollup/query. Null zero-denominator ratios, 1–4-user suppression, exact distinct users, per-type binary outcomes, immutable served dates, exact generation percentiles. |
| Rollup constructor, `rollupDay`, `rollupRecent`, `replace` | Isolated CLI/system processor. Recalculation is idempotent; per-dimension advisory-lock transactions retain raw small cells without one enormous day transaction. Finalization includes the fifteenth, now-closed cohort day. |
| Query `summary/breakdown/errors/stats`, `coverage/windowCovered/rateLimited`; presenters and sanitizers | Admin endpoints. Exact internal counts, explicit missing data, conservative suppression and fixed safe messages. `stats` projects anonymous weekly-only content and clones its 60-second cache. HMAC helper derives daily keys without an unsafe default. |
| `diagnosticAxisLevel`, `diagnoseHanamiDiscovery`, diagnostics `capture/query` | Rollup processor, insights and page capture. Existing axis compatibility and discovery selector reused. Snapshots are current-day-only, have viewer-pair units/limitations, and suppress small reason cohorts; serving algorithms are unchanged. |
| Retention `prune` | Metrics processor after finalization. Bounded retention for identifying facts; chart arrays cleared after catch-up outages. Anonymous daily history remains. |
| `parseHanamiMetricsRollupArgs`, command `run`, metrics module resource factories/shutdown, CLI dispatch | `hanami:metrics-rollup` and pure parser tests. Inclusive max90 sequential days; no CoreModule startup jobs; dedicated context resources closed. Existing seed/reset/ping commands retained. |
| Queue scheduler initialization/dispatch and metrics processor `process` | Normal worker startup/system queue. New job uses explicit Asia/Tokyo; existing schedules remain unchanged. |
| Hanami chart `hit/writeJstCounter/warn/tickMajor/tickMinor`; chart-manager constructor; cleaner `process` | Five REST endpoints/chart lifecycle. Exactly one hook per successful response branch; no stream hooks, no synthetic anonymous user. Existing UTC buffered chart behavior remains. JST writes are awaited; write failures preserve serving and mark coverage gaps. `warn` excludes driver errors/identifiers. |
| Home/local/hybrid/global/Hanami endpoint executors | Existing REST clients. Existing query, packing, eligibility, error and return shape behavior preserved; success hooks added including empty pages. |
| Metrics endpoint constructors/executors and schema helpers (`queryRange`, `metricsQuery`); chart endpoint | ApiCallService. Existing real credential/admin/scope guard applies; invalid ranges map to INVALID_PARAM. Explicit schemas exclude identifiers except approved error buckets. |
| Judge-status executor | Existing admin UI/SDK. Default cached runtime probing preserved; optional force forwards to the existing force-capable runtime helper. |
| Review `parseMetricsArgs/buildMetricsQuery/summarizeMetrics/main` | Existing script users and isolated verifier. Default legacy per-user mode preserved; opt-in metrics mode uses independently written EXISTS SQL with matching cohorts/privacy denominators. |
| Existing test constraint helpers/mock constructors/DB fixture setup | Existing unit/DB tests. Assertions remain; fixtures now include the added columns and intentionally consume/age heads when testing generation rather than unserved-head reuse. Invalid promise-matcher usage corrected. Production ApiCallService remains untouched. |

| Computation `computePersonalFeed/computeWithRunner/applyJudgeSelection`; `createHanamiMetricsCandidateRows` | Generation's computation port. Selection still uses the same safety, seen, direct-follow and media exemptions. A separate immutable trace records actual hidden branches and selected primary sources; it never enters public reason metadata. |
| Capture `recordCandidates`; generation `publishBatch` metrics branch | Guarded publication after batch/state/refresh CAS succeeds. Serial savepoints isolate ordinary capture INSERT failures; failed transaction recovery still propagates. Candidate diagnostics are excluded from checksums. Real DB tests cover successful publication, FK failure recovery, stale claims and checksum equality. |
| Page service `record` | Successful Hanami REST endpoint. Captures actual packed page locators, effective axes and zero-source counts. Incomplete provenance creates a coverage gap rather than fabricated demand; no serving-policy changes. |
| Health `onModuleInit/initialize`, `begin/finish/markFailed`, `heartbeat/flush`, `onApplicationShutdown` | Nest lifecycle, chart/page/generation capture and 30-second heartbeat. Registration precedes serving. In-flight days, failures arriving during commits and stale sessions remain fail-closed. Shutdown cannot certify pending writes. No counter retry duplicates requests. |
| Insights `allocationVerdict/suggestedCaps`, `contentType/engaged/shortRange/thresholds` | Insights service. Exact 1.3/0.7 boundaries, 0.05-grid caps totaling at most one per confidence, per-type additive outcomes, bounded 30-day what-if/notes and maximum eight thresholds. |
| Insights `opportunities`, `whatIf`, `notes`, `captureState/captureUnavailable`, cache helpers | Three admin endpoints; `judge-aggregate` calls what-if for the optional cohort. Allocation reuses breakdown denominators; notes require served≥20 and users≥5, rank deterministically, and recheck visibility even on cache hits. Missing/provisional cohorts are labeled. No auto-application of suggested caps. |
| Judge-aggregate executor; judge-status executor | Existing admin UI and SDK. Aggregate's default 24-hour fields remain; the optional served cohort adds comparable counts. Status retains cached probing by default; force explicitly bypasses cache and adds candidate/backlog/timing fields. |
| Chart endpoint executor and its `visible` projection | ApiCallService/admin SDK. Ten UTC series remain; populated bins below five users become null, while genuinely empty bins remain zero. SDK chart arrays were synchronized to `(number \| null)[]`. |
| Frontend `finiteMetric/metricRatio/formatMetric/metricDifference/sumMetrics/shareWidth/isMetricSuppressed/safeUserBucket/sourceLabel`, `useMetricsResource/reload` | Overview, stats and share-bar component. Unknowns stay unknown, response values are safely displayed, only bar geometry clamps; request cancellation/latest-result guards prevent stale updates. |
| Series chart `seriesValues/draw`, prop/theme watchers and unmount callback; share-bar computed projection | Overview/stats consumers. Nulls remain chart gaps, old Chart.js instances are destroyed, displayed ratios do not change additive engagement semantics. |
| Overview `params/fmt/display/axisLabel/errorCount` and computed cards/coverage/shares/errors; stats parameter/selection/reset watchers and projections | Seven-tab page mounting, selectors and table links. UI preserves server suppression/coverage; notes use the supported dimension/key filter and do not imply unsupported secondary filtering. |
| Judge `judgeSettingsToForm/judgeFormToSettings/judgePromptChanged/judgeRegexRows/judgeFormValid/judgeTrialAvailable/judgeSecondsPerNote/judgeRejudgeEstimate/createJudgeDebounce` | Judge form and tests. Copies drafts, maintains one examples list, validates server-compatible regex, confirms only prompt-affecting fields, requires an available CUDA GPU for interactive trial, and debounces 600ms. Missing estimates never become zero. |
| Judge `loadSettings/refreshStatus/refreshAggregate/saveSettings/runTrial/invalidateWhatIf/refreshWhatIf/stockDelta`, form save callback and lifecycle/watch callbacks | Mount, form footer, status/trial buttons, sliders. Cancelled/unmounted confirmation cannot save; saved prompt/bonus changes invalidate previous what-if results; late responses cannot overwrite newer ones. Hidden-count totals are not presented as complete when capture is missing/suppressed. |
| Axes `shareText/judgePolicy/axisCfgValue/save`, form save callback | Axis cards and save button. Caps are read-only P2 snapshots; saves retain unrelated/legacy config and materialize effective seven-axis values. No P5 policy/configuration expansion. |
| Taste `formatTasteRebuildTime/clearPolling/syncTasteRebuildPolling/refreshTasteRebuildStatus/startTasteRebuild`, lifecycle callbacks | Relocated taste tab/buttons and timer. Existing rebuild API preserved, confirmation precedes work, duplicate starts prevented, timers cleared after unmount. |
| Verifier top-level branches and HTTP identity adapters | Explicit manual verification commands only. Existing synthetic DB/schema allowlist retained, migration transactions added, API authorization still executed through actual ApiCallService. No production writes or schema setup in the continuation. |

Source and tests are verified as recorded; seven-tab visual acceptance and a
representative-scale performance measurement remain unverified. The full command
results and Japanese worker ledger are in the owner's existing scratch checkpoint.

## R1 read-path verification (2026-09-20, including approved §7)

This section supersedes the performance-unverified statement above for the R1
read path only. **R1 is not fully accepted:** the current-day unfiltered breakdown
misses its 100 ms target, and one unchanged API-test storage mock needs approval
to be updated. Backend/test TypeScript checks remain an Integrator handoff.

### Implemented read/cache contract

- Historical summary engagement and unfiltered breakdown counts read
  `hanami_metrics_daily`; the seven eligible dimensions exclude `trendTerm`.
  Daily `total` rows supply summary counts and its engagement series. Failed-batch
  series uses the existing `scope='generation', dimension='personal'` rows' `extra`
  (there is no persisted generation `total` row).
- Range users remain exact served-only DISTINCT counts, not sums of daily users.
  Pre-grouping dimension/user pairs avoids sorting all 300,000 served rows.
  Summary shares one served-only scan for range/source users and independently
  anchored day/week/month windows, including windows preceding a short range.
- Today is excluded from daily reads even if manually rolled up. One today-only
  source cohort supplies all summary outcome counts; breakdown uses one cohort
  for its requested dimension. Bounds are JST midnight to next JST midnight.
- Filtered breakdown, all `trendTerm` breakdowns, errors, opportunities and
  what-if use worker-local 60-second caches with normalized argument keys and
  defensive `structuredClone`. What-if settings may remain stale for that TTL.
  Notes caches only aggregates and retains live text/visibility/author/target
  safety checks on every request with cached candidates, per approved §7.
- Response schemas, authorization, frontend, daily schema/rollup, migrations,
  per-type 0/1 outcomes, 336-hour attribution and coverage semantics are unchanged.
  Optional outcomes-column work (C) was not adopted.

### Local transactional performance measurement

Environment: local production-dump database `misskey`, PostgreSQL 18.4,
`work_mem=4MB`, existing migrations applied. The §4 fixture used 800 local users,
20,000 existing notes, 300,000 served events, 18,000 outcomes and 150,000 seen
events over 90 days/seven axes. Triggers were disabled only inside the transaction;
`ANALYZE hanami_metrics_event` preceded measurement. Existing `rollupDay()` ran for
the preceding 90 days (32,735.95 ms). Its per-scope transactions used SAVEPOINTs
on the outer transaction's connection, so no daily or fixture writes were committed.

Times below are individual awaited service calls (not HTTP/network timings),
after rollup, measured with `performance.now()`. A single PostgreSQL connection
kept every read in the same uncommitted fixture transaction; Promise.all SQL was
therefore serialized. Summary and unfiltered breakdown were not response-cached.
The filtered cache measurement immediately repeated identical arguments.

| Range | summary (<200 ms) | breakdown source (<100 ms) | source + media=image first (<4,000 ms) | Same filtered request cached (<10 ms) |
| --- | ---: | ---: | ---: | ---: |
| 2026-06-22–2026-09-19 | 143.18 PASS | 83.92 PASS | 1,409.52 PASS | 0.10 PASS |
| 2026-06-23–2026-09-20, including today | 179.47 PASS | **127.99 FAIL** | 1,482.86 PASS | 0.18 PASS |

SQL-call logging confirmed zero LATERAL queries for historical summary/breakdown.
Each current-day call issued exactly one cohort LATERAL query, bounded to
`2026-09-20T00:00:00+09:00`–`2026-09-21T00:00:00+09:00`. Filtered cache hits executed
zero DB queries. Live SQL comparisons passed for source counts/users, total
counts/users, and the shared usage windows against independent original DISTINCT
queries. Both ranges matched the original cohort counts, including today's supplement.
Every fixture run ended with **ROLLBACK complete**; no fixtures/rollups/triggers
were committed. No production service, Redis, generation job or schema migration ran.

The retained scratch harness and existing SWC loader were invoked as follows
(credentials are loaded only in memory, not embedded in this document):

```sh
# From packages/backend; explicit local misskey guard and fixture prerequisite checks.
node --loader /tmp/hanami-metrics-verification/loader.mjs /tmp/opencode/hanami-r1-benchmark.mjs
node --loader /tmp/hanami-metrics-verification/loader.mjs /tmp/opencode/hanami-r1-benchmark.mjs --run
```

The scratch harness follows §4 in `hanami-metrics-fix-r1-codex-20260920.md`, calls
the existing rollup/query services directly and always rolls back in `finally`.
It is a local verification artifact, not a deployed script. The initial direct
DISTINCT implementation measured 389.38/217.72 ms (historical summary/breakdown)
and 546.64/267.46 ms (today included). EXPLAIN identified an external merge sort
over served rows; exact pre-deduplication and shared summary queries produced the
final figures above. Today's breakdown still spends about 85 ms on exact users
and another 42 ms on its raw supplement in this single-connection measurement.

### Tests and outstanding acceptance

- PASS: final query unit suite, 69 tests; independent three-day/two-axis outcome
  fixtures, JST supplementation, route spies, exact overlapping users/windows,
  generation privacy, normalized cache keys/cloning and 61-second expiry.
- PASS: Insights unit suite, 66 tests; opportunities/what-if zero-storage hits,
  expiry/argument isolation and notes safety checks despite cached aggregates.
- The subsystem run `pnpm jest --runInBand --testPathPattern hanami` observed
  **945 passed, 1 failed, 8 skipped** (66 suites passed, 1 failed, 8 skipped), before
  the final six shared-user-query tests were added. The final query suite was
  rerun separately; this is not a claim of an all-green final full run.
- Final integrated API/rollup check:
  `pnpm jest --runInBand --runTestsByPath test/unit/hanami-metrics-api.test.ts test/unit/hanami-metrics-rollup.test.ts test/unit/hanami-metrics-insights-api.test.ts`
  observed **139 passed, 1 failed**. Rollup and Insights API suites passed; the
  unchanged metrics API mock below was the only failure.
- FAIL: unchanged `hanami-metrics-api.test.ts`, test "populated breakdown strips
  identifiers, omits small cells, and preserves the three-type numerator".
  Line 246's mock supplies rows only for SQL starting `WITH cohort`; historical
  daily/DISTINCT queries consequently receive no rows. This is a new incompatibility
  exposed by the required route change, **not** a pre-existing passing-code error.
  Assertions and this API test were left unchanged. Updating only its storage mock
  requires approval of the instruction to keep this file unmodified.
- SKIPPED: backend `tsc` and test `tsc`; repository-wide verification is reserved
  for the Integrator. No claim of green typechecking is made.
- SKIPPED: C-specific trigger/old-cohort contract tests (C not adopted).
- PASS: whitespace checks restricted to all six R1 files. Repository `git diff
  --check` reports pre-existing trailing whitespace in
  `packages/misskey-js/src/autogen/apiClientJSDoc.ts` at lines 575, 586, 598, 609
  and 4812; R1 added none and did not edit that file.

### R1 caller/invariant audit

| Changed/new functions or SQL | Callers; preserved invariant |
| --- | --- |
| Query `summary`, `summaryEngagement` | Admin summary endpoint and `stats`. Daily additive counts plus one today cohort; exact cross-source/range/window users, daily suppression, visible denominators and unchanged response projection. |
| Query `breakdown`, `dailyEngagement` | Admin breakdown, `stats`, Insights opportunities. Seven daily dimensions and approved raw trendTerm/filter exception; exact range suppression and existing ratios. |
| `addEngagementCounts`, `mergeEngagementRows` | Summary/daily engagement helpers. Add only five count fields, never users; overlay exact users and key-sort rows; presenters expose only allowlisted fields. |
| `metricsDailyEngagementSql`, `metricsRangeUsersSql`, `METRICS_SUMMARY_USERS_SQL` | Query engagement helpers. Persisted scope/dimension filters, exclusion of today, JST half-open bounds, NULL-user exclusion, original dimension defaults and independently anchored usage windows. |
| `dailyPersonalGeneration`, `METRICS_DAILY_PERSONAL_GENERATION_SQL` | Summary. Existing personal-generation extras, small failure-group suppression and today-only supplementation; range generation percentiles remain raw and exact. |
| Query `errors`, `queryErrors`, `cachedRaw`, `pruneRawCache` | Admin errors; raw breakdown/errors loaders. Same sanitized/HMAC response and privacy checks, at most 60-second staleness, cloned bounded cache, failed loads not cached. |
| Insights `opportunities`, `whatIf`, `cached`, `remember` | Admin opportunities/what-if; judge-aggregate optional cohort; notes shares cache helpers. Validation and threshold order retained; settings staleness bounded to TTL; notes visibility recheck remains outside aggregate cache. |
| Test database doubles, raw fixture/window evaluators and test callbacks | Focused unit runners. Independent expected counts and raw distinct sets test aggregation, route selection, suppression and cache behavior without changing API schemas. |
