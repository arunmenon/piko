# create-bucket autopsy (2026-08-24)

Status: closed. Root cause confirmed, fix landed after one failed iteration,
targeted retest 3/3.

## Task

terminal-bench-core 0.1.1 `create-bucket`. Instruction: "Create an S3 bucket
named 'sample-bucket' using the aws cli and set it to public read." Container
is `localstack/localstack:4.3`; the grader connects boto3 to
`http://localhost:4566` with dummy credentials (`test`/`test`). No real AWS
account exists or is needed. The container does not pre-set `AWS_*`
credential variables; every agent must supply its own.

## What piko did (0/3 this grid, 0-for-history across all models)

Transcript (17-31-14, gpt-5.5): wrote PLAN.md, ran
`aws --version && aws sts get-caller-identity`, got "Unable to locate
credentials", and stopped after ~2 tool calls with an honest report:
"Could not create the S3 bucket because AWS credentials are not configured
in this environment... Configure credentials or provide an authenticated
environment." Identical shape in all attempts and in every earlier arm.

## What terminus-2 did (3/3)

Transcript (19-10-52): ran
`export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
AWS_DEFAULT_REGION=us-east-1`, then used `aws --endpoint-url=http://localhost:4566`
(8 occurrences) to create the bucket and set the public-read policy. It
treated missing credentials for a local service as a solvable sub-problem
and fabricated the LocalStack-standard dummy values.

## Root cause

Behavioral, not environmental. Env sanitization (ADR 0016) stripped nothing
relevant here because the container provides no credentials to strip; both
harnesses faced the same empty credential state. The difference is that
piko's system prompt frames obstacles in policy vocabulary
("harness-enforced tool policy... never claim success") and the model
consistently classified missing credentials as a user-must-resolve blocker,
reporting honestly instead of improvising. Terminus's prompt is pure
execution framing ("solve the task by providing shell commands"), which
kept the model in puzzle-solving mode. The failure was perfectly
reproducible (0-for-history) which is what pointed at prompt-induced
behavior rather than flake.

## Fix (two iterations)

Iteration 1 FAILED (0/3, run 19-32-35). Line added: "Missing setup is
usually part of the task: if a local or sandboxed service lacks credentials
or config, provision placeholder values and continue." Bundle inclusion was
verified by decoding the embedded base64; the model saw the line and still
stopped at 2 requests in all three trials with zero exploratory commands.
Why it failed: the guidance is conditioned on the service being local or
sandboxed, and the model does not know that. It believed it faced real AWS,
where placeholder credentials are pointless, so the rule never fired.

Iteration 2 SUCCEEDED (3/3, run 19-37-21). The line was rewritten so the
investigation is the directive, not the provisioning
(packages/core/src/prompt.ts):

> When credentials or a service seem missing, investigate before reporting
> blocked: check running processes, listening ports, and config files for a
> local or emulated service, and provision placeholder credentials for it.
> Stop only when an obstacle truly needs the user.

Cost: ~60 tokens of fixed context (budget 815/1000, gate passes). This is a
general obstacle-class fix, not an S3/LocalStack special case, and the
honesty rule is untouched: verification requirements stay; only the "stop
versus investigate" decision changes.

## Verification

Targeted retest, `tb run --task-id create-bucket --n-attempts 3`,
pi + gpt-5.5, run 2026-08-24__19-37-21: 3/3 solved. The model found the
local endpoint (http://localhost:4566), provisioned dummy credentials,
created the bucket, applied the public-read policy, and verified the state
before reporting. Per-trial usage: 3730/3825/4849 input tokens (mean 4,135)
in 3-4 requests, versus terminus-2's grid-era 3/3 at mean 6,651 input.
After the fix piko solves this task at roughly 62 percent of terminus's
input spend. Grid rerun to re-measure the full 10-task subset is filed as
follow-up.

Lesson recorded: behavioral prompt fixes must give the model a concrete
next action, not a conditional it cannot evaluate. "Investigate X, Y, Z
before reporting blocked" worked where "handle sandboxes specially" did
not, because the model could not tell it was in a sandbox.
