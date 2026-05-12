#!/bin/sh
# gh-bot.sh — run `gh` with an installation token and inject a
# "🧃 created on behalf of @<login>" prefix into body-bearing subcommands.
#
# Public entry point: run_gh_as_bot <token> <login> <gh args...>
# The token argument is exported as GH_TOKEN / GITHUB_TOKEN for the child;
# login can be empty (then the prefix names "an agent").

# build_prefix <login>
build_prefix() {
    if [ -n "$1" ]; then
        printf '🧃 created on behalf of @%s' "$1"
    else
        printf '🧃 created on behalf of an agent'
    fi
}

# is_body_command <a> <b>  -> exit 0 if "<a>:<b>" is a body-bearing key.
is_body_command() {
    case "$1:$2" in
        pr:create|issue:create|pr:comment|issue:comment|pr:review) return 0 ;;
        *) return 1 ;;
    esac
}

# is_create_command <a> <b>  -> exit 0 if it's a create command (we add --body
# if missing).
is_create_command() {
    case "$1:$2" in
        pr:create|issue:create) return 0 ;;
        *) return 1 ;;
    esac
}

# run_gh_as_bot <token> <login> [<gh args>...]
# Replaces the current process via exec, so the exit code propagates naturally.
run_gh_as_bot() {
    token=$1
    login=$2
    shift 2

    # If fewer than 2 positional args, no injection logic applies.
    if [ "$#" -lt 2 ]; then
        GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@"
    fi

    sub1=$1
    sub2=$2
    if ! is_body_command "$sub1" "$sub2"; then
        GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@"
    fi

    prefix=$(build_prefix "$login")

    # Walk args, find --body / -b / --body-file / -F. Rewrite in place via
    # set --, preserving order. We can't use arrays in POSIX sh; rebuild.
    body_idx=-1
    body_file_idx=-1
    i=0
    for a in "$@"; do
        i=$((i + 1))
        case "$a" in
            --body|-b)
                body_idx=$i
                ;;
            --body-file|-F)
                body_file_idx=$i
                ;;
        esac
    done

    if [ "$body_idx" -ne -1 ]; then
        body_val_idx=$((body_idx + 1))
        # Rebuild args replacing index body_val_idx.
        new_args_count=0
        i=0
        for a in "$@"; do
            i=$((i + 1))
            if [ "$i" -eq "$body_val_idx" ]; then
                new_val=$(printf '%s\n\n%s' "$prefix" "$a")
                set -- "$@" "$new_val"
            else
                set -- "$@" "$a"
            fi
            new_args_count=$((new_args_count + 1))
        done
        # Shift off the originals.
        shift "$new_args_count"
        GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@"
    fi

    if [ "$body_file_idx" -ne -1 ]; then
        body_file_val_idx=$((body_file_idx + 1))
        # Read the original file value first.
        i=0
        orig_path=
        for a in "$@"; do
            i=$((i + 1))
            if [ "$i" -eq "$body_file_val_idx" ]; then
                orig_path=$a
                break
            fi
        done
        if [ -z "$orig_path" ] || [ ! -f "$orig_path" ]; then
            # Path missing or unreadable — pass through.
            GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@"
        fi
        tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/juicebox-body-XXXXXX")
        tmp_file="${tmpdir}/body.md"
        {
            printf '%s\n\n' "$prefix"
            cat "$orig_path"
        } >"$tmp_file"

        new_args_count=0
        i=0
        for a in "$@"; do
            i=$((i + 1))
            if [ "$i" -eq "$body_file_val_idx" ]; then
                set -- "$@" "$tmp_file"
            else
                set -- "$@" "$a"
            fi
            new_args_count=$((new_args_count + 1))
        done
        shift "$new_args_count"
        GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@"
    fi

    # No --body / --body-file. For create commands, append "--body <prefix>".
    if is_create_command "$sub1" "$sub2"; then
        GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@" --body "$prefix"
    fi

    # Comment/review without body: leave it, gh will error if required.
    GH_TOKEN="$token" GITHUB_TOKEN="$token" exec gh "$@"
}
