import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import linux_auto_invest_report as report


class FundingPositionTests(unittest.TestCase):
    @patch("linux_auto_invest_report.signed_post")
    def test_values_spcxb_funding_balance(self, signed_post):
        signed_post.return_value = [
            {
                "asset": "SPCXB",
                "free": "12.51778149",
                "locked": "0",
                "freeze": "0",
                "withdrawing": "0",
            }
        ]

        rows, total = report.fetch_funding_positions(
            "https://api.binance.com",
            "api-key",
            "api-secret",
            {"SPCXBUSDT": 115.60},
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["Category"], "资金账户")
        self.assertEqual(rows[0]["Asset"], "SPCXB")
        self.assertAlmostEqual(rows[0]["Quantity"], 12.51778149)
        self.assertAlmostEqual(rows[0]["ValueUsdt"], 12.51778149 * 115.60)
        self.assertAlmostEqual(total, 12.51778149 * 115.60)

    def test_funding_total_is_included_in_report_and_html(self):
        sample = {
            "startDate": "2026-01-01",
            "endDate": "2026-07-29",
            "results": [],
        }
        positions = [
            {
                "Category": "资金账户",
                "Asset": "SPCXB",
                "Quantity": 12.5,
                "ValueUsdt": 1445.0,
            }
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.md"
            with patch.object(report, "REPORT_PATH", report_path):
                body = report.build_report(
                    sample,
                    positions,
                    10.0,
                    1445.0,
                    20.0,
                    5.0,
                    {},
                    7.2,
                    "test",
                )

        html = report.report_to_html(report.LAST_REPORT_CONTEXT)
        self.assertEqual(report.LAST_REPORT_CONTEXT["total_holding"], 1480.0)
        self.assertIn("| 资金账户 | 1,445.00 |", body)
        self.assertIn("账户总仓位价值 = 现货 + 资金账户", body)
        self.assertIn("SPCXB", html)
        self.assertIn("资金账户", html)


if __name__ == "__main__":
    unittest.main()
