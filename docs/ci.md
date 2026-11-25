# Keyless CI trust and operation

Apply all migrations listed in the control-plane README, then insert a CI policy as a database administrator. Policies are immutable except for `enabled`; create a new row for changes. Set `group_id` to the intended directory group, `issuer` to the exact GitHub/Vercel issuer, `audience` to a dedicated service audience, `subject` to the exact workload subject, and `required_claims` to explicit string-valued restrictions. Never enable wildcards or trust a pull request trigger.

Keep the broker's trust JSON outside untrusted repository control (for example in a separately administered workstation configuration). It contains no private key, but its integrity is essential:

```json
{
  "server": "https://keys.example.test",
  "group_id": "1",
  "group": "github-team:infra",
  "key_public": "age1_REPLACE_WITH_GROUP_PUBLIC_RECIPIENT",
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "https://keys.example.test/ci",
  "subject": "repo:acme/repository:environment:production",
  "required_claims": {
    "repository_id": "12345",
    "repository_owner_id": "67890",
    "ref": "refs/heads/main",
    "workflow_ref": "acme/repository/.github/workflows/deploy.yml@refs/heads/main",
    "environment": "production",
    "runner_environment": "github-hosted",
    "event_name": "workflow_dispatch"
  }
}
```

The group public recipient is derived from the locally held group identity; enroll and verify it through an administrator-controlled process. A reusable workflow can also pin `job_workflow_ref` to a commit SHA. Required provider claims must exactly match live issued tokens. The broker requires all listed GitHub restrictions; Vercel requires `project_id`, `owner_id`, and `environment`. Configure corresponding restrictions server-side too. Broker verification is independent of mutable server policy.

GitHub job permissions need `id-token: write`. Its environment must require approval and restrict deployment branches. Run:

```sh
bettergit ci-decrypt --server https://keys.example.test --policy POLICY_ID \
  --trust /trusted/ci-policy.json --output /private/runtime.env \
  --path .env.production encrypted.env
# In the authorized broker's environment, after inspecting the workload policy:
bettergit broker --server https://keys.example.test --group-id GROUP_ID \
  --trust /trusted/ci-policy.json github-team:infra
```

CI generates the recipient before fetching the GitHub token. Audience is `BASE_AUDIENCE:group:GROUP_ID:recipient:AGE_PUBLIC_KEY`. The broker verifies that exact signed audience. The job holds the ephemeral private identity only in memory. Output must be a new file, created with mode 0600 on Unix; use a private job workspace and remove it after use. Never print it or upload it as an artifact. For a signed whole-file blob, pass `--whole-file --path PATH` with its exact repository-relative path.

For Vercel, use `--oidc-command /trusted/vercel-token-helper`. Better Git invokes the executable with the requested audience as its sole argument and captures a token from stdout. Use `getVercelOidcToken({ audience: process.argv[2] })` from official `@vercel/oidc` 4+ in that helper. Verify the team-scoped issuer and project/owner IDs. The helper must print only the token. Native fixed-audience Vercel tokens cannot bind an ephemeral recipient; custom-audience exchange is required. No static key material is needed in the workload.

Requests expire within five minutes or at token expiry. A local broker must be available during that interval. Disabled policies cannot settle requests. Successful fetches and offboarding use transactions; logs record potential exposure, not proof of per-file decryption. Lost successful consume responses currently require a new request/token; automatic delivery recovery is not implemented.
