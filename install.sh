#!/usr/bin/env sh
set -eu

uuid="gnome-post-ui@darabat.local"
target="${HOME}/.local/share/gnome-shell/extensions/${uuid}"

mkdir -p "${target}"
cp metadata.json extension.js stylesheet.css "${target}/"

echo "Installed ${uuid} to ${target}"
echo "Restart GNOME Shell or log out and back in, then run:"
echo "gnome-extensions enable ${uuid}"
