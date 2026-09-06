# Support ticket search

This small support backend serves `GET /tickets`. Agents report that combining
filters loses tickets, page counts describe only the current page, and changing
sort order sometimes changes the shared dataset. Repair the existing modules;
do not replace the HTTP layer or weaken its tests.

## Runtime and ownership

Node 22+ only; no packages to install. `npm test` runs all `test/*.test.mjs`.
`src/http.mjs` exports `createTicketServer(records)` for an ephemeral loopback
server. There is no external database or network service. `data/tickets.mjs`
contains representative records. Caller-supplied arrays are also supported.

Allowed changes: `src/query.mjs`, `src/repository.mjs`, `src/search.mjs`, and
`test/search-regression.test.mjs`. Keep exports/signatures compatible. Existing
HTTP adapter, tests, data, README, and package metadata are immutable.

## Search contract

Each ticket has a unique ASCII `id`, `title`, `customer`, `status` (`open`,
`pending`, or `closed`), lowercase `tags`, and canonical ISO `updatedAt`.

- `q`: trim and lowercase; case-insensitive literal substring in **either** title
  or customer. Blank means no text filter; no regex interpretation.
- `status`: optional exact lowercase enum; empty means no status filter. Unknown
  nonempty values are invalid.
- Repeated `tag`: trim, lowercase, ignore blanks, deduplicate, and require **all**
  requested tags. No tags means no tag filter.
- Filters combine with AND. Filter the **complete dataset before pagination**.
- `sort`: `newest` (default) or `oldest`. Order by timestamp descending or ascending;
  equal timestamps always use ID ascending (ASCII), independent of input order.
- `page`: positive decimal integer, default 1. `pageSize`: positive decimal integer
  1–50, default 20. Provided empty strings, fractions, signs, exponents, zero,
  non-digits, unsafe integers, and out-of-range values are invalid. Leading zeros
  are accepted. An out-of-range **page number** returns an empty items list, not
  an error. Unknown query keys are ignored. Scalar keys use their first value.
- `sort=` is invalid (only omission receives the default).
- Return `{items, total, page, pageSize, totalPages}`. `total` counts all matches,
  `totalPages = ceil(total / pageSize)`, including zero when no tickets match.
  Items contain the original record fields and only the selected page.
- No operation may mutate the caller's array, records, or nested tags. Calls with
  different filters/order must not influence later requests.

## Module interfaces and HTTP compatibility

- `parseQuery(URLSearchParams)` returns `{q, status, tags, sort, page, pageSize}`;
  absent status is `undefined`, absent q is `""`. Invalid input throws `RangeError`.
- `findTickets(records, query)` returns **all** matching, ordered records without
  pagination. `query` is the normalized output of `parseQuery`.
- `searchTickets(records, URLSearchParams)` composes the two and paginates.
- `createTicketServer(records)` serves JSON 200, invalid query 400 with
  `{error: "invalid_query"}`, unknown path 404 with `{error: "not_found"}`, and
  non-GET method 405 with `{error: "method_not_allowed"}`. Unexpected errors are
  500 `{error: "internal_error"}`; never convert implementation failures to 200.

## Regression coverage

Add tests to the designated regression file, exercising application behavior,
not implementation source strings. Cover missing results/whole-result page
counts and preservation of the input ordering across searches. The external
verifier also runs this file alone against two faulty variants: pagination before
filtering, and sorting the input array in place. Meaningful assertions must fail
for each faulty variant and pass for the repaired application. Public tests are
not counted as your added regression coverage.
