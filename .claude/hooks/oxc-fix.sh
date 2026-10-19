#!/bin/sh
cd "$CLAUDE_PROJECT_DIR" || exit 0
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx) ;;
  *.json | *.css | *.md | *.yml | *.yaml)
    bunx oxfmt --no-error-on-unmatched-pattern "$file" >/dev/null
    exit 0
    ;;
  *) exit 0 ;;
esac
bunx oxlint --fix --fix-suggestions --no-error-on-unmatched-pattern "$file" >/dev/null
bunx oxfmt --no-error-on-unmatched-pattern "$file" >/dev/null
bunx oxlint --no-error-on-unmatched-pattern "$file" >&2 || exit 2
