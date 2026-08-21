import json
from pathlib import Path

import pytest

from customs_crawl.core import CustomsQuery, expand_jobs, load_queries, validate_csv


def test_config_expands_import_and_export(tmp_path: Path) -> None:
    config = tmp_path / "customs_queries.json"
    config.write_text(
        json.dumps(
            {
                "defaults": {
                    "start_year": 2015,
                    "end_year": 2015,
                    "start_month": 1,
                    "end_month": 3,
                    "months_per_job": 3,
                    "currency": "rmb",
                    "ie_types": ["export", "import"],
                    "groups": ["commodity", "partner", "trade_mode", "province"],
                },
                "products": [{"code": "85044030", "enabled": True}],
            }
        ),
        encoding="utf-8",
    )

    queries = load_queries(config)
    jobs = expand_jobs(queries)

    assert [query.ie_type for query in queries] == ["export", "import"]
    assert len(jobs) == 2
    assert jobs[0].output_relative.endswith("2015_01-03_export_rmb_commodity_partner_trade_mode_province.csv")
    assert jobs[1].output_relative.endswith("2015_01-03_import_rmb_commodity_partner_trade_mode_province.csv")


def test_validate_csv_allows_missing_months() -> None:
    query = CustomsQuery("38180019", "", 2026, 2026, 1, 3, 3, "rmb", "export", ("commodity",))
    job = expand_jobs([query])[0]
    payload = '"数据年月","商品编码"\r\n"202601","38180019"\r\n"202603","38180019"\r\n'.encode("gb18030")

    assert validate_csv(payload, job) == (2, ["202601", "202603"], ["202602"])


def test_validate_csv_rejects_other_period() -> None:
    query = CustomsQuery("38180019", "", 2026, 2026, 1, 3, 3, "rmb", "export", ("commodity",))
    job = expand_jobs([query])[0]
    payload = '"数据年月","商品编码"\r\n"202512","38180019"\r\n'.encode("gb18030")

    with pytest.raises(ValueError, match="outside the query range"):
        validate_csv(payload, job)
