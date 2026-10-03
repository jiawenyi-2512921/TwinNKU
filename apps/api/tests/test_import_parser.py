import io
import zipfile

import pytest

from app.modules.imports.parser import MAIN, PACKAGE, REL, TableError, inspect_table, parse


def workbook(sheet=None, extra=None, book_extra="", relation_extra=""):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{MAIN[1:-1]}" xmlns:r="{REL[1:-1]}"><sheets><sheet name="资料" sheetId="1" r:id="r1"/></sheets>{book_extra}</workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="{PACKAGE[1:-1]}"><Relationship Id="r1" Type="{REL[1:-1]}/worksheet" Target="worksheets/sheet1.xml"/>{relation_extra}</Relationships>')
        archive.writestr("xl/worksheets/sheet1.xml", sheet or f'<worksheet xmlns="{MAIN[1:-1]}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>测试地点</t></is></c></row></sheetData></worksheet>')
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return output.getvalue()


def test_csv_and_xlsx_have_same_string_cells():
    expected = {"columns": ["名称"], "rows": [{"row": 2, "values": {"名称": "测试地点"}}]}
    assert parse("\ufeff名称\r\n测试地点\r\n".encode(), "csv") == expected
    assert parse(workbook(), "xlsx") == expected
    result = parse('名称,说明\n测试,"含逗号,与\n换行"\n'.encode(), "csv")
    assert result["rows"][0]["values"]["说明"] == "含逗号,与\n换行"


@pytest.mark.parametrize("value", ["=HYPERLINK(1)", "+CMD", "@SUM(1)", "-CMD", "\t=1"])
def test_csv_never_accepts_formula_cells(value):
    with pytest.raises(TableError, match="公式"):
        parse(("名称\n" + value).encode(), "csv")


@pytest.mark.parametrize("data", ["名称,名称\nx,y", ",名称\nx,y", "名称\nx,y", "名称\n" + "x\n" * 501])
def test_csv_rejects_bad_shape(data):
    with pytest.raises(TableError):
        parse(data.encode(), "csv")


@pytest.mark.parametrize("extra", [
    {"../escape": "x"}, {"xl/vbaProject.bin": "x"},
    {"xl/externalLinks/externalLink1.xml": "<x/>"},
    {"xl/connections.xml": "<x/>"}, {"xl/embeddings/x.bin": "x"},
    {"oversized": "x" * (2 * 1024 * 1024)},
])
def test_xlsx_rejects_active_content_paths_and_compression_bombs(extra):
    with pytest.raises(TableError):
        parse(workbook(extra=extra), "xlsx")


def test_xlsx_rejects_formulas_entities_and_external_relationships():
    with pytest.raises(TableError, match="公式"):
        parse(workbook(sheet=f'<worksheet xmlns="{MAIN[1:-1]}"><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'), "xlsx")
    with pytest.raises(TableError):
        parse(workbook(sheet='<!DOCTYPE x [<!ENTITY x "hello">]><x>&x;</x>'), "xlsx")
    with pytest.raises(TableError):
        parse(workbook(relation_extra='<Relationship Id="r2" TargetMode="External" Target="https://example.invalid"/>'), "xlsx")
    with pytest.raises(TableError):
        parse(workbook(book_extra="<definedNames/>"), "xlsx")


def test_xlsx_sparse_cell_cannot_allocate_unbounded_rows():
    sheet = f'<worksheet xmlns="{MAIN[1:-1]}"><sheetData><row r="999999"><c r="A999999"><v>1</v></c></row></sheetData></worksheet>'
    with pytest.raises(TableError):
        parse(workbook(sheet=sheet), "xlsx")


def test_file_limits_and_encoding():
    for value, kind in [(b"", "csv"), (b"x" * (10 * 1024 * 1024 + 1), "csv"), (b"\xff", "csv"), (b"x", "xlsm"), (b"x", "xlsx")]:
        with pytest.raises(TableError):
            parse(value, kind)


@pytest.mark.anyio
async def test_real_parser_subprocess_preserves_bounded_large_output(client):
    root = client.app.state.settings.floor_assets_dir / ".import-temp"
    root.mkdir(parents=True, exist_ok=True)
    path = root / "fixture.csv"
    path.write_text("名称,说明\n" + "测试," + "资料" * 16000 + "\n", encoding="utf-8")
    from app.core.errors import DomainError
    with pytest.raises(DomainError):
        await inspect_table(path, "csv", client.app.state.settings)
    path.write_text("名称,说明\n" + ("测试," + "资料" * 5000 + "\n") * 20, encoding="utf-8")
    result = await inspect_table(path, "csv", client.app.state.settings)
    assert len(result["rows"]) == 20
    assert result["rows"][19]["values"]["说明"] == "资料" * 5000
