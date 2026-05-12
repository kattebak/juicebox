#!/bin/sh
# shellcheck disable=SC2016
# (Single-quoted strings with backticks are user-facing command-name hints.)
# oauth.sh — device flow, refresh, manifest-code exchange, prompt helpers.
#
# Most public functions mutate a state JSON value that's threaded as a
# variable in the caller. To keep things shell-friendly, the functions
# print the updated JSON to stdout and the caller pipes it into save_state.

# url_decode <string>
# Decodes application/x-www-form-urlencoded (turns '+' into space, %HH into
# the corresponding byte). Pure POSIX — awk + printf via octal escapes.
url_decode() {
    s=$(printf '%s' "$1" | tr '+' ' ')
    # Replace each %HH with \xHH then let printf %b handle it.
    # We can't use %b's \x escapes portably; use awk to rebuild with \0NNN.
    printf '%s' "$s" | awk '
        BEGIN {
            for (i = 0; i < 256; i++) hex[sprintf("%02x", i)] = i
            for (i = 0; i < 256; i++) hex[sprintf("%02X", i)] = i
        }
        {
            n = length($0)
            out = ""
            for (i = 1; i <= n; i++) {
                c = substr($0, i, 1)
                if (c == "%" && i + 2 <= n) {
                    h = substr($0, i + 1, 2)
                    if (h in hex) {
                        out = out sprintf("%c", hex[h])
                        i += 2
                        continue
                    }
                }
                out = out c
            }
            printf "%s", out
        }
    '
}

# url_encode <string>
# RFC 3986 unreserved set: A-Z a-z 0-9 - _ . ~ — everything else is %HH.
# UTF-8-safe: feeds bytes through od and rebuilds, so any byte ≥0x80 also
# encodes correctly.
url_encode() {
    LC_ALL=C printf '%s' "$1" \
        | od -An -tx1 \
        | tr -d ' \n' \
        | awk '
            BEGIN {
                # Map hex pair → safe char (or empty if must percent-encode).
                safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"
                for (i = 1; i <= length(safe); i++) {
                    c = substr(safe, i, 1)
                    # ASCII code for c — derived via printf into a tmp file is
                    # overkill; instead, hand-roll lookup with sprintf("%c", N).
                }
                # Build ascii→hex map: 0..127.
                for (n = 0; n < 128; n++) ord_map[sprintf("%c", n)] = n
                for (i = 1; i <= length(safe); i++) {
                    c = substr(safe, i, 1)
                    ok_hex[sprintf("%02x", ord_map[c])] = c
                }
            }
            {
                n = length($0)
                for (i = 1; i <= n; i += 2) {
                    h = tolower(substr($0, i, 2))
                    if (h in ok_hex) {
                        printf "%s", ok_hex[h]
                    } else {
                        printf "%%%s", toupper(h)
                    }
                }
            }
        '
}

# post_form <url> <body>
# Body is pre-encoded application/x-www-form-urlencoded. Prints response body to
# stdout. Returns non-zero on transport errors or non-2xx status.
post_form() {
    url=$1
    body=$2
    tmp=$(mktemp)
    status=$(
        curl -sS -o "$tmp" -w '%{http_code}' \
            -X POST \
            -H 'Accept: application/json' \
            -H 'Content-Type: application/x-www-form-urlencoded' \
            -H 'User-Agent: juicebox' \
            --data "$body" \
            "$url"
    )
    response=$(cat "$tmp")
    rm -f "$tmp"
    case "$status" in
        2*)
            printf '%s' "$response"
            return 0
            ;;
        *)
            printf '%s' "$response"
            return 1
            ;;
    esac
}

# prompt_callback_url <expect_param>
# Reads a line from stdin. If it parses as a URL, extracts ?<expect_param>=...;
# otherwise treats the whole input as the bare value. Prints the value to
# stdout. Returns non-zero on empty/missing-param input.
prompt_callback_url() {
    expect_param=$1
    printf '\n' >&2
    printf 'from the paste-helper page on kattebak.github.io, copy the %s value\n' "$expect_param" >&2
    printf '(the page also auto-copies it to your clipboard) and paste below — or paste the\n' >&2
    printf "full URL from your browser's address bar if you'd rather.\\n\\n" >&2
    printf 'paste: ' >&2
    IFS= read -r raw_input || return 1
    # Trim surrounding whitespace.
    input=$(printf '%s' "$raw_input" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$input" ]; then
        printf 'empty input\n' >&2
        return 1
    fi
    case "$input" in
        http://*|https://*)
            # Strip everything up to and including the '?' (no query → no value).
            case "$input" in
                *\?*)
                    query=${input#*\?}
                    # Strip URL fragment.
                    query=${query%%#*}
                    ;;
                *)
                    query=
                    ;;
            esac
            value=
            IFS='&'
            # shellcheck disable=SC2086
            set -- $query
            unset IFS
            for pair in "$@"; do
                key=${pair%%=*}
                if [ "$key" = "$expect_param" ]; then
                    raw_value=${pair#*=}
                    value=$(url_decode "$raw_value")
                    break
                fi
            done
            if [ -z "$value" ]; then
                printf 'no %s in pasted input\n' "$expect_param" >&2
                return 1
            fi
            printf '%s\n' "$value"
            ;;
        *)
            printf '%s\n' "$input"
            ;;
    esac
}

# apply_token_response <state_json> <token_response_json>
# Merges access_token / refresh_token / expires_at / refresh_token_expires_at
# into state. Prints the new state JSON.
apply_token_response() {
    state_json=$1
    response_json=$2
    now=$(date +%s)
    printf '%s' "$state_json" | jq \
        --argjson now "$now" \
        --argjson r "$response_json" \
        '
        .access_token = $r.access_token
        | if $r.refresh_token then .refresh_token = $r.refresh_token else . end
        | if $r.expires_in then .expires_at = ($now + ($r.expires_in | tonumber)) else . end
        | if $r.refresh_token_expires_in then
            .refresh_token_expires_at = ($now + ($r.refresh_token_expires_in | tonumber))
          else . end
        '
}

# start_device_flow <client_id>
# Prints the device-flow response JSON. On error JSON ({error,...}), prints
# the error to stderr and returns non-zero. Exit code 7 marks
# device_flow_disabled so callers can branch on it.
start_device_flow() {
    client_id=$1
    body="client_id=$(url_encode "$client_id")"
    response=$(post_form 'https://github.com/login/device/code' "$body") || true
    if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
        printf 'non-JSON from device/code: %s\n' "$response" >&2
        return 1
    fi
    err=$(printf '%s' "$response" | jq -r '.error // empty')
    if [ -n "$err" ]; then
        desc=$(printf '%s' "$response" | jq -r '.error_description // ""')
        printf '%s: %s\n' "$err" "$desc" >&2
        if [ "$err" = "device_flow_disabled" ]; then
            return 7
        fi
        return 1
    fi
    printf '%s\n' "$response"
}

# poll_device_flow <state_json> <device_code> <interval> <expires_in>
# Polls until success/error/timeout. On success prints updated state JSON.
# Exit codes for terminal errors:
#   2 expired_token, 3 access_denied, 7 device_flow_disabled, 1 other.
poll_device_flow() {
    state_json=$1
    device_code=$2
    wait=$3
    expires_in=$4
    client_id=$(printf '%s' "$state_json" | jq -r '.client_id')
    start=$(date +%s)
    deadline=$((start + expires_in))
    while :; do
        sleep "$wait"
        now=$(date +%s)
        if [ "$now" -ge "$deadline" ]; then
            printf 'device flow expired before authorization\n' >&2
            return 2
        fi
        body="client_id=$(url_encode "$client_id")"
        body="${body}&device_code=$(url_encode "$device_code")"
        body="${body}&grant_type=$(url_encode 'urn:ietf:params:oauth:grant-type:device_code')"
        response=$(post_form 'https://github.com/login/oauth/access_token' "$body") || true
        if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
            printf 'non-JSON from access_token: %s\n' "$response" >&2
            return 1
        fi
        err=$(printf '%s' "$response" | jq -r '.error // empty')
        case "$err" in
            authorization_pending)
                continue
                ;;
            slow_down)
                wait=$((wait + 5))
                continue
                ;;
            "")
                # Success. Merge and print.
                apply_token_response "$state_json" "$response"
                return 0
                ;;
            expired_token)
                desc=$(printf '%s' "$response" | jq -r '.error_description // ""')
                printf '%s: %s\n' "$err" "$desc" >&2
                return 2
                ;;
            access_denied)
                desc=$(printf '%s' "$response" | jq -r '.error_description // ""')
                printf '%s: %s\n' "$err" "$desc" >&2
                return 3
                ;;
            device_flow_disabled)
                desc=$(printf '%s' "$response" | jq -r '.error_description // ""')
                printf '%s: %s\n' "$err" "$desc" >&2
                return 7
                ;;
            *)
                desc=$(printf '%s' "$response" | jq -r '.error_description // ""')
                printf '%s: %s\n' "$err" "$desc" >&2
                return 1
                ;;
        esac
    done
}

# fetch_authenticated_login <token>
# Prints the user's login (no @) from GET /user.
fetch_authenticated_login() {
    token=$1
    tmp=$(mktemp)
    status=$(
        curl -sS -o "$tmp" -w '%{http_code}' \
            -H "Authorization: Bearer $token" \
            -H 'Accept: application/vnd.github+json' \
            -H 'X-GitHub-Api-Version: 2022-11-28' \
            -H 'User-Agent: juicebox' \
            'https://api.github.com/user'
    )
    body=$(cat "$tmp")
    rm -f "$tmp"
    case "$status" in
        2*) ;;
        *)
            printf 'GET /user failed %s\n' "$status" >&2
            return 1
            ;;
    esac
    printf '%s' "$body" | jq -r '.login // empty'
}

# refresh_if_needed <state_json>
# Prints `<token>\t<new_state_json>`. If the state is updated, caller
# must save it. If refresh isn't needed, the state is unchanged.
refresh_if_needed() {
    state_json=$1
    access_token=$(printf '%s' "$state_json" | jq -r '.access_token // empty')
    if [ -z "$access_token" ]; then
        printf 'not logged in; run `juice-bot login`\n' >&2
        return 1
    fi
    now=$(date +%s)
    expires_at=$(printf '%s' "$state_json" | jq -r '.expires_at // empty')
    if [ -n "$expires_at" ]; then
        delta=$((expires_at - now))
        if [ "$delta" -gt 300 ]; then
            printf '%s\t%s\n' "$access_token" "$state_json"
            return 0
        fi
    fi
    refresh_token=$(printf '%s' "$state_json" | jq -r '.refresh_token // empty')
    if [ -z "$refresh_token" ]; then
        printf 'token expired and no refresh token; run `juice-bot login`\n' >&2
        return 1
    fi
    refresh_exp=$(printf '%s' "$state_json" | jq -r '.refresh_token_expires_at // empty')
    if [ -n "$refresh_exp" ] && [ "$refresh_exp" -lt "$now" ]; then
        printf 'refresh token expired; run `juice-bot login`\n' >&2
        return 1
    fi
    client_id=$(printf '%s' "$state_json" | jq -r '.client_id')
    client_secret=$(printf '%s' "$state_json" | jq -r '.client_secret')
    body="client_id=$(url_encode "$client_id")"
    body="${body}&client_secret=$(url_encode "$client_secret")"
    body="${body}&grant_type=refresh_token"
    body="${body}&refresh_token=$(url_encode "$refresh_token")"
    response=$(post_form 'https://github.com/login/oauth/access_token' "$body") || true
    if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
        printf 'non-JSON refresh response: %s\n' "$response" >&2
        return 1
    fi
    err=$(printf '%s' "$response" | jq -r '.error // empty')
    if [ -n "$err" ]; then
        desc=$(printf '%s' "$response" | jq -r '.error_description // ""')
        printf '%s: %s\n' "$err" "$desc" >&2
        return 1
    fi
    new_state=$(apply_token_response "$state_json" "$response")
    new_token=$(printf '%s' "$new_state" | jq -r '.access_token')
    printf '%s\t%s\n' "$new_token" "$new_state"
}
