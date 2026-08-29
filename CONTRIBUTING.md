# Contributing to Nearby Transfer

Thank you for your interest in contributing to Nearby Transfer!

---

## 1. Core Principles & Constraints

All contributions must strictly adhere to our core architectural constraints:
1. **Minimal Runtime Dependencies**: `@luo-5/core` uses only `node:` built-ins. The CLI and adapters may depend on workspace packages, but adding a third-party runtime dependency requires an explicit design and security review.
2. **TypeScript Strict Mode**: Code must compile cleanly with `strict: true` under `tsconfig.json`.
3. **Cryptographic Integrity**: The pairing security model (Ed25519 + SAS + X25519 + AES-256-GCM) cannot be weakened.
4. **Deterministic Protocol**: All JSON exchanged over the wire must be canonical JSON.

---

## 2. Development Workflow

```bash
# Clone the repository
git clone https://github.com/luo-5/nearby-transfer.git
cd nearby-transfer

# Install dev dependencies
npm ci

# Build packages, type-check, syntax-check, and run package + desktop suites
npm run ci:verify
```

Android or shared-vector changes also require:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest
.\gradlew.bat :android-app:assembleDebug
```

---

## 3. Commit Convention

We use standard **Conventional Commits**:
* `feat: ...` for new features
* `fix: ...` for bug fixes
* `docs: ...` for documentation changes
* `test: ...` for test suite additions
* `refactor: ...` for code refactoring
* `perf: ...` for performance optimizations
