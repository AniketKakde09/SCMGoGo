from __future__ import annotations

from pathlib import Path
from typing import Any, BinaryIO

import pandas as pd

REQUIRED_SHEETS = [
    "Backlog",
    "Dependencies",
    "Sprints",
    "TeamMembers",
    "Holidays",
]


class Repository:
    def __init__(self) -> None:
        self.data: dict[str, pd.DataFrame] = {}
        self.source_name: str | None = None

    def _load_from_workbook(self, workbook: pd.ExcelFile) -> dict[str, pd.DataFrame]:
        missing = [s for s in REQUIRED_SHEETS if s not in workbook.sheet_names]
        if missing:
            raise ValueError(
                "This workbook is missing required sheet(s): "
                f"{', '.join(missing)}. Expected sheets: {', '.join(REQUIRED_SHEETS)}."
            )

        return {
            sheet_name: pd.read_excel(workbook, sheet_name=sheet_name)
            for sheet_name in workbook.sheet_names
        }

    def load_excel(self, file_path: str | Path) -> None:
        path = Path(file_path)

        if not path.exists():
            raise FileNotFoundError(f"Dataset not found: {path}")

        workbook = pd.ExcelFile(path)
        self.data = self._load_from_workbook(workbook)
        self.source_name = path.name

    def load_excel_stream(self, file_obj: BinaryIO, filename: str | None = None) -> None:
        """Load a dataset from an in-memory file (e.g. an uploaded .xlsx).

        Kept separate from load_excel so a bad upload can raise a clear,
        user-facing error without touching the currently loaded dataset
        until the new one has been fully parsed and validated.
        """
        try:
            workbook = pd.ExcelFile(file_obj)
        except Exception as exc:  # e.g. not a valid xlsx
            raise ValueError(
                "That file couldn't be read as an Excel workbook (.xlsx). "
                "Please check the format and try again."
            ) from exc

        parsed = self._load_from_workbook(workbook)
        self.data = parsed
        self.source_name = filename or "Uploaded dataset"

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