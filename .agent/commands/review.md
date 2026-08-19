Run a disciplined code review of $ARGUMENTS (default: the uncommitted working-tree diff; a commit-ish or path may be given).

First read .agent/skills/code-review.md fully and apply it literally. Then:
1. Enumerate the changed surface (git diff / git show as appropriate).
2. Produce severity-ranked findings with file:line, a concrete failure scenario each, and the anti-rationalization check you applied.
3. Verify the top findings against the actual code before reporting them.
4. End with a verdict: approve, approve-with-fixes, or reject, plus the definition-of-done items still unmet (read .agent/skills/definition-of-done.md).
