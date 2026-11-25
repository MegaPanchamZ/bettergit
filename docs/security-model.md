# Better Git security model

Better Git protects committed file contents using local age identities. It does not change GitHub's repository permissions. Repository readers can obtain every historical ciphertext, visible path, public comment, and structural key. Authorized users can retain plaintext and keys permanently. Revocation limits future managed delivery; rotation limits future access only after secrets and encryption keys change.

## Trust boundaries

The directory stores public keys, recipient-wrapped group identities, membership metadata, OIDC requests, and audit events. It has no plaintext group key. Administrators verify recipient fingerprints independently before granting access. Clients independently pin group fingerprints before their first managed download. A server-side policy cannot authorize a broker to release a local key: the broker independently validates provider signatures and its separately administered trust file, including a signed audience containing the ephemeral recipient and group.

The GitHub App guard is a separate boundary. It reads blobs already received by GitHub. A failed check can prevent a merge when configured as a required check; a webhook cannot prevent the initial upload. If a developer pushes plaintext, it has already reached GitHub and may be read by the guard. The directory's zero-knowledge design cannot make that upload confidential retroactively.

Protected blobs carry an Ed25519 signature bound to the file path and, in value mode, the field. The guard verifies signatures against the signing key pinned in the approved policy and checks syntax, framing, and covered history. Checkout verifies against the signing key derived from its local group identity. A signature establishes that a holder of the group identity signed the bytes. Any holder can sign arbitrary bytes, so individual authorship and the safety of public comments still depend on repository permissions and review. Use a separate group identity for each repository and group. Git history remains decryptable by design: an older signed value at the same path and field can still verify under the same group key. Review changes and rotate the group key and affected secrets when rolling back or responding to a compromise.

Local policy is pinned during init. Reviewed policy changes require re-initialization, and service enrollment separately approves its policy. Users controlling Git configuration, hooks, attributes, or the executable can bypass local controls. Repository permissions and required checks provide the independent merge boundary.

## Restricted collaboration

Companion repositories isolate ordinary repository readers using GitHub permissions. They cannot hide from organization owners, enterprise administrators, authorized Apps, or other privileged roles. Copying parent history requires every companion collaborator to already have read access to the parent. Organizations need base permission `none` and appropriate App/AI access policies.

The local push guard tracks restricted commit ancestry. It cannot recognize independent copies, cherry-picks, or content squashes as originating from restricted work. Deliberate publication must reveal the reviewed content to all parent readers. Public Git transfer and PR creation are separate effects; a failed PR request cannot recall content already transferred. Do not interpret a command failure as proof that content stayed private.

## Memory and recovery

CLI-owned plaintext vectors and serialized key envelopes use zeroizing containers. Third-party parsers, allocator copies, keyring implementations, process environments, and operating-system facilities can retain other copies. JavaScript provides no reliable memory-wiping guarantee. The browser viewer clears inputs and output when it closes and stores neither identity nor plaintext persistently.

There is no plaintext private-key file fallback. Identity loss requires an independently reviewed recovery process or an existing administrator to rewrap the group identity. Losing every copy makes old data unrecoverable. Offline grants are outside managed-fetch logs. Offboarding reports therefore conservatively describe potential group-wide exposure and list protected path patterns; they cannot assert which individual files were decrypted.

## Release validation

Independent audits in `audits/` record the source snapshots they inspected. Later remediation does not retroactively change those verdicts. Local tests cover synthetic identities, ciphertext/context failures, Git filtering, the packet protocol, mocked provider tokens, and disposable Postgres operations. Live GitHub permissions and required-check selection, provider-issued OIDC, all supported OS keychains, and installed browser behavior still require deployment validation.
