#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Nearby Transfer - npm Release & Publish Automation Script
# ==============================================================================

echo "======================================================================"
echo "  Nearby Transfer Release & npm Publish Automation"
echo "======================================================================"

# Step 1: Ensure Git working directory is clean
echo "[1/6] Checking Git working tree cleanliness..."
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Error: Git working tree is dirty. Commit or stash changes before publishing."
  git status --short
  exit 1
fi
echo "  ✅ Git working tree is clean."

# Step 2: Verify version consistency across packages
echo "[2/6] Verifying version consistency across packages..."
CORE_VER=$(node -p "require('./packages/core/package.json').version")
CLI_VER=$(node -p "require('./packages/cli/package.json').version")
ROOT_VER=$(node -p "require('./package.json').version")

echo "  - Root version:     $ROOT_VER"
echo "  - @luo-5/core:      $CORE_VER"
echo "  - @luo-5/cli:       $CLI_VER"

if [ "$CORE_VER" != "$CLI_VER" ] || [ "$CORE_VER" != "$ROOT_VER" ]; then
  echo "❌ Error: Version mismatch detected across packages!"
  exit 1
fi
TARGET_VERSION="$CORE_VER"
echo "  ✅ Version consistency verified ($TARGET_VERSION)."

# Step 3: Run Full Typecheck and Test Suite
echo "[3/6] Running TypeScript compilation and full test suites..."
npm run typecheck
npm test
npm run test:core

echo "  ✅ All tests passed successfully."

# Step 4: Publish to npm registry in strict topological order (core first, then cli)
echo "[4/6] Publishing packages to npm..."
echo "  -> Publishing @luo-5/core@$TARGET_VERSION..."
npm publish --workspace @luo-5/core --access public

echo "  -> Publishing @luo-5/cli@$TARGET_VERSION..."
npm publish --workspace @luo-5/cli --access public

# Step 5: Verify published packages on npm registry
echo "[5/6] Verifying registry availability with npm view..."
sleep 3
LATEST_CORE_VIEW=$(npm view @luo-5/core@"$TARGET_VERSION" version)
LATEST_CLI_VIEW=$(npm view @luo-5/cli@"$TARGET_VERSION" version)

echo "  - Registry @luo-5/core: $LATEST_CORE_VIEW"
echo "  - Registry @luo-5/cli:  $LATEST_CLI_VIEW"

if [ "$LATEST_CORE_VIEW" != "$TARGET_VERSION" ] || [ "$LATEST_CLI_VIEW" != "$TARGET_VERSION" ]; then
  echo "⚠️ Warning: Registry version verification delay; please check npm manually."
else
  echo "  ✅ Registry versions match ($TARGET_VERSION)."
fi

# Step 6: Create and push Git tag
echo "[6/6] Creating and pushing Git release tag v$TARGET_VERSION..."
git tag -a "v$TARGET_VERSION" -m "Release v$TARGET_VERSION"
echo "  Tagged v$TARGET_VERSION."
echo "  Run 'git push origin v$TARGET_VERSION' to trigger GitHub Actions release."

echo ""
echo "======================================================================"
echo "🎉 Release v$TARGET_VERSION published successfully!"
echo "======================================================================"
