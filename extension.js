import Clutter from 'gi://Clutter';
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

export default class GnomePostUiExtension extends Extension {
    enable() {
        this._signals = [];

        this._indicator = new PanelMenu.Button(0.0, 'Gnome Post UI', false);
        this._indicator.add_child(new St.Label({
            text: 'AI',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'post-ui-panel-label',
        }));

        this._signals.push([
            this._indicator,
            this._indicator.connect('button-press-event', () => {
                this._toggleOverlay();
                return Clutter.EVENT_STOP;
            }),
        ]);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._buildOverlay();
    }

    disable() {
        for (const [actor, id] of this._signals ?? [])
            actor.disconnect(id);

        this._signals = [];
        this._indicator?.destroy();
        this._indicator = null;
        this._shade?.destroy();
        this._shade = null;
        this._surface?.destroy();
        this._surface = null;
    }

    _buildOverlay() {
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
                this._hideOverlay();
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

        this._entry = new St.Entry({
            hint_text: 'Try: focus, glass, chat, reset',
            can_focus: true,
            style_class: 'post-ui-entry',
        });

        this._signals.push([
            this._entry.clutter_text,
            this._entry.clutter_text.connect('key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();

                if (symbol === Clutter.KEY_Escape) {
                    this._hideOverlay();
                    return Clutter.EVENT_STOP;
                }

                if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                    this._runCommand();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            }),
        ]);

        this._response = new St.Label({
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

        this._surface.add_child(eyebrow);
        this._surface.add_child(title);
        this._surface.add_child(subtitle);
        this._surface.add_child(this._entry);
        this._surface.add_child(this._response);
        this._surface.add_child(toggles);
        this._surface.add_child(commandHints);

        Main.uiGroup.add_child(this._shade);
        Main.uiGroup.add_child(this._surface);
        this._relayout();

        this._signals.push([
            Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => this._relayout()),
        ]);
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

    _runCommand() {
        const rawText = this._entry.get_text().trim().toLowerCase();
        const key = [...COMMANDS.keys()].find(command => rawText.includes(command));
        const response = key
            ? COMMANDS.get(key)
            : 'No fixed screen needed. GNOME can translate intent into the next control.';

        this._response.set_text(response);
        this._surface.remove_style_pseudo_class('pulse');
        this._surface.add_style_pseudo_class('pulse');
    }

    _toggleOverlay() {
        if (this._surface.visible)
            this._hideOverlay();
        else
            this._showOverlay();
    }

    _showOverlay() {
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

        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _hideOverlay() {
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

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        const width = Math.min(760, Math.floor(monitor.width * 0.82));

        this._shade.set_position(monitor.x, monitor.y);
        this._shade.set_size(monitor.width, monitor.height);
        this._surface.set_width(width);
        this._surface.set_position(
            monitor.x + Math.floor((monitor.width - width) / 2),
            monitor.y + Math.floor(monitor.height * 0.18)
        );
    }
}
