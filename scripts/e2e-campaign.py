#!/usr/bin/env python3
"""Slice 7 e2e campaign driver: run one (api, family) gate phase in a real
interactive pi session (via a pty) with the pi-warm-cache extension, then
close the session.

Modes:
  keepalive - seed turn, idle 120s (< interval), /warm now manual probe
              (part 1), timer-cadence window (part 2), real turn (part 3).
  control   - seed turn, idle window with warming off by config (no verify=),
              real turn (part 4): expects cacheRead = 0 after the window.

The driver sends exactly one pi command in keepalive mode (/warm now) and none
in control mode, because rapid pty command toggling proved unreliable.

Usage:
  python3 scripts/e2e-campaign.py <name> <model> <family> <interval-sec>
         <prefix-file> <window-min> <mode>
"""

import json
import os
import pty
import select
import signal
import sys
import time

REPO = "/Users/shiang/projects/ribbons-digital/pi-warm-cache"
BASE = "/tmp/pi-warm-cache-campaign"
INTERACTIVE_READY_S = 20
POLL_S = 3
PART1_IDLE_S = 120


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main() -> int:
    if len(sys.argv) != 8:
        print(__doc__)
        return 2
    name, model, family, interval_s, prefix_file, window_min, mode = sys.argv[1:8]
    if mode not in ("keepalive", "control"):
        print(f"unknown mode {mode!r}; expected keepalive|control")
        return 2
    interval_ms = int(interval_s) * 1000
    window_s = int(window_min) * 60
    if mode == "keepalive" and PART1_IDLE_S >= int(interval_s):
        print("keepalive requires interval-sec > 120 (part 1 idle must be shorter than the cadence)")
        return 2

    session_dir = os.path.join(BASE, name)
    os.makedirs(session_dir, exist_ok=True)
    # Fresh evidence per run: a rerun with the same name must never read stale
    # JSONL events from a previous invocation.
    stale_pi = os.path.join(session_dir, ".pi")
    if os.path.isdir(stale_pi):
        import shutil

        shutil.rmtree(stale_pi)
    jsonl_path = os.path.join(session_dir, ".pi", "warm-cache.jsonl")
    os.makedirs(os.path.dirname(jsonl_path), exist_ok=True)
    transcript_path = os.path.join(session_dir, "session.out")
    transcript = open(transcript_path, "w")

    # The control phase must never arm a timer: omit verify= entirely.
    # Keepalive phase overrides the 30m idle cutoff (maxidle=0): the campaign
    # measures probe-sustained caching across windows beyond the cutoff.
    warm_flag = (
        f"verify={family} interval={interval_ms}ms maxidle=0 log"
        if mode == "keepalive"
        else "log"
    )
    args = [
        "pi",
        "-ne",
        "-e",
        os.path.join(REPO, "src", "index.ts"),
        f"--warm-cache={warm_flag}",
        "--append-system-prompt",
        prefix_file,
        "--provider",
        "opencode-go",
        "--model",
        model,
        "--thinking",
        "off",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
    ]
    env = dict(os.environ, TERM="xterm-256color")

    log(f"spawning pi session {name}: model={model} family={family} mode={mode}")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(session_dir)
        os.execvpe("pi", args, env)

    def drain(timeout: float = 1.0) -> str:
        out = b""
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
                try:
                    transcript.write(chunk.decode(errors="replace"))
                    transcript.flush()
                except Exception:
                    pass
        return out.decode(errors="replace")

    def send(text: str) -> None:
        # pi's raw-mode TUI submits on carriage return, not line feed.
        os.write(fd, (text if text.endswith("\r") else text + "\r").encode())

    def read_jsonl() -> list:
        if not os.path.exists(jsonl_path):
            return []
        try:
            with open(jsonl_path) as fh:
                return [json.loads(line) for line in fh if line.strip()]
        except Exception:
            return []

    def events() -> list:
        return read_jsonl()

    def wait_for(pred, timeout_s: float, what: str):
        start = time.time()
        while time.time() - start < timeout_s:
            drain(0.5)
            if pred(events()):
                return True
            time.sleep(POLL_S)
        log(f"TIMEOUT waiting for {what}")
        return False

    def agent_settled_count(evs) -> int:
        return sum(1 for e in evs if e.get("event") == "agent_settled")

    def idle_drain(seconds: float, what: str) -> None:
        log(f"idle: {what} ({seconds:.0f}s)")
        end = time.time() + seconds
        while time.time() < end:
            drain(1.0)
            time.sleep(1)
        drain(1.0)

    def seed_turn():
        send("Reply with exactly: OK")
        log("seed turn sent; waiting for capture + settle")
        if not wait_for(
            lambda evs: any(e.get("event") == "capture" for e in evs)
            and agent_settled_count(evs) >= 1,
            240,
            "seed capture/settle",
        ):
            log("seed turn did not settle")
        evs = events()
        captures = [e for e in evs if e.get("event") == "capture"]
        log(f"capture events: {len(captures)}; family={captures[-1].get('family') if captures else '?'}")
        return captures[-1] if captures else None

    def real_turn(label: str, wait_min: int = 240):
        # Record the event boundary before sending so a failed turn can never
        # report a previous turn's usage (for example the seed turn).
        before = agent_settled_count(events())
        usage_before = sum(
            1 for e in events() if e.get("event") == "usage" and e.get("source") == "real_turn"
        )
        send(label)
        settled = wait_for(
            lambda evs: agent_settled_count(evs) > before, wait_min, f"{label} settle"
        )
        if not settled:
            log(f"real turn {label} did not settle; no evidence recorded for it")
            return None
        usages = [
            e
            for e in events()
            if e.get("event") == "usage"
            and e.get("source") == "real_turn"
        ]
        if len(usages) <= usage_before:
            log(f"real turn {label} settled without a new usage event")
            return None
        return usages[-1]

    evidence = {
        "name": name,
        "model": model,
        "family": family,
        "mode": mode,
        "pi_ai_version": "0.83.0",
        "provider": "opencode-go",
    }

    try:
        log("waiting for interactive prompt")
        time.sleep(INTERACTIVE_READY_S)
        drain(2.0)

        capture = seed_turn()
        if capture:
            evidence["capture_family"] = capture.get("family")

        if mode == "keepalive":
            # Part 1: manual probe after 120s idle, before the first timer probe
            # (interval must exceed 120s). No probe touches the cache in between.
            log(f"part 1: idling {PART1_IDLE_S}s before manual probe")
            idle_drain(PART1_IDLE_S, "part 1 idle")
            send("/warm now")
            log("manual probe sent")
            manual_attempts: list = []
            if not wait_for(
                lambda evs: any(
                    e.get("event") == "attempt"
                    and e.get("source") == "warm_probe"
                    and e.get("reason") == "manual"
                    and e.get("probeOutcome") is not None
                    for e in evs
                ),
                120,
                "manual probe attempt",
            ):
                log("manual probe attempt not recorded")
            else:
                manual_attempts = [
                    e
                    for e in events()
                    if e.get("event") == "attempt"
                    and e.get("reason") == "manual"
                    and e.get("probeOutcome") is not None
                ]
                a = manual_attempts[-1]
                log(f"manual probe: ok={a.get('ok')} detail={a.get('detail')}")
            evidence["part1_manual"] = manual_attempts[-1].get("detail") if manual_attempts else None

            # Part 2: sustained keepalive across a TTL-exceeding idle window.
            log(f"part 2: watching timer probes for {window_min} minutes")
            idle_drain(window_s, "part 2 window")
            timer_probes = [
                e
                for e in events()
                if e.get("event") == "attempt"
                and e.get("source") == "warm_probe"
                and e.get("reason") == "timer"
                and e.get("probeOutcome") is not None
            ]
            hits = [e for e in timer_probes if e.get("ok")]
            log(f"part 2: timer probes={len(timer_probes)} hits={len(hits)}")
            evidence["part2_timer_probes"] = len(timer_probes)
            evidence["part2_hits"] = len(hits)

            # Part 3: user-value real turn.
            log("part 3: sending real turn")
            usage3 = real_turn("Reply with exactly: OK2")
            if usage3:
                log(f"part 3: real-turn cacheRead={usage3.get('cacheRead')} cacheWrite={usage3.get('cacheWrite')} input={usage3.get('input')}")
                evidence["part3_cache_read"] = usage3.get("cacheRead")
                evidence["part3_cache_write"] = usage3.get("cacheWrite")
            else:
                evidence["part3_turn_failed"] = True
                log("part 3: no evidence recorded (real turn failed)")
        else:
            # Part 4: causality control. Warming off by config (no verify=).
            # Same idle window as the keepalive part 2, then a real turn.
            log(f"control: idling {window_min} minutes with warming off")
            idle_drain(window_s, "control window")
            log("control: sending real turn")
            usage4 = real_turn("Reply with exactly: OKC")
            if usage4:
                log(f"control: real-turn cacheRead={usage4.get('cacheRead')} cacheWrite={usage4.get('cacheWrite')} input={usage4.get('input')}")
                evidence["control_cache_read"] = usage4.get("cacheRead")
                evidence["control_cache_write"] = usage4.get("cacheWrite")
            else:
                evidence["control_turn_failed"] = True
                log("control: no evidence recorded (real turn failed)")

        with open(os.path.join(session_dir, "evidence.json"), "w") as fh:
            json.dump(evidence, fh, indent=2)
        log(f"evidence written: {os.path.join(session_dir, 'evidence.json')}")
    finally:
        log("closing session")
        try:
            send("/exit")
            time.sleep(3)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
