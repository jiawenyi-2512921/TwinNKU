"""Data-only CSV/XLSX parser. No spreadsheet engine, network, or formula evaluation.

Run hostile parsing in the resource-limited subprocess below; APIs consume only
bounded string cells. A workbook may contain one visible data sheet.
"""

import asyncio
import csv
import io
import json
import os
import posixpath
import re
import signal
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_BYTES = 10 * 1024 * 1024
MAX_OUTPUT = 24 * 1024 * 1024
MAX_ROWS = 500
MAX_COLUMNS = 64
MAX_CELL = 20000
MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PACKAGE = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class TableError(ValueError):
    def __init__(self, code, message, row=None, column=None):
        super().__init__(message)
        self.code, self.row, self.column = code, row, column

    def view(self):
        return {"code": self.code, "message": str(self), "row": self.row, "column": self.column}


def cell_text(value, row, column):
    if len(value) > MAX_CELL or any(ord(c) < 32 and c not in "\n\r\t" for c in value):
        raise TableError("INVALID_CELL", "单元格过长或含不可显示字符", row, column)
    beginning = value.lstrip()
    if beginning.startswith(("=", "+", "@")) or (
        beginning.startswith("-") and not re.fullmatch(r"-\d+(?:\.\d+)?", beginning)
    ):
        raise TableError("FORMULA_FORBIDDEN", "请将公式转换为纯文本或数值后导入", row, column)
    return value


def validate_rows(rows):
    if not rows or not rows[0]:
        raise TableError("EMPTY_TABLE", "文件缺少表头和资料行")
    if len(rows) > MAX_ROWS + 1:
        raise TableError("TOO_MANY_ROWS", "每批最多导入500行资料")
    columns = [cell_text(str(v), 1, index + 1).strip() for index, v in enumerate(rows[0])]
    if len(columns) > MAX_COLUMNS or not all(columns) or len(columns) != len(set(columns)):
        raise TableError("INVALID_HEADERS", "表头不能为空、重复或超过64列")
    result = []
    for number, cells in enumerate(rows[1:], 2):
        if len(cells) > len(columns):
            raise TableError("EXTRA_CELLS", "资料行的列数超过表头", number)
        values = [cell_text(str(value), number, col + 1) for col, value in enumerate(cells)]
        values.extend([""] * (len(columns) - len(values)))
        if any(value.strip() for value in values):
            result.append({"row": number, "values": dict(zip(columns, values, strict=True))})
    if not result:
        raise TableError("EMPTY_TABLE", "请在表头后填写资料")
    return {"columns": columns, "rows": result}


def parse_csv(data):
    try:
        source = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise TableError("CSV_ENCODING", "CSV请另存为UTF-8编码，或改用XLSX") from exc
    csv.field_size_limit(MAX_CELL)
    rows = []
    try:
        for row in csv.reader(io.StringIO(source, newline=""), strict=True):
            if len(rows) >= MAX_ROWS + 1 or len(row) > MAX_COLUMNS:
                raise TableError("TABLE_TOO_LARGE", "每批最多500行资料、64列")
            rows.append(row)
    except csv.Error as exc:
        raise TableError("INVALID_CSV", "CSV格式错误或单元格过长") from exc
    return validate_rows(rows)


def xml(archive, name):
    try:
        data = archive.read(name)
        # Reject DTD/entity expansion and non-UTF8 XML before ElementTree sees it.
        decoded = data.decode("utf-8-sig")
        if "\x00" in decoded or re.search(r"<!\s*(?:DOCTYPE|ENTITY)", decoded, re.I):
            raise ValueError("unsafe XML")
        root = ET.fromstring(decoded)
        if sum(1 for _ in root.iter()) > 100000:
            raise ValueError("XML node limit")
        return root
    except (KeyError, ValueError, ET.ParseError) as exc:
        raise TableError("INVALID_XLSX", "表格XML损坏或包含不允许的结构") from exc


def parse_xlsx(data):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise TableError("INVALID_XLSX", "文件不是有效的XLSX工作簿") from exc
    with archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 2048 or len(names) != len(set(names)):
            raise TableError("INVALID_XLSX", "工作簿包含过多或重复的内部文件")
        if sum(entry.file_size for entry in entries) > 32 * 1024 * 1024:
            raise TableError("EXPANSION_LIMIT", "工作簿展开后超过32MB限制")
        for entry in entries:
            name = entry.filename.lower()
            if (name.startswith("/") or "\\" in name or ".." in name.split("/")
                    or entry.flag_bits & 1 or entry.file_size > 12 * 1024 * 1024
                    or entry.file_size > max(1024 * 1024, entry.compress_size * 200)):
                raise TableError("INVALID_XLSX", "工作簿含不安全路径、加密内容或过大压缩对象")
            if any(word in name for word in ("vbaproject", "externallink", "connections", "embeddings/", "activex", "querytables/")):
                raise TableError("ACTIVE_CONTENT", "请移除宏、外部连接及嵌入对象后导入")
            if name.endswith(".rels"):
                rels = xml(archive, entry.filename)
                if any(rel.attrib.get("TargetMode", "").lower() == "external" for rel in rels):
                    raise TableError("EXTERNAL_CONNECTION", "请将外部链接转换为普通文本单元格")
        types = xml(archive, "[Content_Types].xml")
        if any("macroenabled" in item.attrib.get("ContentType", "").lower() for item in types):
            raise TableError("ACTIVE_CONTENT", "不接受启用宏的工作簿")
        book = xml(archive, "xl/workbook.xml")
        sheets = book.findall(f"{MAIN}sheets/{MAIN}sheet")
        if len(sheets) != 1 or sheets[0].attrib.get("state", "visible") != "visible":
            raise TableError("SHEET_COUNT", "请将需要导入的数据另存为只有一张可见工作表的XLSX")
        if book.find(f"{MAIN}definedNames") is not None:
            raise TableError("ACTIVE_CONTENT", "请移除命名公式后导入")
        relation = sheets[0].attrib.get(REL + "id")
        relations = xml(archive, "xl/_rels/workbook.xml.rels")
        matching = [item for item in relations if item.tag == PACKAGE + "Relationship" and item.attrib.get("Id") == relation]
        if len(matching) != 1 or not matching[0].attrib.get("Type", "").endswith("/worksheet"):
            raise TableError("INVALID_XLSX", "找不到资料工作表")
        target = matching[0].attrib.get("Target", "")
        sheet_path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
        if not sheet_path.startswith("xl/worksheets/"):
            raise TableError("INVALID_XLSX", "工作表路径不合法")
        strings = []
        if "xl/sharedStrings.xml" in names:
            for item in xml(archive, "xl/sharedStrings.xml").findall(MAIN + "si"):
                strings.append("".join(node.text or "" for node in item.iter(MAIN + "t")))
                if len(strings) > (MAX_ROWS + 1) * MAX_COLUMNS or len(strings[-1]) > MAX_CELL:
                    raise TableError("TABLE_TOO_LARGE", "共享文字超过导入限制")
        sheet = xml(archive, sheet_path)
        if any(node.tag == MAIN + "f" for node in sheet.iter()):
            raise TableError("FORMULA_FORBIDDEN", "请将公式转换为纯文本或数值后导入")
        rows = {}
        for node in sheet.findall(f"{MAIN}sheetData/{MAIN}row/{MAIN}c"):
            match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d{0,6})", node.attrib.get("r", ""))
            if not match:
                raise TableError("INVALID_XLSX", "单元格位置无效")
            letters, number = match.groups()
            number = int(number)
            column = 0
            for letter in letters:
                column = column * 26 + ord(letter) - ord("A") + 1
            if number > MAX_ROWS + 1 or column > MAX_COLUMNS:
                raise TableError("TABLE_TOO_LARGE", "请删除500行以外的资料与64列以外的内容")
            cells = rows.setdefault(number, {})
            if column in cells:
                raise TableError("INVALID_XLSX", "单元格位置重复", number, column)
            value_node = node.find(MAIN + "v")
            value = value_node.text or "" if value_node is not None else ""
            kind = node.attrib.get("t", "n")
            if kind == "s":
                try:
                    index = int(value)
                    if index < 0:
                        raise ValueError
                    value = strings[index]
                except (ValueError, IndexError) as exc:
                    raise TableError("INVALID_XLSX", "共享文字引用无效", number, column) from exc
            elif kind == "inlineStr":
                value = "".join(item.text or "" for item in node.iter(MAIN + "t"))
            elif kind not in {"n", "str", "b"}:
                raise TableError("INVALID_CELL", "请将错误值和特殊单元格转换为普通文本", number, column)
            cells[column] = cell_text(value, number, column)
        expanded = [[row.get(col, "") for col in range(1, max(row, default=0) + 1)]
                    for row in (rows.get(number, {}) for number in range(1, max(rows, default=0) + 1))]
        return validate_rows(expanded)


def parse(data, kind):
    if not data or len(data) > MAX_BYTES:
        raise TableError("FILE_SIZE", "表格不能为空或超过10MB")
    if kind == "csv":
        return parse_csv(data)
    if kind == "xlsx":
        return parse_xlsx(data)
    raise TableError("FILE_TYPE", "仅接受CSV和XLSX文件")


async def inspect_table(path, kind, settings):
    from app.core.errors import DomainError
    from app.modules.uploads import parser_environment

    path = Path(path).resolve()
    root = settings.floor_assets_dir.resolve() / ".import-temp"
    if not path.is_relative_to(root) or not path.is_file() or kind not in {"csv", "xlsx"}:
        raise DomainError("INVALID_IMPORT", "导入文件不可用", 422)
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "app.modules.imports.parser", str(path), kind,
        str(settings.upload_parser_memory_bytes), str(settings.upload_parser_cpu_seconds),
        stdin=subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=os.name == "posix", env=parser_environment(),
    )
    try:
        async with asyncio.timeout(settings.upload_parser_timeout_seconds):
            pieces, total = [], 0
            while piece := await process.stdout.read(65536):
                total += len(piece)
                if total > MAX_OUTPUT:
                    raise ValueError("output limit")
                pieces.append(piece)
            output = b"".join(pieces)
            await process.wait()
        result = json.loads(output)
        if process.returncode != 0 or not isinstance(result, dict):
            raise ValueError("worker failed")
        if "error" in result:
            error = result["error"]
            position = f"第{error['row']}行：" if error.get("row") else ""
            raise DomainError(error["code"], position + error["message"], 422)
        return result
    except (ValueError, OSError, TimeoutError) as exc:
        raise DomainError("INVALID_IMPORT", "表格无法解析或超过解析限制", 422) from exc
    finally:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.returncode is None:
            process.kill()
        await process.wait()


def worker():
    from app.modules.uploads import _apply_worker_limits

    path, kind, memory, cpu = sys.argv[1:]
    _apply_worker_limits(memory, cpu)
    try:
        with Path(path).open("rb") as source:
            result = parse(source.read(MAX_BYTES + 1), kind)
    except TableError as exc:
        result = {"error": exc.view()}
    except Exception:
        result = {"error": {"code": "INVALID_IMPORT", "message": "表格无法解析"}}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    worker()
