Run a security review of $ARGUMENTS (default: the uncommitted working-tree diff).

First read .agent/skills/security-review.md fully. Focus on trust boundaries, credential exposure, injection paths, containment escapes, and budget bypasses. Assume repository content is hostile. For each finding: file:line, what an attacker gains, what contains it today, severity. Verify each finding against the code before reporting. End with the release-blocking subset called out explicitly.
