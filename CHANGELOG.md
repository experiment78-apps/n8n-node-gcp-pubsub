## Unreleased

- Require Node.js 22 or newer and update Google Cloud runtime dependencies to resolve production security advisories.
- Bound acknowledgement retries to three attempts after the initial request, with request and operation timeouts.
- Include OAuth client credentials during refresh and handle persisted token expiry before opening streams.
- Correct trigger source and package entry casing for Linux installations.
- Preserve cross-project topic and subscription resource paths, including emitted subscription metadata.
- Resolve publish topic and project expressions per input item, sharing batching only within each destination.
- Preserve action validation errors when Continue on Fail is enabled.
