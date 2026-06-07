#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path("/work/crowd-canvas-main")
REPORTS = ROOT / "reports"


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


def find_report_dir(arg: str | None) -> Path:
    if arg:
        path = Path(arg)
        return path if path.is_absolute() else ROOT / path
    candidates = sorted(REPORTS.glob("breakpoint-*"))
    if not candidates:
        raise SystemExit("No breakpoint report directories found under reports/.")
    return candidates[-1]


def load_data(report_dir: Path):
    summary = json.loads((report_dir / "breakpoint-summary.json").read_text())
    steps = json.loads((report_dir / "breakpoint-steps.json").read_text())
    metrics = pd.read_csv(report_dir / "breakpoint-metrics.csv")
    return summary, steps, metrics


def annotate_markers(ax, summary: dict):
    bp = summary["breakpoint"]
    marker_specs = [
        ("last good", bp.get("lastGoodUsers", 0), "#16a34a"),
        ("first bad", bp.get("firstBadUsers", 0), "#dc2626"),
        ("safe", bp.get("recommendedSafeUsers", 0), "#2563eb"),
    ]
    ymax = ax.get_ylim()[1]
    for label, value, color in marker_specs:
        if not value:
            continue
        ax.axvline(value, color=color, linestyle="--", linewidth=1.5, alpha=0.9)
        ax.text(value, ymax * 0.98, label, rotation=90, va="top", ha="right", color=color)


def save_fig(fig, path: Path):
    fig.tight_layout()
    fig.savefig(path, dpi=180, bbox_inches="tight")
    plt.close(fig)
    return path


def chart_latency(report_dir: Path, summary: dict, metrics: pd.DataFrame):
    fig, ax = plt.subplots(figsize=(12, 6.5))
    colors = metrics["result"].map({"pass": "#16a34a", "degraded": "#d97706", "fail": "#dc2626"}).fillna("#64748b")

    ax.plot(metrics["users"], metrics["assign_p95_ms"], marker="o", linewidth=2, color="#2563eb", label="Assign p95")
    ax.plot(metrics["users"], metrics["submit_p95_ms"], marker="o", linewidth=2, color="#9333ea", label="Submit p95")
    ax.plot(metrics["users"], metrics["submit_p99_ms"], marker="o", linewidth=2, color="#dc2626", label="Submit p99")
    ax.scatter(metrics["users"], metrics["submit_p95_ms"], s=70, color=colors, zorder=3)

    ax.axhline(3000, color="#dc2626", linestyle=":", linewidth=1.5, label="Default unhealthy latency threshold")
    ax.set_title("Breakpoint Latency Curve")
    ax.set_xlabel("Simulated users")
    ax.set_ylabel("Latency (ms)")
    annotate_markers(ax, summary)
    ax.legend(loc="upper left")

    return save_fig(fig, report_dir / "breakpoint-latency.png")


def chart_health(report_dir: Path, summary: dict, metrics: pd.DataFrame):
    fig, ax = plt.subplots(figsize=(12, 6.5))
    ax.plot(metrics["users"], metrics["conn_success_rate"] * 100, marker="o", linewidth=2, color="#2563eb", label="Connection success %")
    ax.plot(metrics["users"], metrics["submit_success_rate"] * 100, marker="o", linewidth=2, color="#16a34a", label="Submission success %")
    ax.plot(metrics["users"], metrics["disconnect_rate"] * 100, marker="o", linewidth=2, color="#d97706", label="Disconnect %")
    ax.plot(metrics["users"], metrics["error_rate"] * 100, marker="o", linewidth=2, color="#dc2626", label="Error %")

    ax.axhline(98, color="#2563eb", linestyle=":", linewidth=1.3, alpha=0.8)
    ax.axhline(95, color="#16a34a", linestyle=":", linewidth=1.3, alpha=0.8)
    ax.axhline(2, color="#d97706", linestyle=":", linewidth=1.3, alpha=0.8)
    ax.axhline(1, color="#dc2626", linestyle=":", linewidth=1.3, alpha=0.8)

    ax.set_title("Breakpoint Success and Error Rates")
    ax.set_xlabel("Simulated users")
    ax.set_ylabel("Percent")
    ax.set_ylim(0, 105)
    annotate_markers(ax, summary)
    ax.legend(loc="center right")

    return save_fig(fig, report_dir / "breakpoint-health.png")


def chart_host(report_dir: Path, summary: dict, metrics: pd.DataFrame):
    fig, ax1 = plt.subplots(figsize=(12, 6.5))
    ax2 = ax1.twinx()

    ax1.plot(metrics["users"], metrics["cpu_peak_pct"], marker="o", linewidth=2, color="#dc2626", label="CPU peak %")
    ax1.plot(metrics["users"], metrics["mem_peak_pct"], marker="o", linewidth=2, color="#16a34a", label="Memory peak %")
    ax1.axhline(90, color="#dc2626", linestyle=":", linewidth=1.3, alpha=0.8)
    ax1.axhline(85, color="#16a34a", linestyle=":", linewidth=1.3, alpha=0.8)
    ax1.set_ylabel("Host percent")
    ax1.set_xlabel("Simulated users")
    ax1.set_ylim(0, max(105, metrics["cpu_peak_pct"].max() + 5))

    ax2.plot(metrics["users"], metrics["node_rss_peak_mb"], marker="o", linewidth=2, color="#2563eb", label="Node RSS peak MB")
    ax2.plot(metrics["users"], metrics["event_loop_p95_ms"], marker="o", linewidth=2, color="#9333ea", label="Event loop p95 ms")
    ax2.set_ylabel("RSS (MB) / event loop p95 (ms)")

    ax1.set_title("Breakpoint Host Pressure")
    annotate_markers(ax1, summary)

    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, loc="upper left")

    return save_fig(fig, report_dir / "breakpoint-host.png")


def write_index(report_dir: Path, summary: dict, outputs: list[Path]):
    bp = summary["breakpoint"]
    lines = [
        "# Breakpoint Graphs",
        "",
        f"- Last good users: `{bp.get('lastGoodUsers', 0)}`",
        f"- First bad users: `{bp.get('firstBadUsers', 0)}`",
        f"- Recommended safe users: `{bp.get('recommendedSafeUsers', 0)}`",
        f"- Bottleneck: `{bp.get('bottleneck', '-')}`",
        f"- Reason: {bp.get('reason', '-')}",
        "",
        "## Files",
        "",
    ]
    lines.extend(f"- `{path.name}`" for path in outputs)
    out = report_dir / "breakpoint-graphs.md"
    out.write_text("\n".join(lines) + "\n")
    return out


def main():
    style()
    report_dir = find_report_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    summary, _steps, metrics = load_data(report_dir)

    outputs = [
      chart_latency(report_dir, summary, metrics),
      chart_health(report_dir, summary, metrics),
      chart_host(report_dir, summary, metrics),
    ]
    index_path = write_index(report_dir, summary, outputs)

    print(f"Report dir: {report_dir}")
    for path in outputs:
        print(path)
    print(index_path)


if __name__ == "__main__":
    main()
