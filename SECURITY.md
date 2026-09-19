# Security Policy

## Supported versions

Until demur reaches a stable release, only the latest tagged release and the
current `main` branch receive security fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not include
sensitive details in a public issue or discussion.

Please include:

- the affected revision;
- the host integration (`pi`, `claude-code`, or CLI);
- the command and execution context needed to reproduce the issue;
- the observed and expected verdict; and
- whether the issue bypasses fail-closed behavior or exposes data unexpectedly.

If private vulnerability reporting is unavailable, open a public issue asking
for a private contact channel without including exploit details.

## Scope and expectations

demur is a proof of concept, not a security boundary. Model misclassification,
nondeterminism, prompt influence, shell obfuscation, and incomplete coverage of
process-launching tools are documented limitations. Reports that demonstrate a
systemic bypass, secret exposure, protocol error, or failure to deny when the
guard itself is unavailable are still valuable.

Every judged command and limited repository context is sent to TypeSafe. Review
the data disclosure in [README.md](README.md) before enabling demur in a
sensitive environment.
