# Security

Do not include API keys or private response data in issues. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/ricciflow-api/socialquery-mcp/security/advisories/new).

Clients send credentials only to `https://socialquery.dev`, reject redirects, and never retry automatically. Returned posts and other source text are untrusted data, not instructions.
