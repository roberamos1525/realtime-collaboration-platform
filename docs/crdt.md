# The RGA sequence CRDT

Source: `packages/shared/src/crdt/` (`id.ts`, `ops.ts`, `rga.ts`, `snapshot.ts`).

## Model

Every character ever inserted is an *element* with a globally unique id `(clock, site)`:

- `site`: the replica that created the element. The server hands each WebSocket connection a fresh site at join
  time; the server's own replica uses `srv…`; initial document content uses `init`.
- `clock`: a Lamport timestamp. A replica's clock is the highest clock it has seen. A new operation uses
  `clock + 1`, and an insert of `n` characters consumes `clock … clock + n − 1`.

Ids are totally ordered: by clock first, then by site string. Elements live in a doubly linked list in document
order. Deleted elements stay in the list as **tombstones** so later operations that reference them can still be
placed.

## Operations

```ts
insert { site, seq, clock, after: key | null, text }   // char i gets id (clock+i, site), placed after char i-1
delete { site, seq, clock, spans: [{ site, clock, length }] }
```

`seq` is a per-site counter with no gaps. Each replica keeps a version vector `site → highest seq integrated`.

### Integrating an insert

Start at the reference element (`after`, or the head for `null`) and skip right over every element whose id is
**greater** than the new element's id, then insert. Concurrent inserts at the same position therefore end up in
descending id order on every replica. Descendants of a skipped element always have even larger clocks (they were
created after seeing it), so whole subtrees are skipped together. That is why concurrent runs of typing never
interleave (see the "keeps runs contiguous" test). A run of characters is placed with one scan, because character
`i + 1` always lands directly after character `i`.

### Integrating a delete

Mark each targeted element as deleted. Deleting an already-deleted element is a no-op, so concurrent deletes of the
same text commute. The replica reports the visible-text changes (`{ kind: "delete", index, length }`), computed in a
single pass, so UIs can patch their text without diffing.

### Delivery guarantees

`apply(op)` accepts ops in **any order, with duplicates**:

- `seq ≤ vv[site]`: duplicate, ignored. This also catches re-delivered inserts whose tombstones were collected.
- `seq > vv[site] + 1`, or the referenced elements are missing: buffered in `pending` and retried after every
  successful integration. The buffer is bounded (`maxPending`).

The server is stricter. It integrates only ops that apply immediately (`canApply`) and asks the client to resync
otherwise, so its log is always in causal order.

## Convergence argument (informal)

1. Two replicas that have integrated the same set of ops hold the same set of elements and deletion flags, because
   deletes are idempotent and commutative.
2. The position of an element depends only on its reference element and the ids of elements inserted after that
   same reference, all of which are in the integrated set (causal buffering guarantees the reference exists). The
   skip rule is deterministic and order-independent for concurrent siblings, because their relative order is fixed
   by id comparison alone.

The property tests (`convergence.test.ts`) check this empirically: 2–5 replicas make random inserts and deletes,
and messages are shuffled, partially delivered and randomly duplicated over 40 seeds. After full delivery all
replicas must have identical text, no pending ops, and a text rebuilt *only from the emitted change events* that
matches the replica. A permutation test also checks that all 6 orders of 3 concurrent ops agree.

## Garbage collection

`collectGarbage(retain?)` unlinks tombstones. It is safe **only at a quiescent point**: every replica that may still
send operations has integrated every operation this replica has. At such a point:

- every future operation is created by a replica that has seen all current elements, so its clock exceeds every
  existing clock;
- future inserts reference *visible* characters (or the head) and deletes target visible characters, so no future
  op references a collected tombstone;
- when a future insert is placed after reference `R`, the next element after `R` (tombstone or not) has a smaller
  id, so the scan stops immediately whether or not tombstones were removed. Replicas that collected and replicas that
  did not therefore place it identically.

The property tests run four phases of random concurrent editing. Between phases they reach quiescence and let a
random subset of replicas collect, and convergence is checked again.

In the server, quiescence is detected with acknowledgements. A client acks the highest server `seq` it has
integrated, and because a client's ops travel on the same ordered socket as its acks, any op it created before an
ack reaches the server before that ack. `DocSession.isQuiescent()` requires every connected participant's ack to
equal the head. The server also retains tombstones referenced by comment anchors so comments keep their position.
Browser replicas never collect; they receive a collected snapshot the next time they join.

## Snapshots

A snapshot is `{ version: 1, clock, vv, runs }`, where `runs` merges consecutive elements from the same site with
consecutive clocks and the same deletion flag into `[site, clock, text, deleted]`. Typing produces long runs, so
snapshots are compact. `fromSnapshot` validates the structure (zod), rejects duplicate ids and clocks newer than the
snapshot clock, and restores the replica's own `seq` when it reuses a site id.

## Positions, cursors and anchors

- `anchorAt(index)` returns the key of the character before a caret (`null` at the start). `resolveAnchor(key)`
  turns it back into an index. If the character was deleted, the caret lands where it used to be.
- Remote cursors and comment ranges are stored as keys, so they move with concurrent edits.
- `transformIndex` shifts the local selection through a list of text changes when remote ops arrive.

## Client rebase (reconnect / resync)

After a resync, `DocumentSync` receives a fresh snapshot and a new site id. Pending local ops the server already
integrated (according to `vv[oldSite]`) are dropped, and the rest are re-issued against the new replica:

- inserts resolve their (mapped) reference key to an index and insert there, recording the mapping from old element
  ids to new ones so later pending ops can follow them;
- deletes delete whichever targeted characters are still visible.

If a reference no longer exists (it was collected while the client was offline), the text is appended at the end.
This is a documented limitation. After three consecutive failed replays, the client drops its pending edits and
reloads the server state rather than looping.

## Complexity

| Operation | Cost |
| --- | --- |
| Insert/delete by visible index (local) | O(n) to find the position |
| Integrate remote insert | O(n) visible-index computation plus O(k) for the run |
| Integrate remote delete | O(n) single pass |
| `toString` | O(n), cached until the next change |
| Snapshot / load | O(n) |

`n` counts tombstones as well. That is acceptable for the 500 000-character cap. An order-statistics tree is on the
roadmap.
