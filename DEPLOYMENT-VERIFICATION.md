# Check the deployed website

Run this read-only check from a trusted workstation or deployment runner:

```sh
node scripts/deployment-check.mjs --url https://your-practice.example
```

Supply only the website origin, without a path, query, credentials, or fragment. Do not supply passwords, API keys, patient details, or a URL containing a token. The command needs Node 24 and normal network access; it does not need a server build or a login.

The checker uses unauthenticated GET requests to the web page, health/runtime metadata, and the protected patient-directory endpoint. It expects HTTP 401 for the directory and **never reads its body**, even if the server incorrectly grants access. Other response bodies are bounded and are never printed. Redirects may stay within the same HTTPS origin only. Requests time out after five seconds; certificate verification cannot be disabled. Reports contain fixed check descriptions rather than server error text, page contents, credentials, or patient information.

A passing report requires production/clinical-release metadata, disabled demo accounts and public signup, mandatory MFA, restrictive web CSP, anti-framing and MIME-sniffing headers, uncached API responses, and HSTS lasting at least one year. The process exits with code `1` if a check fails. The current synthetic demo and staff pilot intentionally fail clinical-release checks.

This verifies only observable unauthenticated website behavior. It does not establish clinical safety, approval authenticity, staff permissions, storage encryption, backup retention/recovery, protected audit storage, required agreements, or regulatory compliance. It does not activate production mode or authorize patient use. Retain the report alongside the actual hosting and clinical/security approval evidence, and separately perform authenticated acceptance checks and a host-level recovery drill.
