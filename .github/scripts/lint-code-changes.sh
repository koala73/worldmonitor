#!/usr/bin/env bash
# Which Lint Code checks a run needs. Both Lint Code jobs (`biome`, `docs-lint`)
# run this as their first step and gate their own steps on its outputs, so the
# workflow spends no runner on a separate classifier job.
#
# Outputs (to $GITHUB_OUTPUT): code, markdown, docs, each "true" or "false".
# Pushes, the weekly cron and any unusable PR file list run every check.
#
# Inputs (env): EVENT_NAME, REPOSITORY, PR_NUMBER, PR_HEAD_SHA, PR_BASE_SHA,
# GH_TOKEN. They arrive as env, not ${{ }} interpolation, so no PR-controlled
# text is spliced into the script.
set -euo pipefail

emit_all_true() {
  echo "code=true" >> "$GITHUB_OUTPUT"
  echo "markdown=true" >> "$GITHUB_OUTPUT"
  echo "docs=true" >> "$GITHUB_OUTPUT"
}
if [ "$EVENT_NAME" = "push" ]; then
  emit_all_true
  exit 0
fi
if [ "$EVENT_NAME" = "schedule" ]; then
  emit_all_true
  exit 0
fi
if ! PR_JSON=$(gh api "repos/$REPOSITORY/pulls/$PR_NUMBER") ||
   ! FILES_JSON=$(gh api "repos/$REPOSITORY/pulls/$PR_NUMBER/files" \
     --paginate --slurp | jq -ce 'add | arrays'); then
  echo "PR file lookup failed; running every gated Lint Code check."
  emit_all_true
  exit 0
fi
FILE_COUNT=$(jq 'length' <<< "$FILES_JSON")
if ! jq -e --arg head "$PR_HEAD_SHA" \
  --arg base "$PR_BASE_SHA" --argjson count "$FILE_COUNT" \
  '.head.sha == $head and .base.sha == $base and .changed_files == $count and $count < 3000' <<< "$PR_JSON" >/dev/null; then
  echo "PR metadata moved or its file list is incomplete; running every gated Lint Code check."
  emit_all_true
  exit 0
fi
# Include both sides of renames. A deleted file remains at filename.
if ! FILES=$(jq -er '
  [.[] | .filename, (.previous_filename // empty)] as $paths
  | if ($paths | length > 0) and all($paths[]; type == "string" and length > 0 and (explode | all(. != 0 and . != 10 and . != 13)))
    then $paths[] else error("invalid path listing") end
' <<< "$FILES_JSON"); then
  echo "Unusable PR file list; running every gated Lint Code check."
  emit_all_true
  exit 0
fi
CODE=$(echo "$FILES" | grep -vcE '\.md$|^docs/|^src-tauri/|^CHANGELOG\.md$|^LICENSE$|\.github/workflows/(build-desktop|docker-publish)\.yml$' || echo 0)
echo "code=$( [ "$CODE" -gt 0 ] && echo true || echo false )" >> "$GITHUB_OUTPUT"
# markdown check: only the lint:md inputs (the markdown, its config, and
# package.json, which holds the command and pins markdownlint-cli2), so
# a code-only PR skips it. LINT_MD_INPUTS in .husky/pre-push plus the lockfile.
MARKDOWN=$(printf '%s\n' "$FILES" | grep -cE '\.md$|^\.markdownlint|^package(-lock)?\.json$' || true)
echo "markdown=$( [ "$MARKDOWN" -gt 0 ] && echo true || echo false )" >> "$GITHUB_OUTPUT"
DOCS=$(printf '%s\n' "$FILES" | grep -cE '^docs/|^scripts/check-doc-anchors\.mjs$|^scripts/_html-entities\.mjs$|^scripts/mint-export-preload\.mjs$|^\.github/workflows/lint-code\.yml$|^\.github/scripts/lint-code-changes\.sh$' || true)
echo "docs=$( [ "$DOCS" -gt 0 ] && echo true || echo false )" >> "$GITHUB_OUTPUT"
