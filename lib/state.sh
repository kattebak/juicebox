#!/bin/sh
# state.sh — state.json + private-key.pem I/O for as-me.
#
# State dir defaults to ~/.config/as-me but can be overridden with
# AS_ME_STATE_DIR for tests / sandboxed installs.

as_me_state_dir() {
    if [ -n "${AS_ME_STATE_DIR:-}" ]; then
        printf '%s\n' "$AS_ME_STATE_DIR"
    else
        printf '%s/.config/as-me\n' "$HOME"
    fi
}

state_path() {
    printf '%s/state.json\n' "$(as_me_state_dir)"
}

pem_path() {
    printf '%s/private-key.pem\n' "$(as_me_state_dir)"
}

ensure_dir() {
    dir=$(as_me_state_dir)
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
    fi
    chmod 0700 "$dir" 2>/dev/null || true
}

# load_state — prints the state JSON to stdout. Empty/missing files
# produce a default object with `installations: {}` so callers can use
# jq directly without null-handling.
load_state() {
    ensure_dir
    sp=$(state_path)
    if [ ! -f "$sp" ]; then
        printf '{"installations":{}}\n'
        return 0
    fi
    # If the file lacks `installations`, default it to {}.
    jq '. + {installations: (.installations // {})}' <"$sp"
}

# save_state — reads JSON from stdin, writes to state.json with mode 0600.
save_state() {
    ensure_dir
    sp=$(state_path)
    tmp=$(mktemp "${sp}.XXXXXX")
    if ! jq '.' >"$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    mv "$tmp" "$sp"
    chmod 0600 "$sp" 2>/dev/null || true
}

write_pem() {
    ensure_dir
    pp=$(pem_path)
    tmp=$(mktemp "${pp}.XXXXXX")
    cat >"$tmp"
    mv "$tmp" "$pp"
    chmod 0600 "$pp" 2>/dev/null || true
}

read_pem() {
    pp=$(pem_path)
    if [ ! -f "$pp" ]; then
        printf 'No private key at %s\n' "$pp" >&2
        return 1
    fi
    cat "$pp"
}
