# Gnome Post UI

A GNOME Shell 49 extension that applies the opening design motifs from Enrico Tartarotti's "The Weird Death Of User Interfaces":

- Liquid glass surfaces with depth, translucency, and light edges.
- Physical-feeling controls instead of flat checkboxes.
- A command-first overlay that feels closer to a chat or terminal than a dashboard.
- Reduced menu emphasis, with intent-driven commands front and center.

## Use

Install the extension into your user extensions directory:

```sh
./install.sh
```

If the extension is already enabled, the installer reloads it after copying the updated files. If it is not enabled yet, run:

```sh
gnome-extensions enable gnome-post-ui@darabat.local
```

Click the `AI` indicator in the top panel to ask DuckDuckGo Instant Answers. Click the `UI` indicator to open the local command overlay, then try commands like `focus`, `glass`, `chat`, or `reset`.

For AI summaries, create a free Gemini API key in Google AI Studio and save it locally:

```sh
mkdir -p ~/.config/gnome-post-ui
printf '%s\n' 'YOUR_GEMINI_API_KEY' > ~/.config/gnome-post-ui/gemini-api-key
chmod 600 ~/.config/gnome-post-ui/gemini-api-key
./install.sh
```

When the key is present, the `AI` panel searches DuckDuckGo and asks Gemini to summarize the top results. If DuckDuckGo does not return parseable results, it asks Gemini with Google Search grounding and displays any returned sources. Without a key, it falls back to showing the raw DuckDuckGo results.

## Terminal capture (`TX` button)

The `TX` indicator sends your last shell command and its output to the AI panel, and asks Gemini to explain it. To enable, source the hook shipped with the extension in your shell config:

```sh
# bash
echo 'source ~/.local/share/gnome-shell/extensions/gnome-post-ui@darabat.local/post-ui-capture.sh' >> ~/.bashrc

# zsh
echo 'source ~/.local/share/gnome-shell/extensions/gnome-post-ui@darabat.local/post-ui-capture.sh' >> ~/.zshrc
```

Every prompt records the last command, exit status, and working directory to `~/.cache/gnome-post-ui/`. To also capture the command's combined stdout/stderr, prefix the command with `aic`, for example `aic make test`. Click `TX` afterwards to get a Gemini explanation.
