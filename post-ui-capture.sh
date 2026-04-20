# gnome-post-ui terminal capture hook (bash + zsh).
# Source from ~/.bashrc or ~/.zshrc:
#   source ~/.local/share/gnome-shell/extensions/gnome-post-ui@darabat.local/post-ui-capture.sh
#
# Every prompt records the last command, exit status, cwd, and timestamp to
# $POST_UI_CAPTURE_DIR. To also capture combined stdout/stderr, prefix the
# command with `aic`, e.g. `aic make test`.

POST_UI_CAPTURE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/gnome-post-ui"
mkdir -p "$POST_UI_CAPTURE_DIR" 2>/dev/null || true
export POST_UI_CAPTURE_DIR

_post_ui_write() {
    printf '%s' "$2" > "$POST_UI_CAPTURE_DIR/$1" 2>/dev/null
}

aic() {
    if [ $# -eq 0 ]; then
        printf 'Usage: aic <command>\n' >&2
        return 2
    fi

    _post_ui_skip_next_precmd=1
    _post_ui_write last-command.txt "$*"
    _post_ui_write last-cwd "$PWD"
    _post_ui_write last-time "$(date +%s)"
    : > "$POST_UI_CAPTURE_DIR/last-output.txt"

    eval "$*" 2>&1 | tee "$POST_UI_CAPTURE_DIR/last-output.txt"
    local ec
    if [ -n "${BASH_VERSION:-}" ]; then
        ec=${PIPESTATUS[0]}
    elif [ -n "${ZSH_VERSION:-}" ]; then
        ec=${pipestatus[1]}
    else
        ec=$?
    fi

    _post_ui_write last-exit "$ec"
    _post_ui_write last-has-output 1
    return "$ec"
}

_post_ui_precmd() {
    local ec=$?

    if [ "${_post_ui_skip_next_precmd:-0}" = "1" ]; then
        _post_ui_skip_next_precmd=0
        return
    fi

    local last=""
    if [ -n "${BASH_VERSION:-}" ]; then
        last=$(HISTTIMEFORMAT='' history 1 2>/dev/null | sed -e 's/^[[:space:]]*[0-9]\{1,\}[[:space:]]*//')
    elif [ -n "${ZSH_VERSION:-}" ]; then
        last=$(fc -ln -1 2>/dev/null | sed -e 's/^[[:space:]]*//')
    fi

    case "$last" in
        ''|aic|aic\ *) return ;;
    esac

    _post_ui_write last-command.txt "$last"
    _post_ui_write last-cwd "$PWD"
    _post_ui_write last-time "$(date +%s)"
    _post_ui_write last-exit "$ec"
    _post_ui_write last-has-output 0
    : > "$POST_UI_CAPTURE_DIR/last-output.txt"
}

if [ -n "${BASH_VERSION:-}" ]; then
    case "${PROMPT_COMMAND:-}" in
        *_post_ui_precmd*) ;;
        '') PROMPT_COMMAND="_post_ui_precmd" ;;
        *) PROMPT_COMMAND="_post_ui_precmd; $PROMPT_COMMAND" ;;
    esac
elif [ -n "${ZSH_VERSION:-}" ]; then
    autoload -Uz add-zsh-hook 2>/dev/null
    add-zsh-hook precmd _post_ui_precmd 2>/dev/null
fi
