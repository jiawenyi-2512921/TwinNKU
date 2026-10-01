"""Reviewed outdoor road graphs. Coordinates are original image pixels, never GPS."""

from datetime import timedelta
from math import hypot
from typing import Literal
from uuid import UUID, uuid4

import networkx as nx
from fastapi import APIRouter, Request
from pydantic import Field, model_validator
from sqlalchemy import select

from app.api import DB, envelope, require_campus
from app.contracts import DTO, XY, Envelope, RouteSegment
from app.core.errors import DomainError
from app.models import MapRecord, NavigationRecord, PointGeometryRecord, PointRecord, now_utc
from app.modules.admin.security import Actor, audit
from app.modules.guide_settings import policy_for

router = APIRouter(tags=["navigation"])
PUBLIC = {"x-implementation-status": "implemented", "x-module": "M03", "x-auth": "public"}
STAFF = {**PUBLIC, "x-auth": "staff"}


class RoadNode(DTO):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    position: XY
    label: str = Field(default="", max_length=100)
    kind: Literal["junction", "waypoint", "entrance"] = "junction"
    point_id: UUID | None = None
    candidate: bool = False
    evidence: str = Field(default="", max_length=500)


class RoadEdge(DTO):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    start: str
    end: str
    label: str = Field(default="", max_length=100)
    via: list[XY] = Field(default_factory=list, max_length=100)
    curve_control: XY | None = None
    bidirectional: bool = True
    closed: bool = False
    step_free: bool | None = None
    distance_m: float | None = Field(default=None, gt=0, le=20000)
    verified: bool = False
    evidence: str = Field(default="", max_length=500)


class RoadGraph(DTO):
    map_revision: int = Field(ge=1)
    nodes: list[RoadNode] = Field(default_factory=list, max_length=1000)
    edges: list[RoadEdge] = Field(default_factory=list, max_length=2000)
    note: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def connected_references(self):
        ids = [n.id for n in self.nodes]
        if len(set(ids)) != len(ids) or len({e.id for e in self.edges}) != len(self.edges):
            raise ValueError("节点和路段 ID 不得重复")
        pairs = set()
        for node in self.nodes:
            if (node.kind == "entrance") != bool(node.point_id):
                raise ValueError("建筑入口必须关联地点，其他节点不可关联地点")
        for e in self.edges:
            if e.curve_control is not None and e.via:
                raise ValueError("弧线控制点和折线形状点不能同时使用")
            if e.start not in ids or e.end not in ids or e.start == e.end:
                raise ValueError("路段必须连接两个已有的不同节点")
            directed = [(e.start, e.end)] + ([(e.end, e.start)] if e.bidirectional else [])
            if any(pair in pairs for pair in directed):
                raise ValueError("同方向的两个节点之间只能保留一条路段")
            pairs.update(directed)
        return self


def road_path(edge, nodes):
    """The editor and routing use the same 32-segment quadratic geometry."""
    a, b = nodes[edge.start].position, nodes[edge.end].position
    if edge.curve_control is None:
        return [a, *edge.via, b]
    c = edge.curve_control
    return [
        XY(
            x=(1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
            y=(1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
        )
        for t in [i / 32 for i in range(33)]
    ]


class RoadDraft(DTO):
    expected_revision: int = Field(ge=0)
    graph: RoadGraph


class RoadReview(DTO):
    expected_revision: int = Field(ge=1)
    action: Literal["submit", "publish", "reject", "withdraw"]
    note: str = Field(min_length=1, max_length=1000)


class RoadWorkspace(DTO):
    map_id: UUID
    revision: int
    published_revision: int
    state: str
    draft: RoadGraph | None
    published: RoadGraph | None
    contributor_ids: list[str]
    review_note: str


class RoadSummary(DTO):
    map_id: UUID
    title: str
    state: str
    revision: int
    published_revision: int


class NavigationRequest(DTO):
    map_id: UUID
    map_revision: int = Field(ge=1)
    start_point_id: UUID
    end_point_id: UUID
    step_free: bool = False
    graph_revision: int | None = Field(default=None, ge=1)


class NavigationPath(DTO):
    id: UUID
    map_id: UUID
    graph_revision: int
    start_point_id: UUID
    end_point_id: UUID
    segments: list[RouteSegment]
    distance_m: float | None
    warnings: list[str]
    expires_at: str


class NavigationAvailability(DTO):
    map_id: UUID
    map_revision: int
    graph_revision: int | None
    available_point_ids: list[UUID]
    ready: bool
    message: str


def public_map(db, map_id):
    m = db.get(MapRecord, str(map_id))
    if not m or m.kind != "campus" or m.status != "published" or m.visibility != "public":
        raise DomainError("MAP_UNAVAILABLE", "校园地图暂不可用", 404)
    require_campus(db, m.campus_id)
    return m


def public_points(db, campus_id, map_id=None, map_revision=None):
    query = select(PointRecord).where(
        PointRecord.campus_id == campus_id,
        PointRecord.status == "published",
        PointRecord.visibility == "public",
    )
    if map_id is not None:
        query = query.join(
            PointGeometryRecord, PointGeometryRecord.point_id == PointRecord.id
        ).where(
            PointGeometryRecord.map_id == str(map_id),
            PointGeometryRecord.map_revision == map_revision,
        )
    return {p.id: p for p in db.scalars(query)}


def validate_graph(db, m, graph, *, publish=False):
    if graph.map_revision != m.revision:
        raise DomainError("STALE_MAP", "底图版本已更新，请核对全部道路和入口后再保存", 409)
    points = public_points(db, m.campus_id, m.id, m.revision)
    for n in graph.nodes:
        if n.point_id and str(n.point_id) not in points:
            raise DomainError("INVALID_ENTRANCE", "入口必须关联本校区已公开的地点", 422)
    coordinates = [n.position for n in graph.nodes] + [v for e in graph.edges for v in e.via]
    coordinates += [e.curve_control for e in graph.edges if e.curve_control is not None]
    if any(p.x > m.width_px or p.y > m.height_px for p in coordinates):
        raise DomainError("INVALID_ROAD", "道路坐标超出底图边界", 422)
    nodes = {n.id: n for n in graph.nodes}
    for edge in graph.edges:
        line = road_path(edge, nodes)
        if sum(hypot(b.x - a.x, b.y - a.y) for a, b in zip(line, line[1:], strict=False)) <= 0:
            raise DomainError("INVALID_ROAD", "路段长度必须大于零", 422)
    if publish and (
        not graph.edges
        or not graph.note.strip()
        or any(not e.closed and (not e.verified or not e.evidence.strip()) for e in graph.edges)
        or any(
            n.kind == "entrance"
            and n.candidate
            and any(not e.closed and n.id in (e.start, e.end) for e in graph.edges)
            for n in graph.nodes
        )
    ):
        raise DomainError(
            "ROAD_NOT_VERIFIED", "请确认候选入口，并核实开放道路的通行情况及依据", 422
        )


def availability(db, map_id):
    m = public_map(db, map_id)
    row = db.get(NavigationRecord, m.id)
    graph = RoadGraph.model_validate(row.published) if row and row.published else None
    ready = bool(policy_for(db).navigation_enabled and graph and graph.map_revision == m.revision)
    points = public_points(db, m.campus_id, m.id, m.revision)
    usable = (
        {v for e in graph.edges if e.verified and not e.closed for v in (e.start, e.end)}
        if ready
        else set()
    )
    ids = (
        sorted(
            {
                n.point_id
                for n in graph.nodes
                if n.id in usable and str(n.point_id) in points and not n.candidate
            },
            key=str,
        )
        if ready
        else []
    )
    return NavigationAvailability(
        map_id=m.id,
        map_revision=m.revision,
        graph_revision=row.published_revision if ready else None,
        available_point_ids=ids,
        ready=ready and len(ids) >= 2,
        message="已发布核验路网；请自行选择起点"
        if ready and len(ids) >= 2
        else "道路与建筑入口尚未完成核验，可先定位目的地",
    )


def calculate(db, payload, *, draft=None):
    if not draft and not policy_for(db).navigation_enabled:
        raise DomainError("NAVIGATION_DISABLED", "导航暂时关闭，仍可查看地点与资料", 503)
    m = public_map(db, payload.map_id)
    row = db.get(NavigationRecord, m.id)
    if payload.map_revision != m.revision:
        raise DomainError("STALE_MAP", "底图已更新，请重新选择路线", 409)
    graph = draft or (RoadGraph.model_validate(row.published) if row and row.published else None)
    if not graph or graph.map_revision != m.revision:
        raise DomainError(
            "ROAD_GRAPH_UNAVAILABLE", "此地图尚无有效的已审核路网，请先查看目的地位置", 409
        )
    revision = row.published_revision if row and not draft else (row.revision if row else 0)
    if payload.graph_revision is not None and payload.graph_revision != revision:
        raise DomainError("STALE_GRAPH", "道路状态已更新，请重新计算路线", 409)
    points = public_points(db, m.campus_id, m.id, m.revision)
    start, end = str(payload.start_point_id), str(payload.end_point_id)
    if start not in points or end not in points:
        raise DomainError("POINT_UNAVAILABLE", "起点或终点已下架，请重新选择", 404)
    if start == end:
        raise DomainError("SAME_DESTINATION", "起点和终点相同，无需导航", 422)
    nodes = {n.id: n for n in graph.nodes}
    # Retired point entrances cannot be used as shortcuts through restricted buildings.
    blocked = {
        n.id
        for n in graph.nodes
        if n.point_id and (str(n.point_id) not in points or (n.candidate and not draft))
    }
    edges = [
        e
        for e in graph.edges
        if not e.closed
        and (e.verified or draft)
        and e.start not in blocked
        and e.end not in blocked
        and (not payload.step_free or e.step_free is True)
    ]
    measured = bool(edges) and all(e.distance_m is not None for e in edges)
    g = nx.DiGraph()
    for edge in edges:
        path = road_path(edge, nodes)
        length = sum(hypot(b.x - a.x, b.y - a.y) for a, b in zip(path, path[1:], strict=False))
        g.add_edge(
            edge.start,
            edge.end,
            weight=edge.distance_m if measured else length,
            path=path,
            distance=edge.distance_m,
        )
        if edge.bidirectional:
            g.add_edge(
                edge.end,
                edge.start,
                weight=edge.distance_m if measured else length,
                path=list(reversed(path)),
                distance=edge.distance_m,
            )
    starts = [n.id for n in graph.nodes if str(n.point_id) == start and n.id in g]
    ends = {n.id for n in graph.nodes if str(n.point_id) == end and n.id in g}
    if not starts or not ends:
        raise DomainError("ENTRANCE_UNAVAILABLE", "起点或终点尚无可通行的已核实入口", 409)
    lengths, paths = nx.multi_source_dijkstra(g, starts)
    targets = [n for n in ends if n in lengths]
    if not targets:
        raise DomainError(
            "ROUTE_UNAVAILABLE", "已核实道路无法连通这两个地点，请更换起点或通行方式", 409
        )
    path_nodes = paths[min(targets, key=lambda n: (lengths[n], n))]
    line, distances = [], []
    for a, b in zip(path_nodes, path_nodes[1:], strict=False):
        edge = g[a][b]
        line.extend(edge["path"] if not line else edge["path"][1:])
        distances.append(edge["distance"])
    if not distances:
        raise DomainError("ROUTE_UNAVAILABLE", "入口数据不完整", 409)
    distance = round(sum(distances), 1) if all(v is not None for v in distances) else None
    warnings = ["路线基于已核实的道路和入口，现场临时管控优先；不提供实时定位。"]
    if not measured:
        warnings.append(
            "按规划图道路长度选路，未承诺实际最短距离；未测量路段不显示米数或步行时间。"
        )
    if draft:
        warnings.insert(0, "仅供管理员预览：未审核路线不可用于对外导航。")
    return NavigationPath(
        id=uuid4(),
        map_id=m.id,
        graph_revision=revision,
        start_point_id=start,
        end_point_id=end,
        segments=[
            RouteSegment(
                map_id=m.id, map_revision=m.revision, floor_id=None, path=line, distance_m=distance
            )
        ],
        distance_m=distance,
        warnings=warnings,
        expires_at=(now_utc() + timedelta(minutes=5)).isoformat(),
    )


def scoped_map(db, actor, map_id):
    m = public_map(db, map_id)
    u = actor.user
    if u.role != "admin" and (m.campus_id not in u.campus_ids or u.point_ids):
        raise DomainError("SCOPE_DENIED", "路网维护需要整个校区的权限", 403)
    return m


def view(row, map_id):
    return RoadWorkspace(
        map_id=map_id,
        revision=row.revision if row else 0,
        published_revision=row.published_revision if row else 0,
        state=row.state if row else "empty",
        draft=row.draft if row else None,
        published=row.published if row else None,
        contributor_ids=row.contributor_ids if row else [],
        review_note=row.review_note if row else "",
    )


@router.get(
    "/api/v1/admin/navigation",
    response_model=Envelope[list[RoadSummary]],
    operation_id="listRoadWorkspaces",
    openapi_extra=STAFF,
)
def list_workspaces(request: Request, actor: Actor, db: DB):
    result = []
    for m in db.scalars(
        select(MapRecord).where(
            MapRecord.kind == "campus",
            MapRecord.status == "published",
            MapRecord.visibility == "public",
        )
    ):
        try:
            scoped_map(db, actor, m.id)
        except DomainError:
            continue
        row = db.get(NavigationRecord, m.id)
        result.append(
            RoadSummary(
                map_id=m.id,
                title=m.title,
                state=row.state if row else "empty",
                revision=row.revision if row else 0,
                published_revision=row.published_revision if row else 0,
            )
        )
    return envelope(request, result)


@router.get(
    "/api/v1/navigation/maps/{map_id}",
    response_model=Envelope[NavigationAvailability],
    operation_id="getNavigationAvailability",
    openapi_extra=PUBLIC,
)
def get_availability(map_id: UUID, request: Request, db: DB):
    return envelope(request, availability(db, map_id))


@router.post(
    "/api/v1/navigation/route",
    response_model=Envelope[NavigationPath],
    operation_id="calculateNavigationPath",
    openapi_extra=PUBLIC,
)
def route(payload: NavigationRequest, request: Request, db: DB):
    return envelope(request, calculate(db, payload))


@router.get(
    "/api/v1/admin/navigation/{map_id}",
    response_model=Envelope[RoadWorkspace],
    operation_id="getRoadWorkspace",
    openapi_extra=STAFF,
)
def workspace(map_id: UUID, request: Request, actor: Actor, db: DB):
    m = scoped_map(db, actor, map_id)
    return envelope(request, view(db.get(NavigationRecord, m.id), m.id))


@router.put(
    "/api/v1/admin/navigation/{map_id}",
    response_model=Envelope[RoadWorkspace],
    operation_id="saveRoadDraft",
    openapi_extra=STAFF,
)
def save(map_id: UUID, payload: RoadDraft, request: Request, actor: Actor, db: DB):
    m = scoped_map(db, actor, map_id)
    if actor.user.role not in {"admin", "editor"}:
        raise DomainError("FORBIDDEN", "当前角色不能编辑路网", 403)
    # Lock map row as well: serializes the first graph creation on PostgreSQL.
    db.scalar(select(MapRecord).where(MapRecord.id == m.id).with_for_update())
    row = db.get(NavigationRecord, m.id, populate_existing=True)
    if payload.expected_revision != (row.revision if row else 0):
        raise DomainError("REVISION_CONFLICT", "路网已被修改，请重新加载", 409)
    if row and row.state == "in_review":
        raise DomainError("IN_REVIEW", "请先撤回待审路网", 409)
    validate_graph(db, m, payload.graph)
    if row is None:
        row = NavigationRecord(
            map_id=m.id, revision=0, published_revision=0, contributor_ids=[], review_note=""
        )
        db.add(row)
    if row.state in {"published", "empty"}:
        row.contributor_ids = []
    row.contributor_ids = sorted(set(row.contributor_ids or []) | {actor.user.id})
    row.draft, row.state = payload.graph.model_dump(mode="json"), "draft"
    row.revision += 1
    row.updated_at = now_utc()
    audit(db, actor.user, "navigation.save", details={"map_id": m.id, "revision": row.revision})
    db.commit()
    return envelope(request, view(row, m.id))


@router.post(
    "/api/v1/admin/navigation/{map_id}/review",
    response_model=Envelope[RoadWorkspace],
    operation_id="reviewRoadDraft",
    openapi_extra=STAFF,
)
def review(map_id: UUID, payload: RoadReview, request: Request, actor: Actor, db: DB):
    m = scoped_map(db, actor, map_id)
    row = db.scalar(
        select(NavigationRecord).where(NavigationRecord.map_id == m.id).with_for_update()
    )
    if not row or row.revision != payload.expected_revision:
        raise DomainError("REVISION_CONFLICT", "路网已变化，请重新加载", 409)
    u = actor.user
    if payload.action in {"submit", "withdraw"}:
        if u.role not in {"admin", "editor"}:
            raise DomainError("FORBIDDEN", "当前角色不能提交或撤回", 403)
        expected = {"draft", "rejected"} if payload.action == "submit" else {"in_review"}
        if row.state not in expected:
            raise DomainError("INVALID_STATE", "当前路网状态不支持此操作", 409)
        if payload.action == "submit":
            validate_graph(db, m, RoadGraph.model_validate(row.draft), publish=True)
            row.contributor_ids = sorted(set(row.contributor_ids) | {u.id})
        row.state = "in_review" if payload.action == "submit" else "draft"
    else:
        if u.role not in {"admin", "reviewer"} or u.id in row.contributor_ids:
            raise DomainError("REVIEW_FORBIDDEN", "需要未参与本次编辑和提交的审核员处理", 403)
        if row.state != "in_review":
            raise DomainError("INVALID_STATE", "路网当前不在待审状态", 409)
        if payload.action == "publish":
            validate_graph(db, m, RoadGraph.model_validate(row.draft), publish=True)
            row.published = row.draft
            row.published_revision += 1
        row.state = "published" if payload.action == "publish" else "rejected"
    row.review_note, row.updated_at = payload.note, now_utc()
    row.revision += 1
    audit(
        db,
        u,
        "navigation." + payload.action,
        note=payload.note,
        details={"map_id": m.id, "revision": row.revision},
    )
    db.commit()
    return envelope(request, view(row, m.id))


@router.post(
    "/api/v1/admin/navigation/{map_id}/preview",
    response_model=Envelope[NavigationPath],
    operation_id="previewRoadDraft",
    openapi_extra=STAFF,
)
def preview(map_id: UUID, payload: NavigationRequest, request: Request, actor: Actor, db: DB):
    m = scoped_map(db, actor, map_id)
    row = db.get(NavigationRecord, m.id)
    if str(payload.map_id) != m.id or not row or not row.draft:
        raise DomainError("DRAFT_UNAVAILABLE", "请先保存本地图路网草稿", 409)
    return envelope(request, calculate(db, payload, draft=RoadGraph.model_validate(row.draft)))
