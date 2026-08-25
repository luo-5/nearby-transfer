# Contributing to Nearby Transfer

Thank you for your interest in contributing to Nearby Transfer!

---

## 1. Core Principles & Constraints

All contributions must strictly adhere to our core architectural constraints:
1. **Zero Runtime npm Dependencies**: `@luo-5/core` and `@luo-5/cli` MUST ONLY use `node:` built-in modules. No external npm packages are permitted at runtime.
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
npm install

# Run all test suites
npm test

# Run core package tests
npm run test:core

# Run TypeScript type check
npm run typecheck
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
