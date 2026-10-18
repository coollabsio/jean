#!/bin/sh
set -eu

# The container ships gh in /usr/bin, but Jean cannot update that root-owned
# binary. Seed Jean's writable managed location on the first start so normal
# CLI updates work without root access. Keep an existing managed copy because
# it can be newer than the image copy.
data_dir=${JEAN_DATA_DIR:-"$HOME/.local/share/com.jean.desktop"}
managed_gh="$data_dir/gh-cli/gh"
if [ ! -x "$managed_gh" ]; then
    system_gh=$(command -v gh)
    mkdir -p "$(dirname "$managed_gh")"
    install -m 0755 "$system_gh" "$managed_gh"
fi

exec jean-server "$@"
