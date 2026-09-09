# Offline artifact review

These commands read local artifacts under the public demonstration keys. They
do not execute actions, admit permits, authenticate production identities or
establish the truth of evidence. Library calls require explicit trusted keys.

## Share a receipt profile

`crctl bundle receipt audit.json --out receipt.json` verifies the source before
removing its proposal and raw evidence. Signed artifacts and their bindings
remain unchanged. The output uses the existing receipt profile, whose review
checks integrity only. This is data minimization, not anonymization: signed
event metadata and connector commitments remain. Existing output files are
never overwritten. Keep the original audit file for semantic replay.
