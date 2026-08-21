from __future__ import annotations

import argparse
import json
from pathlib import Path

from .core import expand_jobs, load_queries, run_server


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def build_parser() -> argparse.ArgumentParser:
    root = project_root()
    parser = argparse.ArgumentParser(description="Standalone China Customs statistics crawler")
    parser.add_argument("command", choices=["plan", "fetch"])
    parser.add_argument("--config", type=Path, default=root / "config" / "customs_queries.json")
    parser.add_argument("--data-dir", type=Path, default=root / "data")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the customs page automatically")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    queries = load_queries(args.config.resolve())
    jobs = expand_jobs(queries)
    if args.command == "plan":
        print(
            json.dumps(
                {
                    "config": str(args.config.resolve()),
                    "data_dir": str(args.data_dir.resolve()),
                    "summary": {
                        "products": len({query.code for query in queries}),
                        "query_variants": len(queries),
                        "ie_types": sorted({query.ie_type for query in queries}),
                        "period_jobs": len(jobs),
                        "start_period": f"{min((job.year, job.start_month) for job in jobs)[0]}{min((job.year, job.start_month) for job in jobs)[1]:02d}",
                        "end_period": f"{max((job.year, job.end_month) for job in jobs)[0]}{max((job.year, job.end_month) for job in jobs)[1]:02d}",
                    },
                    "jobs": [job.payload() for job in jobs],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    run_server(
        args.data_dir.resolve() / "customs" / "raw", jobs, args.replace, args.host, args.port, not args.no_browser
    )


if __name__ == "__main__":
    main()
