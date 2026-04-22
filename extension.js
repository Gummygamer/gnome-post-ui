import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const COMMANDS = new Map([
    ['focus', 'Focus mode prepared. Notifications and panels stay visually quiet.'],
    ['glass', 'Liquid glass surface active. Controls respond with depth and motion.'],
    ['chat', 'Command layer ready. Describe the outcome instead of hunting menus.'],
    ['reset', 'Visual state reset.'],
]);

const GLASS_WINDOW_OPACITY = 228;
const GLASS_WINDOW_PADDING = 10;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_SYSTEM_PROMPT = 'You are the assistant for a GNOME desktop AI panel. Be concise, practical, and cautious about current-status claims. When grounding is available, use it and cite concrete sources when they matter. If the evidence is incomplete, say what can and cannot be verified. Do not invent facts.';
const TARGET_WINDOW_MATCHERS = [
    'alacritty',
    'com.mitchellh.ghostty',
    'dolphin',
    'gnome-terminal',
    'gnome-terminal-server',
    'io.elementary.files',
    'io.github.alacritty',
    'kgx',
    'kitty',
    'konsole',
    'nautilus',
    'nemo',
    'org.gnome.console',
    'org.gnome.files',
    'org.gnome.nautilus',
    'org.gnome.ptyxis',
    'org.gnome.terminal',
    'org.wezfurlong.wezterm',
    'pcmanfm',
    'ptyxis',
    'thunar',
    'tilix',
    'wezterm',
    'xfce4-terminal',
];

export default class GnomePostUiExtension extends Extension {
    enable() {
        this._signals = [];
        this._glassWindows = new Map();
        this._pendingGlassWindows = new Set();
        this._timeoutIds = [];
        this._activeAiQuery = 0;
        this._aiConversation = [];
        this._aiTranscript = [];
        this._session = new Soup.Session({
            timeout: 20,
            user_agent: 'gnome-post-ui/1.0',
        });

        this._indicator = new PanelMenu.Button(0.0, 'Gnome Post UI AI', false);
        this._indicator.add_child(new St.Label({
            text: 'AI',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'post-ui-panel-label',
        }));
        this._signals.push([
            this._indicator,
            this._indicator.connect('button-press-event', () => {
                this._toggleAiOverlay();
                return Clutter.EVENT_STOP;
            }),
        ]);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._ctrlIndicator = new PanelMenu.Button(0.0, 'Gnome Post UI Controls', false);
        this._ctrlIndicator.add_child(new St.Label({
            text: 'UI',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'post-ui-panel-label',
        }));
        this._signals.push([
            this._ctrlIndicator,
            this._ctrlIndicator.connect('button-press-event', () => {
                this._toggleCtrlOverlay();
                return Clutter.EVENT_STOP;
            }),
        ]);
        Main.panel.addToStatusArea(`${this.uuid}-ctrl`, this._ctrlIndicator);

        this._txIndicator = new PanelMenu.Button(0.0, 'Gnome Post UI Terminal Capture', false);
        this._txIndicator.add_child(new St.Label({
            text: 'TX',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'post-ui-panel-label',
        }));
        this._signals.push([
            this._txIndicator,
            this._txIndicator.connect('button-press-event', () => {
                this._captureTerminal();
                return Clutter.EVENT_STOP;
            }),
        ]);
        Main.panel.addToStatusArea(`${this.uuid}-tx`, this._txIndicator);

        this._buildAiOverlay();
        this._buildCtrlOverlay();
        this._enableWindowGlass();
    }

    disable() {
        this._disableWindowGlass();
        this._session = null;

        for (const [actor, id] of this._signals ?? [])
            actor.disconnect(id);

        this._signals = [];
        this._indicator?.destroy();
        this._indicator = null;
        this._ctrlIndicator?.destroy();
        this._ctrlIndicator = null;
        this._txIndicator?.destroy();
        this._txIndicator = null;
        this._shade?.destroy();
        this._shade = null;
        this._surface?.destroy();
        this._surface = null;
        this._ctrlShade?.destroy();
        this._ctrlShade = null;
        this._ctrlSurface?.destroy();
        this._ctrlSurface = null;
        this._activeAiQuery += 1;
    }

    _enableWindowGlass() {
        this._signals.push([
            global.display,
            global.display.connect('window-created', (_display, window) => {
                this._trackGlassWindow(window);
            }),
        ]);

        this._signals.push([
            global.display,
            global.display.connect('restacked', () => {
                for (const window of this._glassWindows.keys())
                    this._syncGlassWindow(window);
            }),
        ]);

        for (const actor of global.get_window_actors())
            this._trackGlassWindow(actor.get_meta_window());
    }

    _disableWindowGlass() {
        for (const id of this._timeoutIds ?? [])
            GLib.Source.remove(id);

        this._timeoutIds = [];
        this._pendingGlassWindows?.clear();

        for (const window of [...this._glassWindows.keys()])
            this._untrackGlassWindow(window);

        this._glassWindows = new Map();
    }

    _trackGlassWindow(window) {
        if (!this._shouldGlassWindow(window) || this._glassWindows.has(window))
            return;

        const actor = window.get_compositor_private();

        if (!actor) {
            this._queueGlassWindow(window);
            return;
        }

        const plate = new St.Widget({
            style_class: 'post-ui-window-glass',
            reactive: false,
        });

        this._glassWindows.set(window, {
            actor,
            plate,
            originalOpacity: actor.opacity,
        });

        this._addGlassPlateBelowWindow(window);
        actor.set_opacity(GLASS_WINDOW_OPACITY);
        this._syncGlassWindow(window);

        window.connectObject(
            'position-changed',
            () => this._syncGlassWindow(window),
            'size-changed',
            () => this._syncGlassWindow(window),
            'unmanaged',
            () => this._untrackGlassWindow(window),
            this
        );
    }

    _queueGlassWindow(window) {
        if (this._pendingGlassWindows.has(window))
            return;

        this._pendingGlassWindows.add(window);

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            this._timeoutIds = this._timeoutIds.filter(timeoutId => timeoutId !== id);
            this._pendingGlassWindows.delete(window);
            this._trackGlassWindow(window);

            return GLib.SOURCE_REMOVE;
        });

        this._timeoutIds.push(id);
    }

    _untrackGlassWindow(window) {
        const data = this._glassWindows.get(window);

        if (!data)
            return;

        window.disconnectObject(this);
        data.actor?.set_opacity(data.originalOpacity ?? 255);
        data.plate?.destroy();
        this._glassWindows.delete(window);
    }

    _syncGlassWindow(window) {
        const data = this._glassWindows.get(window);

        if (!data)
            return;

        if (!this._shouldGlassWindow(window)) {
            this._untrackGlassWindow(window);
            return;
        }

        this._addGlassPlateBelowWindow(window);

        const {x, y, width, height} = window.get_frame_rect();
        const visible = !window.minimized && window.showing_on_its_workspace();

        data.actor.set_opacity(GLASS_WINDOW_OPACITY);
        data.plate.set({
            x: x - GLASS_WINDOW_PADDING,
            y: y - GLASS_WINDOW_PADDING,
            width: width + GLASS_WINDOW_PADDING * 2,
            height: height + GLASS_WINDOW_PADDING * 2,
            visible,
        });
    }

    _addGlassPlateBelowWindow(window) {
        const data = this._glassWindows.get(window);
        const actor = window.get_compositor_private();
        const parent = actor?.get_parent() ?? global.window_group;

        if (!data || !actor)
            return;

        if (data.plate.get_parent() !== parent) {
            data.plate.get_parent()?.remove_child(data.plate);
            parent.add_child(data.plate);
        }

        parent.set_child_below_sibling(data.plate, actor);
    }

    _shouldGlassWindow(window) {
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;

        if (window.is_fullscreen())
            return false;

        const identifiers = [
            window.get_gtk_application_id?.(),
            window.get_wm_class?.(),
            window.get_wm_class_instance?.(),
            window.get_title?.(),
        ].filter(Boolean).map(value => value.toLowerCase());

        return identifiers.some(identifier => {
            if (identifier.includes('terminal'))
                return true;

            return TARGET_WINDOW_MATCHERS.some(matcher => identifier.includes(matcher));
        });
    }

    _buildAiOverlay() {
        this._shade = new St.Widget({
            style_class: 'post-ui-shade',
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._surface = new St.BoxLayout({
            vertical: true,
            style_class: 'post-ui-surface',
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._signals.push([
            this._shade,
            this._shade.connect('button-press-event', () => {
                this._hideAiOverlay();
                return Clutter.EVENT_STOP;
            }),
        ]);

        const eyebrow = new St.Label({
            text: 'INSTANT SEARCH',
            style_class: 'post-ui-eyebrow',
        });

        const title = new St.Label({
            text: 'Ask anything.',
            style_class: 'post-ui-title',
        });

        const subtitle = new St.Label({
            text: 'Powered by Gemini with grounded web answers.',
            style_class: 'post-ui-subtitle',
        });

        this._aiEntry = new St.Entry({
            hint_text: 'Search or ask a question...',
            can_focus: true,
            style_class: 'post-ui-entry',
        });

        this._signals.push([
            this._aiEntry.clutter_text,
            this._aiEntry.clutter_text.connect('key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();

                if (symbol === Clutter.KEY_Escape) {
                    this._hideAiOverlay();
                    return Clutter.EVENT_STOP;
                }

                if (symbol === Clutter.KEY_Return ||
                    symbol === Clutter.KEY_KP_Enter ||
                    symbol === Clutter.KEY_ISO_Enter) {
                    this._queryDuckDuckGo();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            }),
        ]);
        this._signals.push([
            this._aiEntry.clutter_text,
            this._aiEntry.clutter_text.connect('activate', () => {
                this._queryDuckDuckGo();
            }),
        ]);

        this._aiResponseScroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,
            style_class: 'post-ui-response-scroll',
            style: 'max-height: 320px;',
            x_expand: true,
        });

        this._aiResponseBox = new St.BoxLayout({
            vertical: true,
            style_class: 'post-ui-response',
            x_expand: true,
        });

        this._aiResponse = new St.Label({
            text: 'Enter a question above and press Return.',
            style_class: 'post-ui-response-text',
            x_expand: true,
        });
        this._aiResponse.clutter_text.line_wrap = true;
        this._aiResponse.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._aiResponse.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this._aiResponseBox.add_child(this._aiResponse);
        this._aiResponseScroll.set_child(this._aiResponseBox);

        const responseAdjustment = this._aiResponseScroll
            .get_vscroll_bar()
            .get_adjustment();
        this._signals.push([
            responseAdjustment,
            responseAdjustment.connect('notify::value', () => {
                this._aiResponse?.queue_redraw();
                this._aiResponseBox?.queue_redraw();
            }),
        ]);

        this._surface.add_child(eyebrow);
        this._surface.add_child(title);
        this._surface.add_child(subtitle);
        this._surface.add_child(this._aiEntry);
        this._surface.add_child(this._aiResponseScroll);

        Main.uiGroup.add_child(this._shade);
        Main.uiGroup.add_child(this._surface);
        this._relayout();

        this._signals.push([
            Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => this._relayout()),
        ]);
    }

    _buildCtrlOverlay() {
        this._ctrlShade = new St.Widget({
            style_class: 'post-ui-shade',
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._ctrlSurface = new St.BoxLayout({
            vertical: true,
            style_class: 'post-ui-surface',
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._signals.push([
            this._ctrlShade,
            this._ctrlShade.connect('button-press-event', () => {
                this._hideCtrlOverlay();
                return Clutter.EVENT_STOP;
            }),
        ]);

        const eyebrow = new St.Label({
            text: 'POST-UI MODE',
            style_class: 'post-ui-eyebrow',
        });

        const title = new St.Label({
            text: 'Tell GNOME what you want.',
            style_class: 'post-ui-title',
        });

        const subtitle = new St.Label({
            text: 'A sparse command layer, liquid surfaces, and controls with physical weight.',
            style_class: 'post-ui-subtitle',
        });

        this._ctrlEntry = new St.Entry({
            hint_text: 'Try: focus, glass, chat, reset',
            can_focus: true,
            style_class: 'post-ui-entry',
        });

        this._signals.push([
            this._ctrlEntry.clutter_text,
            this._ctrlEntry.clutter_text.connect('key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();

                if (symbol === Clutter.KEY_Escape) {
                    this._hideCtrlOverlay();
                    return Clutter.EVENT_STOP;
                }

                if (symbol === Clutter.KEY_Return ||
                    symbol === Clutter.KEY_KP_Enter ||
                    symbol === Clutter.KEY_ISO_Enter) {
                    this._runCommand();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            }),
        ]);

        this._ctrlResponse = new St.Label({
            text: 'The old dashboard stays out of the way. The command becomes the interface.',
            style_class: 'post-ui-response',
        });

        const toggles = new St.BoxLayout({
            style_class: 'post-ui-toggle-grid',
        });

        toggles.add_child(this._makeToggle('Liquid glass', true));
        toggles.add_child(this._makeToggle('Physical motion', true));
        toggles.add_child(this._makeToggle('Menu reduction', false));

        const commandHints = new St.BoxLayout({
            vertical: true,
            style_class: 'post-ui-hints',
        });

        commandHints.add_child(new St.Label({
            text: 'focus   reduce visual noise around the active task',
            style_class: 'post-ui-hint',
        }));
        commandHints.add_child(new St.Label({
            text: 'glass   emphasize depth, blur, and tactile controls',
            style_class: 'post-ui-hint',
        }));
        commandHints.add_child(new St.Label({
            text: 'chat    keep interaction in language before menus',
            style_class: 'post-ui-hint',
        }));

        this._ctrlSurface.add_child(eyebrow);
        this._ctrlSurface.add_child(title);
        this._ctrlSurface.add_child(subtitle);
        this._ctrlSurface.add_child(this._ctrlEntry);
        this._ctrlSurface.add_child(this._ctrlResponse);
        this._ctrlSurface.add_child(toggles);
        this._ctrlSurface.add_child(commandHints);

        Main.uiGroup.add_child(this._ctrlShade);
        Main.uiGroup.add_child(this._ctrlSurface);
        this._relayout();
    }

    _makeToggle(label, active) {
        const row = new St.BoxLayout({
            style_class: active ? 'post-ui-toggle is-active' : 'post-ui-toggle',
        });

        row.add_child(new St.Widget({
            style_class: 'post-ui-toggle-track',
        }));

        row.add_child(new St.Label({
            text: label,
            style_class: 'post-ui-toggle-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        return row;
    }

    _captureTerminal() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-post-ui']);
        const read = name => {
            try {
                const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
                const [ok, bytes] = file.load_contents(null);

                if (!ok)
                    return '';

                return new TextDecoder().decode(bytes);
            } catch (_e) {
                return '';
            }
        };

        const command = read('last-command.txt').replace(/\n+$/, '');
        const output = read('last-output.txt').replace(/\n+$/, '');
        const exitCode = read('last-exit').trim();
        const cwd = read('last-cwd').trim();
        const hasOutput = read('last-has-output').trim() === '1';

        this._showAiOverlay();
        this._aiEntry.set_text('');

        if (!command) {
            this._setAiResponse([
                'No terminal capture yet.',
                '',
                'Add this to ~/.bashrc or ~/.zshrc:',
                `  source ~/.local/share/gnome-shell/extensions/${this.uuid}/post-ui-capture.sh`,
                '',
                'Run any command to capture it, or prefix with `aic` to also capture its output.',
            ].join('\n'));
            return;
        }

        const contextLines = [`$ ${command}`];

        if (cwd)
            contextLines.push(`(in ${cwd})`);

        if (exitCode)
            contextLines.push(`exit ${exitCode}`);

        if (hasOutput && output) {
            const clipped = output.length > 4000
                ? `${output.slice(-4000)}\n[...truncated to last 4000 chars]`
                : output;
            contextLines.push('', clipped);
        } else {
            contextLines.push('', '(Output was not captured — prefix the command with `aic` to include output.)');
        }

        const context = contextLines.join('\n');
        this._setAiResponse(`${context}\n\nAsking Gemini...`);
        this._pulseAiSurface();

        const apiKey = this._readGeminiApiKey();

        if (!apiKey) {
            this._setAiResponse(`${context}\n\nAdd a Gemini API key at ~/.config/gnome-post-ui/gemini-api-key to get explanations.`);
            return;
        }

        const queryId = ++this._activeAiQuery;
        const prompt = [
            `Command: ${command}`,
            cwd && `Working directory: ${cwd}`,
            exitCode && `Exit status: ${exitCode}`,
            hasOutput && output ? `Output:\n${output}` : 'Output was not captured.',
            '',
            'Explain what happened in 2-4 short sentences. If the exit status is non-zero or the output indicates an error, name the likely cause and a concrete fix.',
        ].filter(Boolean).join('\n');

        this._queryGemini(
            apiKey,
            [{role: 'user', parts: [{text: prompt}]}],
            queryId,
            data => {
                const summary = this._extractGeminiText(data);

                if (!summary) {
                    this._setAiResponse(`${context}\n\nGemini returned no explanation.`);
                    this._pulseAiSurface();
                    return;
                }

                this._setAiResponse(`${context}\n\nAI explanation:\n\n${summary}`);
                this._pulseAiSurface();
            },
            error => {
                this._setAiResponse(`${context}\n\nGemini failed: ${error.message || String(error)}`);
                this._pulseAiSurface();
            }
        );
    }

    _queryDuckDuckGo() {
        const query = this._aiEntry.get_text().trim();
        if (!query)
            return;

        this._aiEntry.set_text('');

        if (this._hasActiveGeminiConversation()) {
            this._continueGeminiConversation(query);
            return;
        }

        const queryId = ++this._activeAiQuery;

        this._setAiResponse('Searching...');
        this._aiEntry.reactive = false;
        this._surface.remove_style_pseudo_class('pulse');

        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
        const message = Soup.Message.new('GET', url);

        try {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                if (queryId !== this._activeAiQuery || !this._aiResponse)
                    return;

                try {
                    const bytes = sess.send_and_read_finish(result);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const data = JSON.parse(text);
                    const response = this._formatDuckDuckGoResponse(data);

                    if (response) {
                        this._aiEntry.reactive = true;
                        this._setAiResponse(response);
                        this._pulseAiSurface();
                    } else {
                        this._queryDuckDuckGoSearch(query, queryId);
                    }
                } catch (e) {
                    this._queryDuckDuckGoSearch(query, queryId);
                }
            });
        } catch (e) {
            this._queryDuckDuckGoSearch(query, queryId);
        }
    }

    _setAiResponse(text) {
        this._aiResponse.set_text(text);
        this._aiResponse.queue_relayout();
        this._aiResponseBox?.queue_relayout();
        this._aiResponseScroll?.queue_relayout();
        this._surface?.queue_relayout();
    }

    _formatDuckDuckGoResponse(data) {
        const content = [
            data.Answer,
            data.AbstractText,
            data.Definition,
            this._findRelatedTopicText(data.RelatedTopics),
        ].find(value => typeof value === 'string' && value.trim());

        if (!content)
            return '';

        const source = data.AbstractSource || data.DefinitionSource || data.Heading || '';
        return source ? `${content}\n\n- ${source}` : content;
    }

    _queryDuckDuckGoSearch(query, queryId, useHtmlEndpoint = false) {
        const endpoint = useHtmlEndpoint
            ? 'https://html.duckduckgo.com/html/'
            : 'https://lite.duckduckgo.com/lite/';
        const url = `${endpoint}?q=${encodeURIComponent(query)}`;
        const message = Soup.Message.new('GET', url);

        try {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                if (queryId !== this._activeAiQuery || !this._aiResponse)
                    return;

                this._aiEntry.reactive = true;

                try {
                    const bytes = sess.send_and_read_finish(result);
                    const html = new TextDecoder().decode(bytes.get_data());
                    const results = this._parseDuckDuckGoSearchResults(html).slice(0, 3);

                    if (results.length === 0 && !useHtmlEndpoint) {
                        this._queryDuckDuckGoSearch(query, queryId, true);
                    } else if (results.length === 0) {
                        this._queryGeminiGrounded(query, queryId);
                    } else {
                        this._queryGeminiSummary(query, results, queryId);
                    }
                } catch (e) {
                    if (!useHtmlEndpoint) {
                        this._queryDuckDuckGoSearch(query, queryId, true);
                    } else {
                        this._queryGeminiGrounded(query, queryId, `Search failed: ${e.message || String(e)}`);
                    }
                }
            });
        } catch (e) {
            if (!useHtmlEndpoint) {
                this._queryDuckDuckGoSearch(query, queryId, true);
            } else {
                this._queryGeminiGrounded(query, queryId, `Search failed: ${e.message || String(e)}`);
            }
        }
    }

    _queryGeminiGrounded(query, queryId, fallbackReason = '') {
        const apiKey = this._readGeminiApiKey();

        if (!apiKey) {
            this._aiEntry.reactive = true;
            this._setAiResponse(`DuckDuckGo did not return an instant answer or search result for "${query}". Try a more specific term or phrase.`);
            this._pulseAiSurface();
            return;
        }

        this._setAiResponse('Searching with Gemini...');

        const prompt = [
            `Question: ${query}`,
            '',
            fallbackReason || 'DuckDuckGo did not return parseable search results.',
            '',
            'Use Google Search grounding for current web context. Answer in 2-4 short sentences. If the search-grounded evidence is insufficient, say what can and cannot be verified. Do not invent current outage facts.',
        ].join('\n');

        this._queryGemini(
            apiKey,
            [{role: 'user', parts: [{text: prompt}]}],
            queryId,
            data => {
                const summary = this._extractGeminiText(data);

                if (!summary)
                    throw new Error(data.error?.message || 'Gemini returned no grounded answer.');

                this._startGeminiConversation(query, summary);
                this._appendGeminiSources(data);
                this._pulseAiSurface();
            },
            error => {
                this._aiEntry.reactive = true;
                this._setAiResponse(`Gemini Search failed: ${error.message || String(error)}`);
                this._pulseAiSurface();
            },
            true
        );
    }

    _queryGeminiSummary(query, results, queryId) {
        const apiKey = this._readGeminiApiKey();

        if (!apiKey) {
            this._setAiResponse(this._formatDuckDuckGoSearchResults(results));
            this._pulseAiSurface();
            return;
        }

        this._setAiResponse('Summarizing with Gemini...');

        this._queryGemini(
            apiKey,
            [{role: 'user', parts: [{text: this._buildGeminiPrompt(query, results)}]}],
            queryId,
            data => {
                const summary = this._extractGeminiText(data);

                if (!summary)
                    throw new Error(data.error?.message || 'Gemini returned no summary.');

                this._startGeminiConversation(query, summary);
                this._appendResultSources(results);
                this._pulseAiSurface();
            },
            error => {
                this._setAiResponse(`${this._formatDuckDuckGoSearchResults(results)}\n\nGemini summary failed: ${error.message || String(error)}`);
                this._pulseAiSurface();
            }
        );
    }

    _queryGemini(apiKey, contents, queryId, onSuccess, onFailure, useGoogleSearch = false) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
        const message = Soup.Message.new('POST', url);
        message.get_request_headers().append('Content-Type', 'application/json');
        message.get_request_headers().append('x-goog-api-key', apiKey);

        const body = {
            system_instruction: {
                parts: [{
                    text: GEMINI_SYSTEM_PROMPT,
                }],
            },
            contents,
            generationConfig: {
                maxOutputTokens: 220,
                temperature: 0.2,
            },
        };

        if (useGoogleSearch)
            body.tools = [{google_search: {}}];

        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)))
        );

        try {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                if (queryId !== this._activeAiQuery || !this._aiResponse)
                    return;

                this._aiEntry.reactive = true;
                    global.stage.set_key_focus(this._aiEntry.clutter_text);

                try {
                    const bytes = sess.send_and_read_finish(result);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const data = JSON.parse(text);

                    onSuccess(data);
                } catch (e) {
                    onFailure(e);
                }
            });
        } catch (e) {
            this._aiEntry.reactive = true;
            onFailure(e);
        }
    }

    _readGeminiApiKey() {
        const envKey = GLib.getenv('GEMINI_API_KEY');
        if (envKey?.trim())
            return envKey.trim();

        const configPath = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'gnome-post-ui',
            'gemini-api-key',
        ]);

        try {
            const file = Gio.File.new_for_path(configPath);
            const [ok, bytes] = file.load_contents(null);

            if (!ok)
                return '';

            return new TextDecoder().decode(bytes).trim();
        } catch (_e) {
            return '';
        }
    }

    _buildGeminiPrompt(query, results) {
        const lines = [
            `Question: ${query}`,
            '',
            'Search results:',
        ];

        for (const [index, result] of results.entries()) {
            lines.push(`${index + 1}. ${result.title}`);
            lines.push(`Snippet: ${result.snippet || 'No snippet.'}`);
            lines.push(`URL: ${result.url || 'No URL.'}`);
        }

        lines.push('');
        lines.push('Answer in 2-4 short sentences. Include whether the evidence is current-status evidence, general troubleshooting, or insufficient.');

        return lines.join('\n');
    }

    _hasActiveGeminiConversation() {
        return this._aiConversation.length >= 2;
    }

    _startGeminiConversation(query, summary) {
        this._aiConversation = [
            {role: 'user', parts: [{text: query}]},
            {role: 'model', parts: [{text: summary}]},
        ];
        this._aiTranscript = [
            {speaker: 'You', text: query},
            {speaker: 'Gemini', text: summary},
        ];
        this._renderAiTranscript();
        this._aiEntry.hint_text = 'Reply to Gemini...';
    }

    _continueGeminiConversation(query) {
        const apiKey = this._readGeminiApiKey();

        if (!apiKey) {
            this._setAiResponse('Add a Gemini API key at ~/.config/gnome-post-ui/gemini-api-key to continue the conversation.');
            this._pulseAiSurface();
            return;
        }

        const queryId = ++this._activeAiQuery;
        const contents = [
            ...this._aiConversation,
            {role: 'user', parts: [{text: query}]},
        ];

        this._aiTranscript.push({speaker: 'You', text: query});
        this._renderAiTranscript('Gemini is replying...');
        this._aiEntry.reactive = false;
        this._surface.remove_style_pseudo_class('pulse');

        this._queryGemini(
            apiKey,
            contents,
            queryId,
            data => {
                const summary = this._extractGeminiText(data);

                if (!summary)
                    throw new Error(data.error?.message || 'Gemini returned no reply.');

                this._aiConversation = [
                    ...contents,
                    {role: 'model', parts: [{text: summary}]},
                ];
                this._aiTranscript.push({speaker: 'Gemini', text: summary});
                this._renderAiTranscript();
                this._appendGeminiSources(data);
                this._pulseAiSurface();
            },
            error => {
                this._renderAiTranscript(`Gemini failed: ${error.message || String(error)}`);
                this._pulseAiSurface();
            },
            true
        );
    }

    _renderAiTranscript(footer = '') {
        const sections = [];

        for (const turn of this._aiTranscript) {
            sections.push(`${turn.speaker}:\n${turn.text}`);
        }

        if (footer)
            sections.push(footer);

        this._setAiResponse(sections.join('\n\n'));
    }

    _appendGeminiSources(data) {
        const sources = this._formatGeminiGroundingSources(data);

        if (!sources)
            return;

        this._setAiResponse(`${this._aiResponse.get_text()}\n\n${sources}`);
    }

    _appendResultSources(results) {
        const sources = this._formatResultSources(results);

        if (!sources)
            return;

        this._setAiResponse(`${this._aiResponse.get_text()}\n\n${sources}`);
    }

    _extractGeminiText(data) {
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        return parts
            .map(part => part.text)
            .filter(text => typeof text === 'string' && text.trim())
            .join('\n')
            .trim();
    }

    _formatGeminiGroundingSources(data) {
        const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const sources = [];
        const seen = new Set();

        for (const chunk of chunks) {
            const uri = chunk.web?.uri;

            if (!uri || seen.has(uri))
                continue;

            seen.add(uri);
            sources.push({
                title: chunk.web?.title || uri,
                uri,
            });
        }

        if (sources.length === 0)
            return '';

        return `Sources:\n${sources
            .slice(0, 3)
            .map((source, index) => `${index + 1}. ${source.title}\n${source.uri}`)
            .join('\n')}`;
    }

    _formatResultSources(results) {
        const sources = results
            .filter(result => result.url)
            .map((result, index) => `${index + 1}. ${result.url}`);

        return sources.length > 0 ? `Sources:\n${sources.join('\n')}` : '';
    }

    _formatDuckDuckGoSearchResults(results) {
        const lines = ['Search results:'];

        for (const [index, result] of results.entries()) {
            lines.push('');
            lines.push(`${index + 1}. ${result.title}`);

            if (result.snippet)
                lines.push(result.snippet);

            if (result.url)
                lines.push(result.url);
        }

        return lines.join('\n');
    }

    _parseDuckDuckGoSearchResults(html) {
        const results = [];
        const linkPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
        const matches = [...html.matchAll(linkPattern)];

        for (let index = 0; index < matches.length; index++) {
            const match = matches[index];
            const attributes = match[1];
            const className = this._extractHtmlAttribute(attributes, 'class');

            if (!className.split(/\s+/).includes('result-link'))
                continue;

            const nextMatch = matches.slice(index + 1).find(candidate =>
                this._extractHtmlAttribute(candidate[1], 'class')
                    .split(/\s+/)
                    .includes('result-link'));
            const blockEnd = nextMatch?.index ?? html.length;
            const block = html.slice(match.index + match[0].length, blockEnd);
            const snippet = block.match(/<td\b[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '';
            const linkText = block.match(/<span\b[^>]*class=['"][^'"]*link-text[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '';

            results.push({
                title: this._cleanHtmlText(match[2]),
                snippet: this._cleanHtmlText(snippet),
                url: this._extractDuckDuckGoResultUrl(this._extractHtmlAttribute(attributes, 'href')) ||
                    this._cleanHtmlText(linkText),
            });
        }

        return results;
    }

    _extractHtmlAttribute(attributes, name) {
        const pattern = new RegExp(`${name}=(['"])([\\s\\S]*?)\\1`, 'i');
        return attributes.match(pattern)?.[2] ?? '';
    }

    _cleanHtmlText(html) {
        return this._decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
    }

    _decodeHtmlEntities(text) {
        const entities = {
            amp: '&',
            apos: "'",
            gt: '>',
            lt: '<',
            nbsp: ' ',
            quot: '"',
        };

        return text
            .replace(/&#x([0-9a-f]+);/gi, (_match, value) =>
                String.fromCharCode(parseInt(value, 16)))
            .replace(/&#([0-9]+);/g, (_match, value) =>
                String.fromCharCode(parseInt(value, 10)))
            .replace(/&([a-z]+);/gi, (match, value) => entities[value] ?? match);
    }

    _extractDuckDuckGoResultUrl(href) {
        const normalizedHref = this._decodeHtmlEntities(href);
        const match = normalizedHref.match(/[?&]uddg=([^&]+)/);

        if (!match)
            return normalizedHref.startsWith('//') ? `https:${normalizedHref}` : normalizedHref;

        try {
            return decodeURIComponent(match[1]);
        } catch (_e) {
            return match[1];
        }
    }

    _pulseAiSurface() {
        this._surface.remove_style_pseudo_class('pulse');
        this._surface.add_style_pseudo_class('pulse');
    }

    _findRelatedTopicText(topics) {
        if (!Array.isArray(topics))
            return '';

        for (const topic of topics) {
            if (typeof topic.Text === 'string' && topic.Text.trim())
                return topic.Text;

            const nestedText = this._findRelatedTopicText(topic.Topics);
            if (nestedText)
                return nestedText;
        }

        return '';
    }

    _runCommand() {
        const rawText = this._ctrlEntry.get_text().trim().toLowerCase();
        const key = [...COMMANDS.keys()].find(command => rawText.includes(command));
        const response = key
            ? COMMANDS.get(key)
            : 'No fixed screen needed. GNOME can translate intent into the next control.';

        this._ctrlResponse.set_text(response);
        this._ctrlSurface.remove_style_pseudo_class('pulse');
        this._ctrlSurface.add_style_pseudo_class('pulse');
    }

    _toggleAiOverlay() {
        if (this._surface.visible)
            this._hideAiOverlay();
        else
            this._showAiOverlay();
    }

    _showAiOverlay() {
        if (this._ctrlSurface.visible)
            this._hideCtrlOverlay();

        this._relayout();
        this._shade.show();
        this._surface.show();

        this._shade.ease({
            opacity: 175,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._surface.set_scale(0.96, 0.96);
        this._surface.ease({
            opacity: 255,
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        global.stage.set_key_focus(this._aiEntry.clutter_text);
    }

    _hideAiOverlay() {
        this._aiConversation = [];
        this._aiTranscript = [];
        this._aiEntry.hint_text = 'Search or ask a question...';
        this._shade.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._shade?.hide(),
        });

        this._surface.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._surface?.hide(),
        });
    }

    _toggleCtrlOverlay() {
        if (this._ctrlSurface.visible)
            this._hideCtrlOverlay();
        else
            this._showCtrlOverlay();
    }

    _showCtrlOverlay() {
        if (this._surface.visible)
            this._hideAiOverlay();

        this._relayout();
        this._ctrlShade.show();
        this._ctrlSurface.show();

        this._ctrlShade.ease({
            opacity: 175,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._ctrlSurface.set_scale(0.96, 0.96);
        this._ctrlSurface.ease({
            opacity: 255,
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        global.stage.set_key_focus(this._ctrlEntry.clutter_text);
    }

    _hideCtrlOverlay() {
        this._ctrlShade.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._ctrlShade?.hide(),
        });

        this._ctrlSurface.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._ctrlSurface?.hide(),
        });
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        const width = Math.min(760, Math.floor(monitor.width * 0.82));

        for (const shade of [this._shade, this._ctrlShade]) {
            if (!shade) continue;
            shade.set_position(monitor.x, monitor.y);
            shade.set_size(monitor.width, monitor.height);
        }

        for (const surface of [this._surface, this._ctrlSurface]) {
            if (!surface) continue;
            surface.set_width(width);
            surface.set_position(
                monitor.x + Math.floor((monitor.width - width) / 2),
                monitor.y + Math.floor(monitor.height * 0.18)
            );
        }
    }
}
