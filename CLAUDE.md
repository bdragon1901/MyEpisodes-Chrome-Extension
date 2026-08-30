# CLAUDE.md

Project instructions for Claude Code working in this repository.

## Versioning

The single source of truth for the version is the `version` field in
[manifest.json](manifest.json). It follows `MAJOR.MINOR.PATCH`.

**Bump the version as part of the same change that touches the code.** Judge the
size of the change and bump accordingly:

| Change size    | Action                                  | Example                                              |
| -------------- | --------------------------------------- | ---------------------------------------------------- |
| Very small     | **Do not change the version at all**    | Typo, comment, whitespace, doc-only wording tweak     |
| Small          | Bump the **last** digit (patch)         | Bug fix, style tweak, small copy or behavior fix      |
| Medium         | Bump the **middle** digit (minor)       | New tab, new setting, notable UI or feature change    |
| Big / very big | Bump the **first** digit (major)        | Rewrite, new architecture, breaking change to storage |

When bumping a digit, reset the digits to its right to `0`
(`0.1.3` → minor bump → `0.2.0`; `0.2.4` → major bump → `1.0.0`).

Only one bump per change, based on the largest single change in the set — not one
bump per file touched.
