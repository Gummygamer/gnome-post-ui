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
