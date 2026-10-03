import { test } from "node:test";
import assert from "node:assert/strict";
import { controlledAdmin, button, find, text } from "./helpers/controlled-admin.mjs";
import * as panorama from "../src/features/points/panorama.ts";
import * as progress from "../src/features/experiences/progress.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const field = (tree, label) => find(tree, (node) => node.type === "label" && text(node).startsWith(label))
  .flatMap((node) => find(node, (child) => ["select","input","textarea"].includes(child.type)))[0];
const pointId = "11111111-1111-4111-8111-111111111111", resourceId = "22222222-2222-4222-8222-222222222222";
const imageId = "33333333-3333-4333-8333-333333333333";
const session = { user: { id: "staff", role: "editor" }, permissions: ["points.read", "points.edit"] };
const data = { resource_id: resourceId, expected_revision: 4, expected_published_revision: 2, items: [], latest: [], has_more: false };
const check = (id, extra={}) => ({ id: "row", operation_id: id, dimension: "technical", platform: null, result: "passed", reason: "none", environment: "", notes: "", recorded_by: "staff", recorded_at: "2026-10-03T01:02:03Z", method: "manual", stale: false, ...extra });
function checksHarness(reply = async() => null, overrides={}, initialStorage=new Map()) {
  const calls=[], activity=[];
  const h=controlledAdmin({
    "./api": { message:(e)=>e.message, request: async(path,method="GET",body,signal)=> {
      calls.push({path,method,body,signal});
      return {data: method==="GET" && !path.includes("/operations/") ? structuredClone(overrides.data??data) : await reply(path,method,body)};
    } }, "../points/panorama": panorama,
  });
  h.browser.sessionStorage={ getItem:(key)=>initialStorage.get(key)??null, setItem:(key,value)=>initialStorage.set(key,value), removeItem:(key)=>initialStorage.delete(key) };
  const Component=h.load("./VRChecks").VRChecks;
  const props={id:resourceId,revision:4,publishedRevision:2,url:"https://example.edu/vr#scene_0138",session,blocked:false,onActivity:(...v)=>activity.push(v),onRefreshResource(){},...overrides};
  return {...h, calls, activity, storage:initialStorage, props, render:()=>h.render("checks",Component,props)};
}
async function ready(h) { h.render(); await tick(); return h.render(); }
const submit=(tree)=>find(tree,(n)=>n.type==="form")[0]?.props.onSubmit({preventDefault(){}});

test("actual manual device registration pins saved revisions and cannot publish content",async()=>{
  const h=checksHarness(async(_path,method,body)=>method==="POST"?check(body.operation_id,{dimension:body.dimension,platform:body.platform}):null);
  let tree=await ready(h);
  field(tree,"核查维度").props.onChange({target:{value:"3"}}); tree=h.render();
  field(tree,"实际结果").props.onChange({target:{value:"passed"}}); tree=h.render();
  field(tree,"设备与浏览器环境").props.onChange({target:{value:"Android 实际浏览器"}}); tree=h.render();
  field(tree,"内部核查备注").props.onChange({target:{value:"人工核查私有依据"}}); tree=h.render();
  submit(tree); await tick(); tree=h.render();
  const writes=h.calls.filter((call)=>call.method==="POST");
  assert.equal(writes.length,1); assert.equal(writes[0].path,`/resources/${resourceId}/vr-checks`);
  assert.equal(writes[0].body.dimension,"device"); assert.equal(writes[0].body.platform,"android");
  assert.equal(writes[0].body.reason,"none"); assert.equal(writes[0].body.expected_revision,4);
  assert.equal(writes[0].body.expected_published_revision,2); assert.equal(writes[0].body.environment,"Android 实际浏览器");
  assert.ok(!h.calls.some((call)=>/publish|submit|paid|probe|voice/.test(call.path)));
  assert.match(text(tree),/发布状态保持不变/); assert.match(text(tree),/不是实际测试时刻/);
  assert.equal(find(tree,(n)=>n.type==="iframe").length,0); h.dispose();
});

test("lost POST response recovers only its receipt and never repeats a write",async()=>{
  let operation;
  const h=checksHarness(async(path,method,body)=>{
    if(method==="POST") { operation=body.operation_id; throw new Error("network disappeared"); }
    assert.equal(path,`/resources/${resourceId}/vr-checks/operations/${operation}`); return check(operation);
  });
  submit(await ready(h)); await tick(); const tree=h.render();
  assert.equal(h.calls.filter((call)=>call.method==="POST").length,1);
  assert.equal(h.calls.filter((call)=>call.path.includes("/operations/")).length,1);
  assert.match(text(tree),/已登记/); assert.equal(h.storage.size,0); h.dispose();
});

test("unknown receipt survives remount; null/read failure cannot enable POST replay",async()=>{
  const storage=new Map();
  const h=checksHarness(async(_path,method)=>{if(method==="POST") throw new Error("timeout"); return null;},{},storage);
  submit(await ready(h)); await tick(); let tree=h.render();
  assert.match(text(tree),/原登记结果待确认/); assert.equal(find(tree,(n)=>n.type==="form").length,0);
  button(tree,"查询原核查登记结果").props.onClick(); await tick(); tree=h.render();
  assert.match(text(tree),/不能证明原请求失败/); assert.equal(h.calls.filter((call)=>call.method==="POST").length,1);
  assert.equal(storage.size,1); h.dispose();
  const next=checksHarness(async()=>null,{},storage); tree=await ready(next);
  assert.ok(button(tree,"查询原核查登记结果")); assert.equal(find(tree,(n)=>n.type==="form").length,0);
  button(tree,"查询原核查登记结果").props.onClick(); await tick(); next.render();
  assert.ok(next.calls.every((call)=>call.method==="GET")); next.dispose();
});

test("a mismatched operation receipt remains uncertain rather than falsely confirmed",async()=>{
  const h=checksHarness(async()=>check("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  submit(await ready(h)); await tick(); const tree=h.render();
  assert.match(text(tree),/尚未确认/); assert.equal(h.storage.size,1); h.dispose();
});

test("known version rejection clears pending intent without a second POST",async()=>{
  const h=checksHarness(async()=>{throw Object.assign(new Error("版本已变化"),{status:409});});
  submit(await ready(h)); await tick(); const tree=h.render();
  assert.match(text(tree),/版本已变化/); assert.equal(h.storage.size,0);
  assert.equal(h.calls.filter((call)=>call.path.includes("/operations/")).length,0); h.dispose();
});

test("dirty or changed revisions guard the handler; viewer is read-only and reviewer may record evidence",async()=>{
  const h=checksHarness(async()=>assert.fail("write must be blocked"),{blocked:true});
  submit(await ready(h)); await tick(); assert.ok(h.calls.every((call)=>call.method==="GET")); h.dispose();
  const stale=checksHarness(async()=>assert.fail("stale write"),{data:{...data,expected_revision:8}});
  const tree=await ready(stale); assert.match(text(tree),/资料版本已改变/); submit(tree);
  await tick(); assert.ok(stale.calls.every((call)=>call.method==="GET")); stale.dispose();
  const viewer=checksHarness(async()=>null,{session:{user:{id:"viewer"},permissions:["points.read"]}});
  assert.equal(find(await ready(viewer),(node)=>node.type==="form").length,0); viewer.dispose();
  const reviewer=checksHarness(async()=>null,{session:{user:{id:"reviewer"},permissions:["points.read","points.review"]}});
  assert.equal(find(await ready(reviewer),(node)=>node.type==="form").length,1); reviewer.dispose();
});

test("current URL dimension summary uses exact server latest records, not truncated history",async()=>{
  const h=checksHarness(async()=>null,{data:{...data,items:[check("old",{stale:true})],latest:[check("new",{dimension:"device",platform:"ios",result:"failed",reason:"device_failure"})],has_more:true}});
  const tree=await ready(h), grid=find(tree,(n)=>n.type==="dl")[0];
  assert.equal(find(grid,(n)=>n.type==="dt").length,6); assert.match(text(grid),/iOS人工核查失败/);
  assert.match(text(grid),/原站入口可访问当前链接尚无记录/); assert.match(text(tree),/不适用于当前链接/);
  assert.match(text(tree),/最近 50 条/); h.dispose();
});

test("cover selector filters exact point/image/version and never auto-selects first candidate",async()=>{
  const changes=[], reads=[];
  const items=[{id:imageId,revision:3,content:{kind:"media",media_type:"image",point_id:pointId,title:"真实封面"},media_url:`/api/v1/experiences/${imageId}/media`},
    {id:"other",revision:1,content:{kind:"media",media_type:"image",point_id:"other-point",title:"跨点"}},
    {id:"video",revision:1,content:{kind:"media",media_type:"video",point_id:pointId,title:"视频"}},
    {id:"draft",revision:0,content:{kind:"media",media_type:"image",point_id:pointId,title:"非正式"}}];
  const h=controlledAdmin({"../../shared/api/client":{get:async(path,signal)=>{reads.push({path,signal});return {data:items};}},"../experiences/progress":progress});
  const Component=h.load("./VRCoverPicker").VRCoverPicker;
  const props={pointId,id:imageId,revision:1,onChange:(...value)=>changes.push(value)};
  h.render("cover",Component,props); await tick(); let tree=h.render("cover",Component,props);
  assert.equal(changes.length,0); assert.match(reads[0].path,new RegExp(`point_id=${pointId}`));
  const options=find(tree,(n)=>n.type==="option"); assert.equal(options.length,3);
  assert.match(text(tree),/原封面版本暂不可用/); assert.ok(!text(tree).includes("跨点"));
  field(tree,"目录封面").props.onChange({target:{value:`${imageId}:3`}});
  assert.deepEqual(changes,[[imageId,3]]);
  field(tree,"目录封面").props.onChange({target:{value:"other:1"}}); assert.equal(changes.length,1);
  field(tree,"目录封面").props.onChange({target:{value:""}}); assert.deepEqual(changes[1],[null,null]); h.dispose();
});

test("point changes abort old cover responses and cannot expose old-point candidates",async()=>{
  const reads=[];
  const h=controlledAdmin({"../../shared/api/client":{get:(path,signal)=>new Promise((resolve)=>reads.push({path,signal,resolve}))},"../experiences/progress":progress});
  const Component=h.load("./VRCoverPicker").VRCoverPicker;
  let props={pointId,id:null,revision:null,onChange(){}};
  h.render("cover",Component,props); props={...props,pointId:"new-point"}; h.render("cover",Component,props);
  assert.equal(reads[0].signal.aborted,true); reads[0].resolve({data:[{id:"old",revision:1,content:{kind:"media",media_type:"image",point_id:pointId,title:"旧点封面"}}]});
  await tick(); assert.ok(!text(h.render("cover",Component,props)).includes("旧点封面")); h.dispose();
});

test("safe cover accepts only exact server-bound public URL, not remote or private sources",()=>{
  const row={id:resourceId,point_id:pointId,revision:2,cover_image_id:imageId,cover_image_revision:3};
  const path=`/api/v1/points/${pointId}/panoramas/${resourceId}/cover/2/${imageId}/3`;
  assert.equal(panorama.safePanoramaCover({...row,cover_image_url:path}),path);
  for(const url of [`${path}?other=1`,path.replace("/2/","/1/"),"https://example.edu/image.png","/api/v1/admin/secret"])
    assert.equal(panorama.safePanoramaCover({...row,cover_image_url:url}),null);
  assert.equal(panorama.safePanoramaCover({...row,cover_image_revision:0,cover_image_url:path}),null);
});

test("public summary distinguishes six manual dimensions and ignores private extras and unverified flags",()=>{
  const h=controlledAdmin({"./panorama":panorama});
  const Component=h.load("./../points/VRPresentation").VRCheckSummary;
  const value={ technical:{result:"passed",method:"manual",recorded_at:"2026-10-03T01:02:03Z",notes:"不得公开备注",recorded_by:"private-staff"},
    scene:{result:"passed"},devices:{desktop:{result:"failed",method:"manual",recorded_at:null},ios:{result:"uncertain",method:"manual"}} };
  const tree=h.render("summary",Component,{checks:value});
  assert.equal(find(tree,(n)=>n.type==="dt").length,6); assert.match(text(tree),/人工核查记录/);
  assert.match(text(tree),/不代表全景画面或设备可用/); assert.match(text(tree),/不代表实际测试时刻/);
  const groups=find(tree,(n)=>n.type==="div");
  assert.match(text(groups.find((n)=>text(n).startsWith("场景匹配"))),/尚无人工/);
  assert.match(text(groups.find((n)=>text(n).startsWith("桌面浏览器"))),/未通过/);
  assert.ok(!text(tree).includes("不得公开备注")); assert.ok(!text(tree).includes("private-staff")); h.dispose();
});

test("cover errors fall back to text, while new exact revisions may load anew",()=>{
  const h=controlledAdmin({"./panorama":panorama});
  const Component=h.load("./../points/VRPresentation").VRCover;
  let item={id:resourceId,point_id:pointId,revision:2,cover_image_id:imageId,cover_image_revision:3};
  item.cover_image_url=`/api/v1/points/${pointId}/panoramas/${resourceId}/cover/2/${imageId}/3`;
  let tree=h.render("cover",Component,{item});
  assert.equal(find(tree,(n)=>n.type==="img")[0].props.alt,"");
  find(tree,(n)=>n.type==="img")[0].props.onError();
  assert.equal(h.render("cover",Component,{item}),null);
  item={...item,revision:3,cover_image_url:item.cover_image_url.replace("/cover/2/","/cover/3/")};
  tree=h.render("cover",Component,{item}); assert.equal(find(tree,(n)=>n.type==="img").length,1); h.dispose();
});

test("shared public presentation retains approved text and observation without rendering HTML",()=>{
  const h=controlledAdmin({"./panorama":panorama});
  const Component=h.load("./../points/VRPresentation").VRPresentation;
  const item={description:"真实来源文字",observation_prompt:"<script>plain text</script>",checks:{}};
  const tree=h.render("presentation",Component,{item});
  assert.match(text(tree),/真实来源文字/); assert.match(text(tree),/<script>plain text<\/script>/);
  assert.equal(find(tree,(n)=>n.type==="script"||n.type==="iframe"||n.props?.dangerouslySetInnerHTML).length,0); h.dispose();
});
