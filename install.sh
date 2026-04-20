#!/usr/bin/env sh
set -eu

uuid="gnome-post-ui@darabat.local"
target="${HOME}/.local/share/gnome-shell/extensions/${uuid}"
gtk_import='@import url("gnome-post-ui.css");'

mkdir -p "${target}"
cp metadata.json extension.js stylesheet.css "${target}/"

install_gtk_css() {
  gtk_dir="${HOME}/.config/${1}"
  gtk_css="${gtk_dir}/gtk.css"

  mkdir -p "${gtk_dir}"
  cp gtk-post-ui.css "${gtk_dir}/gnome-post-ui.css"

  if [ ! -f "${gtk_css}" ]; then
    printf '%s\n' "${gtk_import}" > "${gtk_css}"
  elif ! grep -qxF "${gtk_import}" "${gtk_css}"; then
    tmp_file="${gtk_css}.tmp"
    printf '%s\n' "${gtk_import}" > "${tmp_file}"
    cat "${gtk_css}" >> "${tmp_file}"
    mv "${tmp_file}" "${gtk_css}"
  fi
}

install_gtk_css gtk-3.0
install_gtk_css gtk-4.0

echo "Installed ${uuid} to ${target}"
echo "Installed matching GTK glass CSS to ~/.config/gtk-3.0 and ~/.config/gtk-4.0"

if command -v gnome-extensions >/dev/null 2>&1; then
  if gnome-extensions info "${uuid}" 2>/dev/null | grep -q "Enabled: Yes"; then
    gnome-extensions disable "${uuid}"
    gnome-extensions enable "${uuid}"
    echo "Reloaded the running GNOME Shell extension."
  else
    echo "Run this to enable the extension:"
    echo "gnome-extensions enable ${uuid}"
  fi
else
  echo "Restart GNOME Shell or log out and back in, then run:"
  echo "gnome-extensions enable ${uuid}"
fi

echo "Restart GTK apps such as Terminal and Files to pick up the theme changes."
