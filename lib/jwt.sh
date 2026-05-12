#!/bin/sh
# jwt.sh — RS256 JWT signing + installation-token minting.
#
# Depends on: openssl, jq, curl. Sources state.sh for the PEM only via
# the caller — this file accepts the PEM as an argument.

# b64url_stdin — read raw bytes from stdin, emit base64url (no padding).
b64url_stdin() {
    openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# app_jwt <app_id> <pem_path> [<iat_override> <exp_override>]
# Emits a signed JWT to stdout. iat/exp can be overridden for deterministic
# testing — both must be passed together if either is.
app_jwt() {
    app_id=$1
    pem_path_arg=$2
    iat_override=${3:-}
    exp_override=${4:-}

    if [ -n "$iat_override" ] && [ -n "$exp_override" ]; then
        iat=$iat_override
        exp=$exp_override
    else
        now=$(date +%s)
        iat=$((now - 60))
        exp=$((now + 540))
    fi

    header_b64=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url_stdin)
    # iss must be a JSON string; jq's @json on a string handles escaping.
    payload_b64=$(
        jq -cn --arg iss "$app_id" --argjson iat "$iat" --argjson exp "$exp" \
            '{iat: $iat, exp: $exp, iss: $iss}' \
            | tr -d '\n' | b64url_stdin
    )
    unsigned="${header_b64}.${payload_b64}"
    sig_b64=$(
        printf '%s' "$unsigned" \
            | openssl dgst -sha256 -sign "$pem_path_arg" -binary \
            | b64url_stdin
    )
    printf '%s.%s\n' "$unsigned" "$sig_b64"
}

# installation_token <app_id> <pem_path> <installation_id>
# Prints the raw JSON response body. Caller extracts .token via jq.
installation_token() {
    app_id=$1
    pem_path_arg=$2
    installation_id=$3
    jwt=$(app_jwt "$app_id" "$pem_path_arg")
    url="https://api.github.com/app/installations/${installation_id}/access_tokens"
    tmp=$(mktemp)
    status=$(
        curl -sS -o "$tmp" -w '%{http_code}' \
            -X POST \
            -H "Authorization: Bearer $jwt" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            -H "User-Agent: as-me" \
            "$url"
    )
    body=$(cat "$tmp")
    rm -f "$tmp"
    case "$status" in
        2*)
            printf '%s\n' "$body"
            ;;
        *)
            printf 'installation token failed %s: %s\n' "$status" "$body" >&2
            return 1
            ;;
    esac
}
