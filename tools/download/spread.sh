#!/bin/sh
# Several connections per file, spread across a job's mirrors.
#
# Sourced by worker.sh. setup.sh carries the same logic for the runtime
# install; this copy serves the build, where the mirror list comes from
# the job line rather than from a published file.
#
# WHY. Every kiwix mirror measured shapes one connection to 2-7 MB/s
# while this machine's link does 101 MB/s to a CDN. Eight connections
# spread over three mirrors measured 39 MB/s, each carrying a third --
# so for the big archives the number of connections, not the choice of
# mirror, is what decides the wall clock.
#
# CHUNKS, NOT ONE RANGE EACH. A fixed 512 MB chunk means an interrupted
# run resumes at the last whole chunk instead of restarting a 100 GB
# range, and chunks are appended to <dest>.part in order and deleted as
# they land, so the disk never holds the archive twice. <dest>.part is
# an append-only prefix of the file, which is exactly what wget -c
# expects, so either fetcher can resume what the other left.

SPREAD_CH=${SPREAD_CH:-536870912}
SPREAD_CONN=${SPREAD_CONN:-8}

spread_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null; }

spread_pick() {  # spread_pick <n> <url> [<url> ...]
    _n=$1; shift; _c=0
    for _u in "$@"; do
        [ "$_c" -eq "$_n" ] && { echo "$_u"; return 0; }
        _c=$((_c + 1))
    done
    echo "$1"
}

# One chunk, resuming from whatever of it is already on disk. A whole
# wave is what becomes durable in .part, so without this an interrupt
# loses every chunk in flight -- the entire file, for anything small
# enough to be a single wave.
spread_get() {   # spread_get <chunkfile> <from> <to> <url>
    _cf=$1; _cfrom=$2; _cto=$3; _cu=$4
    _need=$(( _cto - _cfrom + 1 ))
    _h=$(spread_size "$_cf"); _h=${_h:-0}
    # Longer than its own range: a leftover from a run that chunked
    # differently. Not worth reasoning about.
    if [ "$_h" -gt "$_need" ]; then rm -f "$_cf"; _h=0; fi
    [ "$_h" -eq "$_need" ] && return 0
    if [ "$_h" -gt 0 ]; then
        curl -s -f -L -m 7200 --user-agent "${UA:-alpacaLIPS}" -r "$(( _cfrom + _h ))-$_cto" -o "$_cf.t" "$_cu" || return 1
        cat "$_cf.t" >> "$_cf" || return 1
        rm -f "$_cf.t"
        return 0
    fi
    curl -s -f -L -m 7200 --user-agent "${UA:-alpacaLIPS}" -r "$_cfrom-$_cto" -o "$_cf" "$_cu"
}

# fetch_spread <dest> <bytes> <url> [<url> ...]
# Leaves <dest>.part behind on failure, for a later run or wget -c.
fetch_spread() {
    _o=$1; _want=$2; shift 2
    [ "$_want" -gt 0 ] 2>/dev/null || return 1
    [ $# -gt 0 ] || return 1
    command -v curl >/dev/null 2>&1 || return 1
    _nu=$#
    # Chunk from the file, not a constant: at a fixed 512 MB a 1.6 GB
    # archive is three chunks and so runs three connections, which
    # measured a third of what eight do.
    _ch=$(( _want / SPREAD_CONN ))
    [ "$_ch" -gt "$SPREAD_CH" ] && _ch=$SPREAD_CH
    [ "$_ch" -lt 16777216 ] && _ch=16777216
    _pos=0
    if [ -f "$_o.part" ]; then
        _pos=$(spread_size "$_o.part"); _pos=${_pos:-0}
        if [ "$_pos" -ge "$_want" ] 2>/dev/null; then rm -f "$_o.part"; _pos=0; fi
    fi
    _k=0
    while [ "$_pos" -lt "$_want" ]; do
        _j=0; _cpids=""
        while [ "$_j" -lt "$SPREAD_CONN" ]; do
            _from=$(( _pos + _j * _ch ))
            [ "$_from" -ge "$_want" ] && break
            _to=$(( _from + _ch - 1 ))
            [ "$_to" -ge "$_want" ] && _to=$(( _want - 1 ))
            _u=$(spread_pick $(( _k % _nu )) "$@")
            spread_get "$_o.c.$_j" "$_from" "$_to" "$_u" &
            _cpids="$_cpids $!"
            _j=$((_j + 1)); _k=$((_k + 1))
        done
        # Only this wave's chunks: a bare wait would also wait for
        # whatever else the calling shell has in the background.
        for _cp in $_cpids; do wait "$_cp" 2>/dev/null; done
        # In order, checking each length. A short chunk is retried down
        # the mirror list before the whole fetch gives up: a hole cannot
        # be left behind, and a mirror missing this file must not cost
        # more than the ranges it was given.
        _i=0
        while [ "$_i" -lt "$_j" ]; do
            _from=$(( _pos + _i * _ch ))
            _to=$(( _from + _ch - 1 ))
            [ "$_to" -ge "$_want" ] && _to=$(( _want - 1 ))
            _exp=$(( _to - _from + 1 ))
            _got=$(spread_size "$_o.c.$_i"); _got=${_got:-0}
            if [ "$_got" -ne "$_exp" ]; then
                for _u in "$@"; do
                    spread_get "$_o.c.$_i" "$_from" "$_to" "$_u" || continue
                    _got=$(spread_size "$_o.c.$_i"); _got=${_got:-0}
                    [ "$_got" -eq "$_exp" ] && break
                done
            fi
            [ "$_got" -eq "$_exp" ] || { rm -f "$_o.c".*; return 1; }
            cat "$_o.c.$_i" >> "$_o.part" || { rm -f "$_o.c".*; return 1; }
            rm -f "$_o.c.$_i"
            _i=$((_i + 1))
        done
        _pos=$(( _pos + _j * _ch ))
        [ "$_pos" -gt "$_want" ] && _pos=$_want
    done
    return 0
}
