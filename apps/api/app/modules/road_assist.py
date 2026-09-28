"""Prepared, source-bound road drafts and read-only topology diagnostics."""

import json
from collections import defaultdict
from itertools import chain, combinations, islice
from math import hypot
from pathlib import Path
from uuid import UUID

import networkx as nx
from fastapi import APIRouter, Request
from pydantic import Field

from app.api import DB, envelope
from app.contracts import DTO, XY, Envelope
from app.modules.admin.security import Actor
from app.modules.navigation import (
    STAFF,
    RoadGraph,
    public_points,
    road_path,
    scoped_map,
    validate_graph,
)

router = APIRouter(tags=["navigation"])
SEED = Path(__file__).with_name("road_seed.json")


class RoadStarter(DTO):
    available: bool
    title: str
    source: str
    source_sha256: str
    message: str
    graph: RoadGraph | None = None
    omitted_point_ids: list[UUID] = Field(default_factory=list)


class RoadIssue(DTO):
    code: str
    severity: str
    message: str
    node_ids: list[str] = Field(default_factory=list)
    edge_ids: list[str] = Field(default_factory=list)
    position: XY | None = None


class RoadQuality(DTO):
    node_count: int
    edge_count: int
    component_count: int
    unverified_edges: int
    candidate_entrances: int
    covered_points: int
    missing_point_ids: list[UUID]
    issues: list[RoadIssue]
    truncated: bool = False


def starter_for(db, m):
    seed = json.loads(SEED.read_text())
    target = seed["map"]
    matches = all(
        str(getattr(m, k)) == str(target[k])
        for k in ("id", "revision", "width_px", "height_px", "source_sha256")
    )
    result = RoadStarter(
        available=matches,
        title=seed["title"],
        source=seed["source"],
        source_sha256=target["source_sha256"],
        message="初稿已沿现有规划图整理；导入后精修、核对通行并审核。"
        if matches
        else "此初稿仅适用于已核对的津南校区第3版底图；当前底图不匹配，不自动缩放或覆盖。",
    )
    if not matches:
        return result
    graph = RoadGraph.model_validate(seed["graph"])
    available = public_points(db, m.campus_id, m.id, m.revision)
    unavailable_nodes = set()
    for node in graph.nodes:
        if node.point_id and str(node.point_id) not in available:
            unavailable_nodes.add(node.id)
            result.omitted_point_ids.append(node.point_id)
            node.point_id, node.kind = None, "waypoint"
            node.label += "（地点未公开，未关联）"
        node.candidate = bool(node.point_id)
    for edge in graph.edges:
        edge.verified, edge.distance_m, edge.step_free = False, None, None
        if edge.start in unavailable_nodes or edge.end in unavailable_nodes:
            edge.closed = True
            edge.evidence = "关联地点未公开，初稿自动隔离此入口连接；重新关联并核实后再开放。"
    validate_graph(db, m, graph)
    result.graph = graph
    return result


def quality_for(db, m, graph):
    validate_graph(db, m, graph)
    nodes = {n.id: n for n in graph.nodes}
    opened = [e for e in graph.edges if not e.closed]
    g = nx.Graph()
    g.add_nodes_from(nodes)
    g.add_edges_from((e.start, e.end) for e in opened)
    groups = sorted(nx.connected_components(g), key=lambda c: (-len(c), min(c)))
    issues = []

    def add(code, message, *, ns=(), es=(), position=None, severity="warning"):
        issues.append(
            RoadIssue(
                code=code,
                severity=severity,
                message=message,
                node_ids=list(ns),
                edge_ids=list(es),
                position=position,
            )
        )

    if len(groups) > 1:
        for group in groups[1:]:
            ordered = sorted(group)
            add(
                "DISCONNECTED",
                f"此区域有{len(group)}个节点，与主路网不连通",
                ns=ordered,
                position=nodes[ordered[0]].position,
            )
    for node in graph.nodes:
        if g.degree(node.id) == 0:
            add("ISOLATED", "此节点没有开放道路连接", ns=[node.id], position=node.position)
        if node.kind == "entrance" and node.candidate:
            add(
                "CANDIDATE_ENTRANCE",
                "规划图入口候选：请确认门口位置与实际可通行情况",
                ns=[node.id],
                position=node.position,
            )
    unverified = [e for e in opened if not e.verified or not e.evidence.strip()]
    if unverified:
        add(
            "UNVERIFIED",
            f"{len(unverified)}条开放道路待核验，可筛选后批量填写共同核验依据",
            es=[e.id for e in unverified],
            severity="info",
        )
    # Grid-indexed segment pairs avoid an all-pairs scan for dense graphs.
    cells, segments = defaultdict(list), []
    cell_size = 160.0
    geometry_truncated = sum(32 if e.curve_control else len(e.via) + 1 for e in opened) > 6000
    for edge in [] if geometry_truncated else opened:
        path = road_path(edge, nodes)
        for a, b in zip(path, path[1:], strict=False):
            idx = len(segments)
            segments.append((edge, a, b))
            for x in range(int(min(a.x, b.x) // cell_size), int(max(a.x, b.x) // cell_size) + 1):
                for y in range(
                    int(min(a.y, b.y) // cell_size), int(max(a.y, b.y) // cell_size) + 1
                ):
                    cells[x, y].append(idx)
    checked, crossed = set(), set()
    pairs = chain.from_iterable(combinations(indexes, 2) for indexes in cells.values())
    for count, (i, j) in enumerate(islice(pairs, 100001)):
        if count == 100000:
            geometry_truncated = True
            break
        e, a, b = segments[i]
        pair = (min(i, j), max(i, j))
        if pair in checked:
            continue
        checked.add(pair)
        f, c, d = segments[j]
        key = tuple(sorted((e.id, f.id)))
        if e.id == f.id or key in crossed or {e.start, e.end} & {f.start, f.end}:
            continue
        rx, ry, sx, sy = b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y
        det = rx * sy - ry * sx
        if abs(det) < 1e-9:
            continue
        t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / det
        u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / det
        if 0 <= t <= 1 and 0 <= u <= 1:
            crossed.add(key)
            add(
                "CROSSING",
                "道路在图上相交但没有共用路口；若为同层通路，可合并为路口",
                es=key,
                position=XY(x=a.x + t * rx, y=a.y + t * ry),
            )
    # Find near misses at loose endpoints; never auto-join across walls or water.
    gap_budget = 100000
    for node in graph.nodes:
        if g.degree(node.id) > 1:
            continue
        p = node.position
        candidates = set()
        for x in range(int((p.x - 35) // cell_size), int((p.x + 35) // cell_size) + 1):
            for y in range(int((p.y - 35) // cell_size), int((p.y + 35) // cell_size) + 1):
                candidates.update(cells.get((x, y), []))
        best = None
        for i in candidates:
            gap_budget -= 1
            if gap_budget < 0:
                geometry_truncated = True
                break
            edge, a, b = segments[i]
            if node.id in (edge.start, edge.end):
                continue
            dx, dy = b.x - a.x, b.y - a.y
            t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy or 1)))
            distance = hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
            if distance <= 35 and (best is None or distance < best[0]):
                best = (distance, edge.id)
        if best:
            add(
                "NEAR_GAP",
                "端点靠近另一条道路但尚未连通；核对后可用吸附拖动连接",
                ns=[node.id],
                es=[best[1]],
                position=p,
            )
    if geometry_truncated:
        add(
            "PARTIAL_CHECK", "图形较复杂，部分几何诊断未执行；请分区整理后再次检查", severity="info"
        )
    point_ids = public_points(db, m.campus_id, m.id, m.revision)
    covered = {str(n.point_id) for n in graph.nodes if n.point_id and g.degree(n.id) > 0}
    return RoadQuality(
        node_count=len(nodes),
        edge_count=len(graph.edges),
        component_count=len(groups),
        unverified_edges=len(unverified),
        candidate_entrances=sum(n.candidate and bool(n.point_id) for n in graph.nodes),
        covered_points=len(covered),
        missing_point_ids=sorted(set(point_ids) - covered),
        issues=issues[:200],
        truncated=len(issues) > 200 or geometry_truncated,
    )


@router.get(
    "/api/v1/admin/navigation/{map_id}/starter",
    response_model=Envelope[RoadStarter],
    operation_id="getRoadStarter",
    openapi_extra=STAFF,
)
def starter(map_id: UUID, request: Request, actor: Actor, db: DB):
    return envelope(request, starter_for(db, scoped_map(db, actor, map_id)))


@router.post(
    "/api/v1/admin/navigation/{map_id}/quality",
    response_model=Envelope[RoadQuality],
    operation_id="checkRoadQuality",
    openapi_extra=STAFF,
)
def quality(map_id: UUID, payload: RoadGraph, request: Request, actor: Actor, db: DB):
    return envelope(request, quality_for(db, scoped_map(db, actor, map_id), payload))
