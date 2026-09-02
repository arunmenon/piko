# 0022 - Descriptor-anchored workspace containment

Status: accepted (2026-08-25; ratified with owner amendments, recorded below)
Amends: 0006

## Context

An independent review demonstrated a working parent-symlink TOCTOU escape:
`resolveWorkspacePath()` validates the canonical path and returns a string,
and the mutation later re-traverses that string. Concurrently swapping a
validated parent directory for a symlink between the check and the
rename/write lands the mutation outside the workspace. The reviewer's
reproduction reported `{"escaped": true}` under a concurrent swap loop.
Additional `realpath()` checks cannot close this: any check that returns a
string re-traverses the tree at use time.

## Decision

Bind filesystem mutations to descriptors, not paths:

- Pin the workspace root once at startup: open it as a directory descriptor
  and keep it for the process lifetime; all containment decisions derive
  from this descriptor, never from re-resolving a root path string.
- Perform filesystem operations descriptor-relative with true
  openat/renameat semantics. Node.js does NOT expose these APIs; the
  implementation is explicitly authorized to use a native/platform helper
  (a small N-API addon or vetted binding) or to route mutations through
  the sandbox executor. Path tricks through /proc/self/fd are not
  portable and are not an acceptable implementation.
- A swapped parent must produce failure (`ELOOP`/`ENOTDIR`), never silent
  traversal. Atomic writes stay: temp file plus rename, both performed
  relative to the walked parent descriptor.
- Reads are covered as well as writes (owner amendment): a parent-symlink
  race on the read path leaks host files into model context and on to the
  provider, so containment is a confidentiality boundary too, not only an
  integrity boundary. read/edit resolve through the same descriptor walk.

## Acceptance regression

Deterministic parent-swap tests for read, write, AND edit on macOS and
Linux: swap a validated parent for an out-of-workspace symlink at a
test-controlled barrier and assert the operation fails closed, no
out-of-workspace file is created or disclosed, and temp files are cleaned
up. On platforms where the helper is unavailable, mutations fail closed
with a clear error rather than falling back to path-based traversal.

## Consequences

- Closes the only demonstrated containment escape; workspace writes become
  immune to path-substitution races rather than resistant to them.
- Component-wise walking costs syscalls per path depth on the write path;
  writes are rare relative to reads and the cost is acceptable.
- The implementation must degrade explicitly (fail closed with a clear
  error) on platforms where `O_NOFOLLOW` semantics differ; benchmark
  containers and macOS/Linux dev hosts are the supported matrix.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it. The
record's central sentence, that additional realpath checks cannot close the
race, has four papers behind it.

- corroborates: "Fixing Races for Fun and Profit: How to use access(2)", Dean &
  Hu, USENIX Security 2004. Proposes re-checking a path k times, the mitigation
  this record rejects.
- corroborates: "Fixing Races for Fun and Profit: How to Abuse atime", Borisov
  et al., USENIX Security 2005. Filesystem mazes win the k-race
  deterministically.
- corroborates: "Portably Solving File TOCTTOU Races with Hardness
  Amplification", Tsafrir et al., FAST 2008. Hardens path checking further and
  remains path-based.
- corroborates: "Exploiting Unix File-System Races via Algorithmic Complexity
  Attacks", Cai, Gui & Johnson, IEEE S&P 2009. Slowing kernel name resolution
  defeats both of the above, which is why only descriptor-relative access holds.
- corroborates: "The Balkanization of Execution-Security Research for AI Coding
  Agents", Rashidi, arXiv 2607.05743, 2026 (single-author systematisation of 39
  papers). Names single-check authorization treated as permanently valid as a
  recurring root defect.
