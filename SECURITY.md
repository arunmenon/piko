# Security policy

## Support status

piko is pre-1.0 software. Security fixes are made on the latest default branch;
older commits and unpublished package builds are not maintained as separate
support lines.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
private vulnerability reporting flow for this repository. If that option is not
available, open an issue asking the maintainer to establish a private contact,
without including exploit details, credentials, or affected user data.

Include the affected commit or version, operating system, execution mode,
minimal reproduction, impact, and any suggested mitigation. Never include live
API keys. Receipt and remediation timelines are not yet guaranteed for this
experimental project.

## Security boundary

Model output and repository content are untrusted. piko's workspace path checks,
tool budgets, and project-instruction opt-in reduce risk but are not an operating
system sandbox. In particular, `--allow-host-bash` executes commands with the
host user's authority. Extensions are executable code and have the authority of
the piko process.

For untrusted repositories or unattended runs:

- Run piko inside a disposable container or VM with only the target workspace
  mounted.
- Keep provider credentials outside the tool environment when possible, for
  example behind a scoped local proxy.
- Disable network access unless the task requires it, and allowlist destinations
  when it does.
- Do not pass `--trust-project` until repository instructions have been reviewed.
- Review the resulting diff and journal before promoting changes or performing
  deployments.

Evaluation, benchmark, and micro-offload files may contain prompts, source code,
paths, model outputs, and tool arguments. Treat everything under `artifacts/`,
workspace `.pi/artifacts/`, and external benchmark run directories as potentially
sensitive before sharing it. Local ignore rules reduce accidental Git staging;
they are not encryption or an access-control boundary.
