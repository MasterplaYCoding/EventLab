# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/MasterplaYCoding/EventLab/security/advisories/new)
rather than in a public issue.

Expect an acknowledgement within a week. If a fix is warranted, the advisory
will credit the reporter unless they ask otherwise.

## What is in scope

EventLab is a development dependency that sends HTTP requests to a target you
configure. The things worth reporting:

- **Secret leakage into reports.** Reports are designed to be attachable to
  public issues: they store request header *names* only and never request
  bodies. A path by which a signing secret, bearer token or fixture payload
  reaches a serialised report is a vulnerability.
- **Escaping the loopback restriction.** Deliveries go to loopback unless
  `allowRemoteTargets` is set. A base URL that passes validation and resolves
  elsewhere is a vulnerability.
- **Unbounded resource use from a target's response.** Response bodies are
  capped (64 KiB by default). A response that causes unbounded memory growth
  is a vulnerability.
- **Code execution from parsing a saved plan.** `parsePlan` treats its input as
  data. Anything that makes it behave otherwise is a vulnerability.

## What is not in scope

- The CLI (planned for 0.3) will load and execute local JavaScript scenario
  modules. That is executable code by design, not a sandboxed data format, and
  running an untrusted scenario module is equivalent to running an untrusted
  script.
- The intentionally vulnerable example handlers in `examples/`. They are
  teaching material, they are labelled as such, and they are not published.
- Denial of service against a target you deliberately pointed EventLab at.
