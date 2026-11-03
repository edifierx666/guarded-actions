# Changelog

## 1.1.0

- Remove all exact-version activation, plan-admission and execution gates. Claude Code version is diagnostic information only.
- Remove obsolete `compatible` and `supportedVersion` status fields instead of reporting an unverified compatibility claim.
- Preserve native permission checks, author/argument binding, receipt verification and failure fallback.
- Verify actual enablement, model-authored native build/check execution and failure fallback on Claude Code 2.1.317.
- Add regression coverage for newer patch and major version strings; this checks the absence of version gating, not untested host API compatibility.

## 1.0.1

- Publish an installable GitHub marketplace with a repository-root plugin source.
- Add public installation, compatibility, safety, troubleshooting and measurement documentation.
- Add repository metadata and redact temporary machine-specific fixture paths in published evidence.
- Retain the exact Claude Code 2.1.316 execution gate; no runtime behavior change.

## 1.0.0

- Add explicit session-only `/guarded on|off|status` controls, disabled by default.
- Register bounded literal Read/Bash plans and execute unique eligible continuations at the native model-step seam.
- Bind native execution events, unchanged arguments, tool results and conversation receipts before advancing.
- Preserve host permissions and stop stored continuations on failure, unknown execution, backgrounding, interruption, new input, directory changes, compaction and session teardown.
- Separate initial dispatches, evidence-certified continuations, real forwarded model requests and unknown usage without estimating savings.
- Pin compatibility to the exercised Claude Code 2.1.316 interface; add core behavior and host-hook regression coverage.
- Bind submitted plans to the author's streamed arguments and final transcript before activation; isolate subagent lifecycle events and reset per-session accounting on clear/resume.
