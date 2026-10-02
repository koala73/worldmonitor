#!/bin/sh
# Publish a fake git that always reports success. GitHub would prepend this
# directory for later steps if a Makefile wrote it to GITHUB_PATH.
set -eu

poison_dir="${1:?poison directory required}"
github_path="${GITHUB_PATH:?GITHUB_PATH is required}"

mkdir -p "$poison_dir"
cat > "$poison_dir/git" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$poison_dir/git"
printf '%s\n' "$poison_dir" >> "$github_path"
