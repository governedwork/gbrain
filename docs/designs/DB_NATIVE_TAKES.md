# DB-native takes: the takes lifecycle on a brain with no markdown repo

Status: proven on v0.60.342.0 (unit arm on PGLite, Postgres arm through
`test/e2e/takes-db-native-postgres.test.ts`). One reconcile defect fixed. This
note is written so it can be linked from an upstream issue as the reference for
"takes on a database-only brain".

**Say to your agent:** *"Record a take on acme-example: they will close the
round by Q4, held by people/alice-example."* · *"Mark take 2 on acme-example as
correct, the round closed."* · *"Who holds a bet about acme-example's revenue?"*

## The question

A hosted brain runs with every source's `local_path` null: pages live only in
PostgreSQL, nothing is checked out, and clients reach the brain through the MCP
server with an OAuth client credential. Takes were introduced as markdown
canonical (`src/core/takes-write.ts`: the fence is edited in the `.md` file
first, the `takes` rows mirror it), so the obvious reading is that a brain with
no `.md` file cannot hold a take. An earlier fork prototype answered that by
adding a second kind of take row (`origin = 'db'`, `row_num` NULL, an
`external_id`) beside the fence-owned rows.

## What 0.60.342 does

That prototype is superseded by upstream's own design, which this note pins:

- **The fence is part of the stored page, not of a file.** Every takes verb
  (`takes_add`, `takes_update`, `takes_supersede`, `takes_resolve`,
  `takes_remove`) is a coordinated page mutation
  (`src/core/persistence/takes-prepare.ts` → `preparePageMutation`). The
  mutation rewrites the takes fence inside the page's `compiled_truth` and
  commits the page and its projected `takes` rows in one transaction
  (`canonical-projections.ts`). With a markdown owner the same write also
  lands the file; without one (`local_path` null) the receipt says
  `persistence.mode: database`, `mirror_written: false`, and nothing else
  differs. `takes-write.ts` remains the trusted local CLI writer and the
  bootstrap sweep's writer; it is not on the MCP path.
- **Facts and takes behave alike.** `remember` writes the facts fence into the
  page body and projects `facts` rows; takes do the same with the takes fence.
  Row numbers stay fence-addressed on both.
- **The holder grant is per client and live.** `oauth_clients.takes_holders`
  (set with `gbrain auth rescope-client --takes-holders …`) is read from the
  client's current grant at token validation
  (`src/core/oauth-provider.ts`) into `takesHoldersAllowList`; NULL keeps the
  fail-closed `['world']` default, `[]` is deny-all. `takes_add` and a
  `takes_supersede` holder override check the requested holder
  (`permission_denied`); `takes_update`, `takes_supersede` and `takes_resolve`
  look the target row up through the allow-list, so a row of a holder the
  client cannot see presents as `not_found`, the same shape as a missing row.
  Publication re-checks the holder against the client's *current* grant
  (`authorizeTakeHolder`), so a grant narrowed after admission still refuses.
- **Remote reads hide the fence; remote writes keep it.** `get_page` over MCP
  strips the takes fence; a remote `put_page` of the body it read gets the
  stored fence re-appended (`persistence/protected-takes.ts`), so the rows are
  neither dropped nor duplicated. A body carrying a different fence is refused
  `permission_denied` ("use the scoped takes operations").
- **Reconcile is idempotent on fence rows.** `extractTakes` (the `db` walk;
  `gbrain takes rebuild <slug>` and the v0.28 migration) and the dream
  `extract`, `extract_facts` and `consolidate` phases run with `brainDir`
  null and leave ids, resolutions and supersession pointers as they were.

## The defect this series fixes

`src/core/cycle/extract-takes.ts` projected every fence row with
`superseded_by: null`, and `addTakesBatch`'s upsert writes that column. So the
first reconcile after a `takes_supersede` struck the pointer the coordinated
write had recorded (row 1 → `superseded_by` 2 became null) while the fence
still said `superseded by #2`. This was the unmanaged reconcile path; the
managed path (`managed_maintenance_takes_reextract`) already projected through
`takesPreparation.toCanonicalBatchInput`, so the `reconcile: extractTakes` test
discriminates on the unmanaged arms only, and
`test/takes-supersession-citation.test.ts` pins the managed arm on a chain and
an uncited struck row.

The strike citation is now read in one place, `supersessionCitation` in
`src/core/takes-fence.ts`: the LAST `superseded by #N` in the cell (the fence
writer appends it after the row's own provenance, so a row struck twice ends
with the live pointer), in any case. Every reader uses it:

- the canonical projection (`toCanonicalBatchInput`, now given the page's rows)
  points only at another row the page has; a citation to the row itself or to
  a number the page lacks (zero, above int4, a row that was never there)
  projects null, as its docstring always said. `takes.superseded_by` is an int4
  and one out-of-range cell used to fail the whole upsert batch
  (`test/takes-canonical-projection.test.ts`);
- the coordinated takes verbs re-index every row they changed, including the
  rows Tier 1 normalised on the way, through that projection. They used
  `toBatchInput(…, null)`, so a `takes_add` that normalised a struck row's
  holder nulled its pointer;
- the `takes_remove` guard refuses the row the citation names. It read the
  first citation case-sensitively, so `Superseded by #2` let row 2 go with a
  dangling pointer and `#2; #3` guarded the wrong row;
- fence-repair's renumber (`src/core/fence-repair/content.ts` and the gate in
  `validate.ts`) follows and rewrites that same citation. Facts cells keep
  their first-citation reading, which is what `facts-fence.ts` projects.

## The lifecycle gate

`test/takes-db-native.test.ts` runs the whole gate on a source with
`local_path` null, as an OAuth client whose grant carries one private holder,
on PGLite and on Postgres, unmanaged and managed (`persistence_brain.enabled`):

| Leg | Named tests |
|---|---|
| create, read, update, supersede, resolve | `granted client: takes_add …`, `… takes_list …`, `… takes_update …`, `… takes_supersede …`, `… takes_resolve …` |
| holder grant enforced | `without the holder grant: …` (add with the private holder; update, supersede, resolve of the private row; supersede with a holder override) |
| remote put_page | `put_page: a remote body without the fence keeps every take row`, `put_page: a forged takes fence is refused …` |
| reconcile | `reconcile: extractTakes … keeps ids, resolutions and superseded_by`, `reconcile: the dream extract, extract_facts and consolidate phases …` |
| strike citation (managed) | `takes_add after a Tier-1 normalisation of a struck row keeps its superseded_by`, `takes_remove refuses the row a capitalised citation names`, `takes_remove follows the last citation of a chain …`, `an uncited struck row projects no pointer …` |
| restart | `restart: a fresh engine on the same database reads the same takes` |
| backup / restore | `pg_dump then pg_restore keeps every take, and the restored brain accepts the lifecycle` (Postgres only, plain-format dump restored through `psql -v ON_ERROR_STOP=1`) |

The holder grant is two layers: the admission-time allow-list
(`assertHolderAllowed` and the masked row lookup in `takes-prepare.ts`) and the
publication re-check against the stored grant (`authorizeTakeHolder` in
`persistence/authority.ts`). Removing only the first leaves every refusal in
place (the second refuses); removing both fails all ten `without the holder
grant` tests. Reverting the reconcile fix fails the `reconcile: extractTakes`
test (`scripts/check-test-discriminates.sh`).

## Known limits

- `takes_remove` and `takes_rebuild` are local-only operations; a hosted brain
  runs them on the brain host, not over MCP.
- The bootstrap sweep (`gbrain takes extract --from-pages`) still needs a
  markdown home for unmanaged file-backed pages; database-only pages take the
  coordinated path (`docs/architecture/key-files/hindsight.md`).
- The pg_dump leg is a plain-format dump restored with `psql`; the client
  version tolerance it applies is documented in the test file header.
