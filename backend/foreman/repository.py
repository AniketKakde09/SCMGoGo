from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd


class Repository:
    def __init__(self) -> None:
        self.data: dict[str, pd.DataFrame] = {}

    def load_excel(self, file_path: str | Path) -> None:
        path = Path(file_path)

        if not path.exists():
            raise FileNotFoundError(f"Dataset not found: {path}")

        workbook = pd.ExcelFile(path)

        for sheet_name in workbook.sheet_names:
            self.data[sheet_name] = pd.read_excel(
                workbook,
                sheet_name=sheet_name,
            )

    def has_data(self) -> bool:
        return bool(self.data)

    def get_sheet(self, name: str) -> pd.DataFrame:
        if name not in self.data:
            raise KeyError(f"Sheet '{name}' not loaded")
        return self.data[name]

    def sheet_names(self) -> list[str]:
        return list(self.data.keys())

    def records(self, name: str) -> list[dict[str, Any]]:
        df = self.get_sheet(name)

        result = df.where(pd.notna(df), None)
        return result.to_dict(orient="records")

    def summary(self) -> dict[str, int]:
        return {
            sheet: len(df)
            for sheet, df in self.data.items()
        }