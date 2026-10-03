import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { controlledAdmin, find, button, text } from "./helpers/controlled-admin.mjs";
import * as progress from "../src/features/experiences/progress.ts";
import * as segments from "../src/features/experiences/segments.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sourceId="11111111-1111-4111-8111-111111111111", targetId="22222222-2222-4222-8222-222222222222", pointId="33333333-3333-4333-8333-333333333333";
const content={kind:"media",media_type:"video",point_id:pointId,title:"原版测试视频",description:"测试资料",source_note:"非真实校园内容",upload_id:"upload",url:null,alternative_text:"",transcript:"原版等价文字",caption_upload_id:null,caption_language:"zh-CN",caption_label:"中文字幕",video_visual_information:"description_required",video_accessibility_note:"已人工核对关键画面",audio_description_video_id:targetId,audio_description_video_revision:3};
const source={id:sourceId,revision:2,content,media_url:`/api/v1/experiences/${sourceId}/media`};
const path=`/experiences/${sourceId}/audio-description/2/${targetId}/3`;
const alternative={id:targetId,revision:3,content:{...content,title:"口述描述版测试",transcript:"描述版文字稿",video_visual_information:"audio_complete",audio_description_video_id:null,audio_description_video_revision:null},media_url:`/api/v1${path}/media`};
const field=(tree,label)=>find(tree,(node)=>node.type==="label"&&text(node).startsWith(label)).flatMap((node)=>find(node,(child)=>["input","select","textarea"].includes(child.type)))[0];
function publicHarness(reply=async()=>alternative){
  let notify;
  const reads=[], events=[];
  const h=controlledAdmin({});
  const react=h.load("react"), jsx=h.load("react/jsx-runtime");
  const exports={};
  const context={active:true,onMediaActiveChange:(value)=>events.push(value)};
  const code=ts.transpileModule(readFileSync(new URL("../src/features/experiences/ExperiencePanel.tsx",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{exports,AbortController,URLSearchParams,JSON,require(name){
    if(name==="react")return{...react,createContext:(value)=>({value}),useContext:()=>context,lazy:()=>()=>null,Suspense:()=>null};
    if(name==="react/jsx-runtime")return jsx;
    if(name.endsWith(".css"))return{};
    if(name.endsWith("/client"))return{get:async(url,signal)=>{reads.push({url,signal});return{data:await reply(url,signal)}}};
    if(name.endsWith("catalogSync"))return{watchCatalogChanges:(fn)=>{notify=fn;return()=>{notify=null}}};
    if(name==="./types")return{experienceNames:{},sceneResource:(value)=>value};
    if(name==="./segments")return segments;
    if(name==="./progress")return progress;
    if(name.endsWith("audioOwner"))return{pauseTour:()=>events.push("pause-tour"),acquireAudio:()=>1,releaseAudio:()=>events.push("release")};
    if(name.endsWith("VRPresentation"))return{VRPresentation:()=>null};
    throw new Error(name);
  }});
  const props={item:structuredClone(source)};
  return{...h,reads,events,context,props,render:()=>h.render("public",exports.MediaView,props),notify:()=>notify?.()};
}

test("public variant choice pins both formal versions and preserves explicit playback consent",async()=>{
  const h=publicHarness();let tree=h.render();
  assert.match(text(tree),/当前：原版视频/);assert.equal(h.reads.length,0);
  button(tree,"打开视频播放器").props.onClick();tree=h.render();
  const video=find(tree,(node)=>node.type==="video")[0];let pauses=0,plays=0;
  video.props.ref.current={pause(){pauses++},play(){plays++;return Promise.resolve()}};
  button(tree,"切换口述描述版").props.onClick();tree=h.render();
  assert.ok(pauses>0);assert.equal(find(tree,(node)=>node.type==="video").length,0);
  await tick();tree=h.render();assert.equal(h.reads[0].url,path);
  assert.match(text(tree),/当前：口述描述版/);assert.ok(button(tree,"打开视频播放器"));
  assert.equal(plays,0);assert.equal(find(tree,(node)=>node.type==="video").length,0);
  button(tree,"打开视频播放器").props.onClick();tree=h.render();
  assert.equal(find(tree,(node)=>node.type==="video")[0].props.src,alternative.media_url);
  button(tree,"返回原版视频").props.onClick();tree=h.render();
  assert.ok(button(tree,"打开视频播放器"));assert.match(text(tree),/当前：原版视频/);
  assert.equal(h.reads.length,1);assert.ok(h.events.includes("pause-tour"));h.dispose();
});

test("variant wrong point or revision never becomes playable; retry only reads and preserves original text",async()=>{
  for(const wrong of[{...alternative,revision:4},{...alternative,content:{...alternative.content,point_id:"foreign"}},{...alternative,media_url:"https://example.com/unchecked.mp4"}]){
    const h=publicHarness(async()=>wrong);button(h.render(),"切换口述描述版").props.onClick();h.render();await tick();const tree=h.render();
    assert.match(text(tree),/暂不可用或已更新/);assert.match(text(tree),/原版等价文字/);
    assert.equal(find(tree,(node)=>node.type==="video").length,0);
    button(tree,"重试口述描述版").props.onClick();h.render();await tick();h.render();
    assert.equal(h.reads.length,2);h.dispose();
  }
});

test("variant withdrawal stops playback on actual catalog refresh without silently reverting or autoplaying",async()=>{
  let withdrawn=false;const h=publicHarness(async()=>{if(withdrawn)throw new Error("withdrawn");return alternative});
  button(h.render(),"切换口述描述版").props.onClick();h.render();await tick();let tree=h.render();
  button(tree,"打开视频播放器").props.onClick();tree=h.render();let paused=0;
  find(tree,(node)=>node.type==="video")[0].props.ref.current={pause(){paused++}};
  withdrawn=true;h.notify();await tick();tree=h.render();
  assert.ok(paused>0);assert.match(text(tree),/口述描述版暂不可用/);
  assert.equal(find(tree,(node)=>node.type==="video").length,0);h.dispose();
});

test("return or new source version aborts a late variant read and cannot install the old player",async()=>{
  let resolve;const h=publicHarness(()=>new Promise((done)=>{resolve=done}));
  button(h.render(),"切换口述描述版").props.onClick();h.render();
  button(h.render(),"返回原版视频").props.onClick();h.render();
  assert.equal(h.reads[0].signal.aborted,true);resolve(alternative);await tick();let tree=h.render();
  assert.match(text(tree),/当前：原版视频/);assert.equal(find(tree,(node)=>node.type==="video").length,0);
  h.props.item={...source,revision:5};tree=h.render();assert.match(text(tree),/当前：原版视频/);h.dispose();
});

test("private historical media preview never resolves the current public source alternative",()=>{
  const h=publicHarness(async()=>assert.fail("historical source must not request current description"));
  h.props.previewOnly=true;const tree=h.render();
  assert.equal(button(tree,"切换口述描述版"),undefined);assert.equal(h.reads.length,0);
  assert.match(text(tree),/原版等价文字/);h.dispose();
});

test("description picker accepts only same-point audio-complete current published alternatives and never auto-selects",async()=>{
  const reads=[],picked=[];const candidates=[alternative,{...alternative,id:sourceId},{...alternative,id:"image",content:{...alternative.content,media_type:"image"}},{...alternative,id:"other",content:{...alternative.content,point_id:"foreign"}},{...alternative,id:"chain",content:{...alternative.content,audio_description_video_id:"another"}}];
  const h=controlledAdmin({"../../shared/api/client":{get:async(url,signal)=>{reads.push({url,signal});return{data:candidates}}}});
  const Component=h.load("./VideoDescriptionPicker").VideoDescriptionPicker;
  const props={pointId,sourceId,value:null,revision:null,disabled:false,onChange:(...values)=>picked.push(values)};
  h.render("picker",Component,props);await tick();let tree=h.render("picker",Component,props);
  const select=field(tree,"同地点正式视频");assert.equal(select.props.value,"");assert.equal(picked.length,0);
  assert.equal(find(tree,(node)=>node.type==="option").length,2);
  select.props.onChange({target:{value:`${targetId}:3`}});assert.deepEqual(picked,[[targetId,3]]);
  select.props.onChange({target:{value:"other:3"}});assert.equal(picked.length,1);
  props.value=targetId;props.revision=2;tree=h.render("picker",Component,props);assert.match(text(tree),/当前关联版本暂不可用/);
  h.dispose();
});

test("video reviewer confirmation binds the current draft and is cleared by a new draft revision",async()=>{
  const calls=[];let row={id:sourceId,revision:4,published_revision:1,state:"in_review",status:"published",operation:"upsert",content,media_url:source.media_url,contributor_ids:["editor"],submitted_by:"editor"};
  const h=controlledAdmin({
    "../../shared/api/client":{get:async()=>({data:[]})},"../../shared/catalogSync":{notifyCatalogPublished(){}},
    "../experiences/types":{experienceNames:{media:"图片与视频",checkin:"打卡点",tour:"校园导览路线"}},"../experiences/progress":progress,"../experiences/segments":segments,
    "../visit/audioOwner":{acquireAudio:()=>1,releaseAudio(){}},"../visit/TourNarrator":{TourNarrator:()=>null},
    "./ExperienceEditor":{ExperienceEditor:()=>null,ExperienceTourPreview:()=>null},"./NarrationStudio":{NarrationStudio:()=>null},"./ExperienceHistory":{ExperienceHistory:()=>null},
    "./ui":{Empty:()=>null,ErrorBox:()=>null,useResource:()=>({data:{data:[]},error:""})},
    "./api":{message:(error)=>error.message,stateNames:{in_review:"待审"},request:async(url,method="GET",body)=>{calls.push({url,method,body});if(method==="POST")row={...row,revision:5,published_revision:2,state:"published"};return{data:url.startsWith("/points?")?[]:row,meta:{}}}}
  });
  const Component=h.load("./ExperienceWorkspace").ExperienceWorkspace;
  const props={session:{user:{id:"reviewer",role:"reviewer",campus_ids:[]},permissions:["points.read","points.review"]},initialId:sourceId,focused:true,review:true,onDirty(){}};
  const render=()=>h.render("review",Component,props);render();await tick();let tree=render();
  field(tree,"本次操作说明").props.onChange({target:{value:"已核对本版本"}});tree=render();
  assert.equal(button(tree,"审核通过并发布").props.disabled,true);
  button(tree,"审核通过并发布").props.onClick();await tick();tree=render();assert.equal(calls.filter((c)=>c.method==="POST").length,0);
  const confirmation=find(tree,(node)=>node.type==="input"&&node.props.type==="checkbox")[0];confirmation.props.onChange({target:{checked:true}});tree=render();
  assert.equal(button(tree,"审核通过并发布").props.disabled,false);button(tree,"审核通过并发布").props.onClick();await tick();tree=render();
  const write=calls.find((call)=>call.method==="POST");assert.equal(write.body.video_accessibility_confirmed,true);assert.equal(write.body.expected_revision,4);
  assert.equal(find(tree,(node)=>node.type==="input"&&node.props.type==="checkbox")[0].props.checked,false);
  h.dispose();
});
