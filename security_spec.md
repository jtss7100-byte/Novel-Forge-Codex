# NOVEL FORGE — Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Strict Tenant Isolation (`users/{uid}/...`)**: Every resource under `/users/{uid}/projects/{projectId}` and its subcollections (`characters`, `worldbuilding`, `episodes`, `revisions`) is strictly accessible only when `request.auth != null`, `request.auth.token.email_verified == true`, and `request.auth.uid == uid`.
2. **Master Gate (Relational Sync)**: Subcollection documents (`characters`, `worldbuilding`, `episodes`, `revisions`) can only be created or updated if the parent project `/users/$(uid)/projects/$(projectId)` exists and its `ownerId == request.auth.uid`.
3. **Immutable Ownership & Identifiers**: `id`, `ownerId`, `projectId`, and `createdAt` can never be mutated during an `update`.
4. **Temporal Integrity**: `createdAt` on `create` and `updatedAt` on `create`/`update` must equal `request.time`.
5. **Bounded Sizes & Strict Keys**: Every document creation and update must pass `isValid[Entity](incoming())`, enforcing `hasAll` and `hasOnly` keys, string `.size()` bounds, array `.size() <= 50` bounds, and regex ID checks (`^[a-zA-Z0-9_\-]+$`).
6. **Secure List Queries**: Every `allow list` rule verifies `request.auth.uid == uid` and `resource.data.ownerId == request.auth.uid` without costly `get()` calls inside `list`.

## 2. The "Dirty Dozen" Payloads

1. **Unverified Email Write**: Authenticated user with `email_verified: false` attempting to create `/users/u1/projects/p1`.
2. **Cross-Tenant Read/Write**: User `u2` attempting to read or write `/users/u1/projects/p1`.
3. **Owner Spoofing**: User `u1` creating `/users/u1/projects/p1` with `ownerId: "u2"`.
4. **Shadow Field Injection**: User `u1` creating or updating `/users/u1/projects/p1` with extra key `isAdmin: true`.
5. **ID Poisoning**: User `u1` creating a project with a 500-char or special-character document ID `p1$!@#`.
6. **Orphan Subcollection Write**: User `u1` creating `/users/u1/projects/nonexistent/episodes/ep1` when parent project does not exist.
7. **Timestamp Forgery**: User `u1` creating a project with a past or future `createdAt` instead of `request.time`.
8. **Immutable Field Mutation**: User `u1` updating `createdAt` or `ownerId` on an existing episode.
9. **Oversized Manuscript Overflow**: User `u1` writing an episode `title` of 500 characters (exceeding max 150).
10. **Invalid Status Enum**: User `u1` setting episode `status` to `"published_hacked"` instead of `["draft", "review", "confirmed"]`.
11. **Unbounded Array Injection**: User `u1` passing 100 items in `linkedCharacterIds` (exceeding max 50) or non-string first element `[123]`.
12. **Revision Tampering**: User `u1` attempting to `update` an immutable revision snapshot in `/users/u1/projects/p1/revisions/rev1`.

## 3. Red Team Audit Summary

- **Shadow Update Test**: Blocked by `data.keys().hasOnly(...)` in `isValid*` and `incoming().diff(existing()).affectedKeys().hasOnly(...)` in every `allow update` block.
- **Email Spoofing Test**: Blocked by `isVerifiedUser()` requiring `request.auth.token.email_verified == true`.
- **PII Blanket Test**: No public user collection exists; all paths are scoped under `/users/{uid}/...` with strict `isOwner(uid)` checks.
- **Query Trust Test**: All `allow list` rules enforce `isOwner(uid) && resource.data.ownerId == request.auth.uid` with zero `get()` calls.
- **Value Poisoning Test**: All `allow update` rules begin with `isValid[Entity](incoming())`, blocking any type/length poisoning on allowed keys.
