#!/usr/bin/env python3

from __future__ import annotations

import math
import re
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path("/work/crowd-canvas-main")
LOGS = ROOT / "logs"
REPORTS = ROOT / "reports"
GRAPH_DIR = REPORTS / "graphs"


def parse_latency_ms(line: str):
    m = re.search(r"avg=(\d+)ms\s+p95=(\d+)ms\s+p99=(\d+)ms", line)
    if not m:
      return None
    return tuple(int(x) for x in m.groups())


def parse_pass_log(path: Path):
    stage_rows = []
    timeline_rows = []
    scenario = None
    stage = None
    current = {}

    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("=== Scenario:"):
            scenario = line.split(":", 1)[1].strip(" =")
            stage = None
            current = {}
            continue

        if line.startswith("=== ") and line.endswith(" ===") and not line.startswith("=== Scenario:"):
            stage = line.strip("= ").strip()
            current = {}
            continue

        if line.startswith("t=") and scenario and stage:
            m = re.search(
                r"t=(\d+)s\s+live=(\d+)/(\d+)\s+sub/s=([0-9.]+)\s+ok=(\d+)\s+inflight=(\d+)\s+done=(\d+)\s+wait=(\d+)\s+err=(\d+)\s+lat avg=(\d+)ms p95=(\d+)ms p99=(\d+)ms",
                line,
            )
            if m:
                timeline_rows.append(
                    {
                        "pass": path.stem.split("-")[0],
                        "scenario": scenario,
                        "stage": stage,
                        "t_sec": int(m.group(1)),
                        "live": int(m.group(2)),
                        "target": int(m.group(3)),
                        "sub_per_s": float(m.group(4)),
                        "ok": int(m.group(5)),
                        "inflight": int(m.group(6)),
                        "done": int(m.group(7)),
                        "wait": int(m.group(8)),
                        "err": int(m.group(9)),
                        "avg_ms": int(m.group(10)),
                        "p95_ms": int(m.group(11)),
                        "p99_ms": int(m.group(12)),
                    }
                )
            continue

        if line.startswith("connections  opened="):
            m = re.search(r"opened=(\d+)\s+peak-live≈(\d+)\s+closed=(\d+)\s+errors=(\d+)", line)
            if m:
                current.update(
                    {
                        "opened": int(m.group(1)),
                        "peak_live": int(m.group(2)),
                        "closed": int(m.group(3)),
                        "errors": int(m.group(4)),
                    }
                )
            continue

        if line.startswith("submissions  sent="):
            m = re.search(r"sent=(\d+)\s+accepted=(\d+)\s+rejected=(\d+)\s+inflight=(\d+)", line)
            if m:
                current.update(
                    {
                        "sent": int(m.group(1)),
                        "accepted": int(m.group(2)),
                        "rejected": int(m.group(3)),
                        "inflight_final": int(m.group(4)),
                    }
                )
            continue

        if line.startswith("latency      avg="):
            vals = parse_latency_ms(line)
            if vals and scenario and stage:
                current.update({"avg_ms": vals[0], "p95_ms": vals[1], "p99_ms": vals[2]})
                row = {"pass": path.stem.split("-")[0], "scenario": scenario, "stage": stage}
                row.update(current)
                stage_rows.append(row)
                current = {}

    return pd.DataFrame(stage_rows), pd.DataFrame(timeline_rows)


def to_gib(value: str, unit: str) -> float:
    v = float(value)
    unit = unit.lower()
    if unit == "gi":
        return v
    if unit == "mi":
        return v / 1024.0
    if unit == "ki":
        return v / (1024.0 * 1024.0)
    return v


def parse_monitor_log(path: Path):
    rows = []
    current = {}
    section = None

    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if line.startswith("===== ") and line.endswith(" ====="):
            if current:
                rows.append(current)
            current = {"timestamp": line.strip("= ").strip()}
            section = None
            continue

        if line.startswith("-- ") and line.endswith(" --"):
            section = line.strip("- ").strip()
            continue

        if section == "uptime":
            m = re.search(r"load average:\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)", line)
            if m:
                current["load_1"] = float(m.group(1))
                current["load_5"] = float(m.group(2))
                current["load_15"] = float(m.group(3))
            continue

        if section == "memory" and line.strip().startswith("Mem:"):
            parts = re.findall(r"([0-9.]+)(Gi|Mi|Ki)", line)
            if len(parts) >= 6:
                current["mem_total_gib"] = to_gib(*parts[0])
                current["mem_used_gib"] = to_gib(*parts[1])
                current["mem_free_gib"] = to_gib(*parts[2])
                current["mem_buff_cache_gib"] = to_gib(*parts[4])
                current["mem_available_gib"] = to_gib(*parts[5])
            continue

        if section and section.startswith("socket_count_port_") and line.strip().isdigit():
            current["socket_count"] = int(line.strip())
            continue

        if section == "node_processes" and "node server.js" in line:
            m = re.match(r"\s*(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)", line)
            if m:
                current["server_cpu_pct"] = float(m.group(3))
                current["server_mem_pct"] = float(m.group(4))
                current["server_rss_kib"] = int(m.group(5))
            continue

    if current:
        rows.append(current)
    return pd.DataFrame(rows)


def style():
    plt.style.use("seaborn-v0_8-whitegrid")
    plt.rcParams.update(
        {
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.titlesize": 16,
            "axes.labelsize": 12,
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
            "legend.fontsize": 10,
        }
    )


def save_fig(fig, name: str):
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    out = GRAPH_DIR / name
    fig.tight_layout()
    fig.savefig(out, dpi=180, bbox_inches="tight")
    plt.close(fig)
    return out


def chart_pass_comparison(stage_df: pd.DataFrame):
    # Compare accepted submissions at the highest stable tested stage per scenario/pass.
    target = stage_df[stage_df["stage"].isin(["real-20000", "real-30000"])]
    target = target.copy()
    target["label"] = target["pass"] + ":" + target["scenario"] + ":" + target["stage"]
    target = target.sort_values(["pass", "scenario", "stage"])

    fig, ax = plt.subplots(figsize=(14, 7))
    colors = ["#2563eb" if s == "real-20000" else "#dc2626" for s in target["stage"]]
    bars = ax.bar(target["label"], target["accepted"], color=colors)
    ax.set_title("Accepted Submissions at High-Concurrency Stages")
    ax.set_ylabel("Accepted submissions")
    ax.set_xlabel("Pass / Scenario / Stage")
    ax.tick_params(axis="x", labelrotation=45)
    for label in ax.get_xticklabels():
        label.set_horizontalalignment("right")

    for bar, err in zip(bars, target["errors"]):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 40,
            f"err={err}",
            ha="center",
            va="bottom",
            fontsize=9,
            color="#374151",
        )

    return save_fig(fig, "capacity-pass-comparison.png")


def chart_pass3_30k(timeline_df: pd.DataFrame):
    df = timeline_df[(timeline_df["pass"] == "pass3") & (timeline_df["scenario"] == "p5k-r5") & (timeline_df["stage"] == "real-30000")].copy()
    if df.empty:
        return None

    fig, axes = plt.subplots(3, 1, figsize=(13, 10), sharex=True)

    axes[0].plot(df["t_sec"], df["live"], label="Live connections", color="#2563eb", linewidth=2)
    axes[0].plot(df["t_sec"], df["target"], label="Target", color="#9ca3af", linestyle="--")
    axes[0].set_ylabel("Connections")
    axes[0].set_title("Pass 3: real-30000 Stage Behavior")
    axes[0].legend(loc="lower right")

    axes[1].plot(df["t_sec"], df["err"], label="Errors", color="#dc2626", linewidth=2)
    axes[1].plot(df["t_sec"], df["ok"], label="Accepted", color="#16a34a", linewidth=2)
    axes[1].set_ylabel("Count")
    axes[1].legend(loc="upper left")

    axes[2].plot(df["t_sec"], df["p95_ms"], label="P95 latency", color="#7c3aed", linewidth=2)
    axes[2].plot(df["t_sec"], df["p99_ms"], label="P99 latency", color="#f59e0b", linewidth=2)
    axes[2].set_ylabel("Latency (ms)")
    axes[2].set_xlabel("Time in stage (s)")
    axes[2].legend(loc="upper left")

    return save_fig(fig, "capacity-pass3-30k-timeline.png")


def chart_monitor(monitor_df: pd.DataFrame):
    df = monitor_df.copy()
    if df.empty:
        return None

    df["timestamp"] = pd.to_datetime(df["timestamp"])

    fig, axes = plt.subplots(3, 1, figsize=(13, 10), sharex=True)

    axes[0].plot(df["timestamp"], df["server_cpu_pct"], color="#2563eb", linewidth=2, label="server.js CPU %")
    if "load_1" in df:
        axes[0].plot(df["timestamp"], df["load_1"], color="#059669", linewidth=1.8, label="Load avg (1m)")
    axes[0].set_ylabel("CPU / Load")
    axes[0].set_title("Host Monitor Overview During Load Testing")
    axes[0].legend(loc="upper left")

    axes[1].plot(df["timestamp"], df["socket_count"], color="#dc2626", linewidth=2, label="Socket count")
    axes[1].set_ylabel("Sockets")
    axes[1].legend(loc="upper left")

    axes[2].plot(df["timestamp"], df["mem_used_gib"], color="#7c3aed", linewidth=2, label="Used memory (GiB)")
    axes[2].plot(df["timestamp"], df["mem_available_gib"], color="#f59e0b", linewidth=2, label="Available memory (GiB)")
    axes[2].set_ylabel("Memory (GiB)")
    axes[2].legend(loc="upper left")
    axes[2].set_xlabel("Time")

    return save_fig(fig, "capacity-monitor-overview.png")


def main():
    style()

    stage_dfs = []
    timeline_dfs = []
    for path in sorted(LOGS.glob("pass*-session-geometry.log")):
        stage_df, timeline_df = parse_pass_log(path)
        stage_dfs.append(stage_df)
        timeline_dfs.append(timeline_df)

    stage_df = pd.concat(stage_dfs, ignore_index=True) if stage_dfs else pd.DataFrame()
    timeline_df = pd.concat(timeline_dfs, ignore_index=True) if timeline_dfs else pd.DataFrame()
    monitor_df = parse_monitor_log(LOGS / "system-monitor.log")

    outputs = []
    outputs.append(chart_pass_comparison(stage_df))
    out = chart_pass3_30k(timeline_df)
    if out:
        outputs.append(out)
    out = chart_monitor(monitor_df)
    if out:
        outputs.append(out)

    print("Generated:")
    for p in outputs:
        print(p)


if __name__ == "__main__":
    main()
