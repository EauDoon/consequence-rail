# Publication plan

Current state: `propose-new`, local candidate only.

No public repository, profile entry, pin, release or package has been created.

## Proposed GitHub metadata

- Repository: `consequence-rail`, subject to availability
- Visibility: public, subject to explicit approval
- Default branch: `main`
- About: `Recourse-gated execution and settlement receipts for autonomous actions.`
- Homepage: none
- Public identity: Oonyl
- Primary profile category: systems and protocols
- Initial profile role: candidate flagship

Proposed topics:

```text
autonomous-agents
runtime-safety
recourse
compensating-transactions
event-sourcing
openapi
json-schema
nodejs
security
```

## Maintenance promise

- one language-neutral artifact model
- one Node.js reference runtime
- one synthetic connector
- deterministic conformance and fault tests
- no hosted service or support-level promise
- no production-readiness claim

## Rights and license

The package contains original source, specification text and synthetic
fixtures prepared for this project. It contains no third-party runtime
dependencies or bundled external assets.

The project is licensed under Apache-2.0, covering both the protocol
specification and reference implementation.

## Required publication gates

1. Complete deterministic tests from a clean copy.
2. Parse and review every JSON and documentation file.
3. Run the privacy scanner against the clean filesystem package.
4. Confirm there are no secrets, private identities, private paths, real data,
   generated transcripts, hidden binaries or third-party assets.
5. Confirm license and ownership.
6. Initialize a clean local Git repository only after the filesystem scan.
7. Stage the exact candidate, write the Git tree and scan its raw blobs.
8. Review file modes, history, commit message and Oonyl noreply identity.
9. Prepare the exact repository metadata and main-profile synchronization
   packet.
10. Obtain explicit approval for the exact Git tree, metadata, commit and
    profile plan.
11. Publish without force push.
12. Verify the remote tree, README, links, identity, metadata and profile.

Any byte or metadata change after approval requires a new scan and renewed
approval.
