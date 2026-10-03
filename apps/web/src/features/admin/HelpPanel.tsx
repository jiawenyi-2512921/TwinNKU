import { useState } from "react";
import "./help.css";

export type HelpPage =
  | "backups"
  | "overview"
  | "points"
  | "resources"
  | "experiences"
  | "tours"
  | "configurations"
  | "guide-settings"
  | "imports"
  | "review"
  | "roads"
  | "audit"
  | "accounts"
  | "security";

export const helpPageNames: Record<HelpPage, string> = {
  backups: "备份与恢复记录",
  overview: "工作台",
  points: "地图点位",
  resources: "资料中心",
  experiences: "视频与打卡",
  tours: "校园导览路线",
  configurations: "首页与参观编排",
  "guide-settings": "服务与费用设置",
  imports: "表格导入",
  review: "审核中心",
  roads: "道路与导航",
  audit: "操作记录",
  accounts: "账号权限",
  security: "账号安全",
};

const pagePermissions: Partial<Record<HelpPage, string[]>> = {
  backups: ["backup.read", "backup.request", "users.manage"],
  points: ["points.read"],
  resources: ["points.read"],
  experiences: ["points.read"],
  tours: ["points.read"],
  imports: ["points.edit"],
  roads: ["points.read"],
  configurations: ["configurations.edit", "configurations.review"],
  "guide-settings": ["runtime.edit", "runtime.review"],
  review: ["points.review", "configurations.review", "runtime.review"],
  audit: ["audit.read"],
  accounts: ["users.manage"],
};

export function canOpenHelpPage(page: HelpPage, permissions: string[]) {
  const required = pagePermissions[page];
  return (
    !required || required.some((permission) => permissions.includes(permission))
  );
}

type HelpTask = {
  id: string;
  title: string;
  keywords: string[];
  pages: HelpPage[];
  target?: HelpPage;
  permission: string;
  before: string;
  steps: string[];
  done: string;
  recovery: string[];
  device: string;
};

const guideVersion = "2026-10-03 · 数字文化展馆编辑流程";

export const helpTasks: HelpTask[] = [
  {
    id: "home",
    title: "我要改首页",
    keywords: ["主页", "主视觉", "推荐路线", "模块", "网站名称", "编排"],
    pages: ["configurations", "overview"],
    target: "configurations",
    permission: "页面编排编辑权限；发布需要另一位拥有对应范围审核权限的成员。",
    before: "先决定修改全站还是某个校区。素材和推荐路线必须已经正式发布。",
    steps: [
      "打开页面编排，选择展示配置和作用范围。继承表示继续使用上层正式设置；需要覆盖时再填写。",
      "通过名称与缩略图选主视觉和路线。用上移、下移调整模块顺序；填写按钮文字、图片说明和公告时间（北京时间）。",
      "停下输入约三秒，确认草稿保存状态；保存只是私有草稿。",
      "打开私有预览，分别检查电脑宽度和手机宽度。未保存预览与已保存预览均不会发布。",
      "运行检查，处理失效素材和版本问题，提交审核。另一位成员从统一审核中心核对后发布。",
    ],
    done: "编辑者看到待审核；独立成员发布后，再打开公开导览确认对应校区的正式效果。",
    recovery: [
      "看不到菜单：请管理员授予对应配置范围权限，管理员角色本身不代替配置授权。",
      "恢复旧配置会创建新草稿；历史预览使用该历史配置叠加当前正式继承层，不能当作整个旧网站回放。",
    ],
    device:
      "电脑适合模块编排；手机可查看预览与审核。宽度预览不能代替真实手机走查。",
  },
  {
    id: "vr",
    title: "我要添加 VR",
    keywords: ["全景", "室外", "景点", "建筑", "原站", "网址"],
    pages: ["resources", "points"],
    target: "resources",
    permission: "地点编辑权限及该地点范围；发布需要独立地点审核成员。",
    before:
      "准备真实景点或室外地点、原始 HTTPS 场景网址与来源。没有建筑时不要虚构建筑归属。",
    steps: [
      "在点位管理找到真实地点；室外独立景点可按真实情况使用公共区域或景观类别，关闭常驻地图名称。",
      "到资料中心选择该地点并建立全景草稿，保留原始名称、场景网址和来源说明。",
      "保存后打开原站核对具体场景与位置。原站在新标签页打开，本站不能控制原站视角或语音。",
      "运行检查，提交审核；让未参与编辑的成员核对地点、网址、场景及重复视点。",
      "发布后在公开 VR 全景目录搜索、定位并打开，现场位置另行核验。",
    ],
    done: "已发布且公开链路有效的场景可在 VR 目录找到；原站画面和现场归属有人工核验记录。",
    recovery: [
      "原站打不开：保留准确网址和错误信息，稍后在原站复测；不要将链接入口存在当作场景已验证。",
      "不能选为路线素材：先核对同地点、公开状态和正式版本；不要自动更新路线里的旧引用。",
    ],
    device: "手机可核对与审核；精确地图锚点请用电脑，校园位置请现场确认。",
  },
  {
    id: "tour",
    title: "我要做路线",
    keywords: [
      "校园导览",
      "六步",
      "段落",
      "素材",
      "讲稿",
      "站点",
      "观察",
      "收获",
    ],
    pages: ["tours", "experiences"],
    target: "tours",
    permission: "地点编辑权限，并拥有整条路线所涉及地点的范围。",
    before:
      "使用团队确认的真实地点、来源和已发布素材；不要把导航草图当成实测通行路线。",
    steps: [
      "按六步编辑：基本信息、真实地点、段落编排、讲解音频、效果检查、提交审核。可在同一份草稿中跳转步骤。",
      "选择校区与真实站点，明确排序、导语、封面、收获和图文或正式录音模式。",
      "每段填写讲稿与来源、观察提示和回顾。明确选择主画面以及同地点、带正式版本的地图、楼层、图片、视频或 VR。",
      "需要正式录音时明确创建任务，完成全部分块试听后采用。复制站段会生成新的段落身份，需重新核对声音。",
      "使用共用公众组件的私有预览，检查段落顺序、地图、楼层、媒体返回和实际音频。运行检查并处理具体站段的问题。",
      "确认已保存，再提交审核；独立成员从审核中心发布。",
    ],
    done: "正式快照包含正确地点、素材版本和已采用讲解；公开走查完成后才能认定路线体验可用。",
    recovery: [
      "素材失效或声音不匹配：在报告指向的具体站、段重新选择或生成，检查后再提审。",
      "旧路线转换为段落是明确操作，会保留旧讲稿和兼容资料；先私有预览，不批量改写旧路线。",
    ],
    device:
      "电脑适合站段编排；手机可改文字和审核。到校导航使用人工选择位置，没有 GPS 自动到达。",
  },
  {
    id: "audio",
    title: "我要生成、试听和采用讲解",
    keywords: [
      "声音",
      "录音",
      "音频",
      "收费",
      "额度",
      "供应商",
      "回收",
      "重试",
    ],
    pages: ["tours"],
    target: "tours",
    permission: "路线编辑范围；正式生成与重试还需近期通行密钥验证。",
    before:
      "先保存当前讲稿。生成开关、部署允许和预算均须有效；试听已有音频不创建新任务。",
    steps: [
      "在讲解音频步骤查看标准方案、可用状态和额度，明确选段。",
      "确认本次会调用供应商，再创建任务；任务持续保留，切换页面不会把任务当成失败。",
      "生成完成后逐块试听到结束，核对读音、内容和来源，再明确采用。采用后继续保存路线草稿。",
      "文字或段落身份变化会使原声音失配，重新检查；公开播放仅使用独立审核后的不可变音频。",
    ],
    done: "每个需要录音的段落有同内容身份的已采用音频，完整试听与路线检查均通过。",
    recovery: [
      "请求超时或结果未知：查询本次生成结果，不再点击生成或重试；浏览器取消不保证供应商已经停止计费。",
      "提示未采用音频已回收：旧任务保留为回执，不能重试旧资产；确认额度后创建新任务。",
      "播放失败：使用明确的继续播放按钮；纯图文路线可以明确选择图文模式，不伪装成正式录音。",
    ],
    device: "电脑、手机都要实际听；自动测试与宽度预览不证明设备有声音。",
  },
  {
    id: "import",
    title: "我要导入 Excel 或 CSV",
    keywords: [
      "表格",
      "xlsx",
      "模板",
      "批量",
      "关联",
      "名称",
      "重名",
      "列匹配",
      "导出",
    ],
    pages: ["imports", "points", "resources", "tours", "experiences"],
    target: "imports",
    permission: "地点编辑权限，且每一项生成或更新的内容都在本人范围内。",
    before:
      "下载对应模板，或先按授权范围导出已有资料。单个文件不超过 10 MB、500 行；XLSX 只接受单工作表、无公式和宏等内容。",
    steps: [
      "选择点位、VR、路线或媒体类型，下载模板或查看范围导出的数量、警告，再下载当前版本表格。保留高级保留列，不按重名覆盖。",
      "上传后匹配资料列。找不到关联时通过名称、缩略图和地点选择具体对象与版本，不需要填写数据库 ID。",
      "查看整批新增、更新、跳过和错误；处理全部错误。路线更新会替换整条站段，先认真核对差异。",
      "明确确认生成草稿。整批只生成私有内容，不会自动提审或发布。",
      "从结果打开每项私有草稿，核对真实地点、来源、素材与字幕，私有预览后提审。由另一位成员审核上线。",
    ],
    done: "结果记录整批草稿及实际更新项；每项已校对并进入正常独立审核，不以上传成功代替上线。",
    recovery: [
      "不允许导出或高级数据不能表示：按提示保留原资料，使用名称关联选择或逐项编辑，不能删除保留列强行通过。",
      "确认响应丢失：查询原导入操作结果，核对本次操作；若提示其他窗口已提交，只读取结果，不重复确认。",
      "版本变化：重新读取本任务版本，核对最新整批报告后再决定。",
    ],
    device: "大批量表格与列匹配建议电脑；手机适合查看结果和审核。",
  },
  {
    id: "media",
    title: "我要补视频字幕和替代说明",
    keywords: [
      "vtt",
      "中文字幕",
      "文字稿",
      "图片说明",
      "可访问",
      "无障碍",
      "楼层",
      "分区",
    ],
    pages: ["experiences", "resources"],
    target: "experiences",
    permission: "该地点编辑权限；上传者也属于贡献者，不能审核自己的资料。",
    before:
      "准备真实视频和文字稿、图片替代说明、楼层总体及分区说明；字幕为不超过 1 MiB 的有效 VTT 文件。",
    steps: [
      "在地点体验编辑视频，上传本站受控 VTT 文件，填写语言与字幕标签并明确采用；不粘贴任意字幕网址。",
      "填写视频文字稿、图片替代说明。更换视频来源或地点时重新提供对应字幕，旧引用会清除。",
      "在资料中心填写楼层总体与各分区的文字说明；说明图示内容，不把图纸描述成现场已核验的无障碍通路。",
      "私有预览检查字幕、文字和楼层分区，再保存、检查、提审，由独立成员发布。",
    ],
    done: "视频、字幕和文字稿对应同一实际资料；图片与楼层有可理解的文字说明且已审核。",
    recovery: [
      "字幕拒收：检查文件类型、大小和时间范围，不改成外部网址。",
      "第三方 VR 的字幕或界面不由本站控制，应提供本站场景说明及原站入口。",
    ],
    device: "手机可修改文字和审核；字幕文件准备、楼层图精细标注建议电脑。",
  },
  {
    id: "rejected",
    title: "内容被退回，怎么修改",
    keywords: ["驳回", "需要修改", "审核意见", "重新提交"],
    pages: [
      "review",
      "points",
      "resources",
      "experiences",
      "tours",
      "configurations",
      "roads",
    ],
    permission: "对应对象的编辑权限；审核权限与编辑权限分开。",
    before: "先读取当前对象和审核意见，确认是哪个版本被退回。",
    steps: [
      "在工作台需要修改或审核中心找到内容，阅读退回说明。",
      "在对应编辑器重新读取当前版本，修改指出的地点、来源、素材或配置，不覆盖其他成员的新内容。",
      "确认草稿保存，重新私有预览与检查，再提交当前新版本。",
    ],
    done: "新版本处于待审核，退回问题有具体修正；旧审批不会自动转移到新稿。",
    recovery: [
      "看到版本冲突：先比较本页与服务器，不重复提交旧版本。",
      "不能编辑：请有对应范围编辑权限的成员处理，审核者不自动拥有编辑能力。",
    ],
    device: "手机可处理文字与审核意见；地图和站段编排建议电脑。",
  },
  {
    id: "unknown",
    title: "保存超时或结果未知，怎么处理",
    keywords: [
      "网络",
      "断网",
      "查询",
      "不确定",
      "一直保存",
      "重复收费",
      "卡住",
    ],
    pages: [
      "points",
      "resources",
      "experiences",
      "tours",
      "configurations",
      "guide-settings",
      "imports",
      "roads",
      "review",
    ],
    permission: "保持当前账号与原操作范围；查询结果不会重新提交该操作。",
    before:
      "保留本页输入，不刷新、关闭或重复点击写入按钮。响应丢失不代表服务器没有完成。",
    steps: [
      "查看当前保存或操作状态，使用本页查询这次保存结果或对应的原操作查询按钮。",
      "系统只查询原来的操作身份；确认成功后采用服务端版本，再继续编辑。",
      "仍未确认时保持本页，恢复网络后再查询。导入提交、生成音频与服务暂停各有自己的原操作结果，不能用新操作代替。",
    ],
    done: "原操作明确成功或明确未通过，状态不再未知；成功结果与本人原操作、对象和版本一致。",
    recovery: [
      "查不到结果仍是未知：保持输入并联系管理员，提供页面显示的操作编号；不要分享密码、供应商密钥或恢复码。",
      "账号过期：同一账号重新登录后继续处理本页；权限撤回时不能靠重新登录越过范围。",
    ],
    device: "电脑与手机都可以查询；此帮助不会关闭正在编辑的页面。",
  },
  {
    id: "conflict",
    title: "多人编辑遇到版本冲突",
    keywords: ["覆盖", "比较", "409", "合并", "草稿", "自动保存"],
    pages: [
      "points",
      "resources",
      "experiences",
      "tours",
      "configurations",
      "roads",
    ],
    permission: "当前对象编辑权限。",
    before: "冲突不会静默覆盖服务器；本页输入保留。",
    steps: [
      "打开版本比较，核对打开时的内容、本页输入和服务器最新内容。",
      "逐项确认要保留的变化；明确选择保留本页输入，按最新版本确认保存，或采用服务器版本。",
      "再次检查保存状态和私有预览。版本变化后重新运行检查，再提审。",
    ],
    done: "本页与服务器版本一致，输入保留或放弃均经过本人明确选择。",
    recovery: [
      "最新版本读取失败：先恢复网络，再读取服务器版本；不能把失败当成空白稿。",
      "同一地点出现在多个站：核对具体站序与段落，不能仅按地点名称处理。",
    ],
    device: "手机可比较文字；复杂站段和地图差异建议电脑。",
  },
  {
    id: "history",
    title: "如何找回历史版本",
    keywords: ["找回版本", "恢复", "撤销", "还原", "快照", "误改", "版本记录"],
    pages: [
      "points",
      "resources",
      "experiences",
      "tours",
      "configurations",
      "roads",
    ],
    permission: "读取历史需当前对象可读；恢复为草稿需对应编辑权限。",
    before:
      "先保存当前输入，并核对当前草稿与正式版本。历史不是绕过审核的发布入口。",
    steps: [
      "打开版本记录，按时间、操作和内容摘要选历史版本。页面配置可使用同组件历史私有预览。",
      "明确恢复为新草稿。当前已发布内容保持不变，恢复不会恢复旧批准、费用开关或已暂停服务。",
      "检查当前素材引用、段落声音和作用范围，私有预览后重新提审，由独立成员审核。",
    ],
    done: "有新草稿版本与恢复记录，重新检查和独立审批后才改变公开结果。",
    recovery: [
      "旧素材已下架：私有草稿可以保留以便修复，但必须替换引用才能提审发布。",
      "要恢复整站或数据库：联系负责备份的运维成员，本页历史恢复只针对这项内容。",
    ],
    device: "手机可查看和恢复文字稿；恢复前后都建议核对电脑及手机预览。",
  },
  {
    id: "review",
    title: "我要审核和发布内容",
    keywords: ["提审", "独立审核", "通过", "发布", "贡献者", "自己", "MFA"],
    pages: ["review", "overview"],
    target: "review",
    permission:
      "对应范围的地点、配置或运行策略审核权限；发布及敏感操作遵守服务端近期 MFA 要求。",
    before:
      "审核者不能参与这一版的编辑、素材上传或音频采用；编辑、审核和作用范围都由服务端核验。",
    steps: [
      "打开统一审核中心，选择当前待审对象，核对真实来源、当前版本与修改差异。",
      "查看可用私有预览、检查报告和素材依赖；配置、地图、楼层、VR、视频、路线与路网都按对应类型复核。",
      "需要修改时写清退回意见；符合要求时完成近期通行密钥验证，明确审核发布当前版本。",
      "打开公开导览核对；真实 VR 画面、手机声音和现场通行需实际验证。",
    ],
    done: "当前版本明确已发布或已退回，独立审批记录可查询；只有已发布有效快照进入公开端。",
    recovery: [
      "按钮禁用且提示参与编辑：交给另一位成员，不换账号伪装本人贡献。",
      "版本已变化：重新读取最新待审版本，再核对报告与差异；旧检查不能直接批准新版本。",
    ],
    device: "手机支持审核；地图精细差异、素材与实际音频应在适合的设备复核。",
  },
  {
    id: "runtime",
    title: "服务故障时暂停与恢复",
    keywords: [
      "运行",
      "助手",
      "问答",
      "语音",
      "预算",
      "容量",
      "额度",
      "网络不通",
    ],
    pages: ["guide-settings"],
    target: "guide-settings",
    permission: "运行策略编辑可紧急暂停；恢复需独立运行策略审核及近期 MFA。",
    before:
      "查看正式批准策略、实际开关、部署允许、暂停原因、预算和音频容量；连接未验证不能当作供应商可用。",
    steps: [
      "出现问题时选择对应服务并填写原因，明确紧急暂停；暂停不会发布正在编辑的策略草稿。",
      "原操作结果未知时仅查询原结果，保持本页，不重复发送暂停或恢复。",
      "定位网络、配置、额度或容量原因并验证后，再申请恢复。恢复经独立审核，不自动解除其他部署限制。",
    ],
    done: "实际服务状态与审批、部署和暂停层一致；恢复有独立批准与真实连通证据。",
    recovery: [
      "音频空间超过八成：核对容量和未采用保留时间；满额或无法核验时不能靠重复生成解决。",
      "部署不允许：请运维处理批准的部署开关，后台配置不能强行越过。",
    ],
    device: "手机支持查看、暂停及审核；供应商与服务器故障交给对应运维成员。",
  },
  {
    id: "security",
    title: "新成员账号安全与交接",
    keywords: [
      "登录",
      "密码",
      "认证器",
      "通行密钥",
      "恢复码",
      "会话",
      "设备",
      "权限",
    ],
    pages: ["security", "accounts"],
    target: "security",
    permission:
      "本人可维护自己的认证器及会话；管理他人权限需账号管理及近期 MFA。",
    before: "使用自己的成员账号，不共享账号、密码、认证器或恢复码。",
    steps: [
      "首次登录更换个人长密码。在账号安全页本人分别绑定并验证主、备用认证器。",
      "本人安全保存恢复码，并按团队流程验证恢复；不能由开发者代替生物识别或保管恢复码。",
      "查看本人有效会话；撤销丢失设备的会话需近期通行密钥验证，保留当前设备。",
      "管理员按实际职责授予校区、地点与独立配置编辑／审核权限；交接前在团队提供的真实独立练习环境完成任务，并确认顶部练习标识。",
    ],
    done: "成员能独立登录、验证备用认证器和受限恢复；可见菜单与职责范围相符。",
    recovery: [
      "敏感操作要求验证：完成通行密钥验证后，回原页面重新明确执行；验证不会自动重复之前的操作。",
      "所有认证器丢失：走受限恢复与重新绑定流程，不要求别人关闭身份保护。",
    ],
    device: "必须在本人实际设备操作；界面说明或自动测试不能代替认证器验收。",
  },
];

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

export function searchHelpTasks(query: string, page: HelpPage) {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  return helpTasks
    .filter((task) => {
      const haystack = normalize(
        [
          task.title,
          ...task.keywords,
          task.permission,
          task.before,
          ...task.steps,
          task.done,
          ...task.recovery,
          task.device,
        ].join(" "),
      );
      return tokens.every((token) => haystack.includes(token));
    })
    .sort(
      (a, b) => Number(b.pages.includes(page)) - Number(a.pages.includes(page)),
    );
}

export function HelpPanel({
  page,
  permissions,
  onClose,
  onNavigate,
}: {
  page: HelpPage;
  permissions: string[];
  onClose: () => void;
  onNavigate: (page: HelpPage) => boolean;
}) {
  const [query, setQuery] = useState(""),
    [notice, setNotice] = useState("");
  const tasks = searchHelpTasks(query, page);
  return (
    <aside
      id="admin-task-help"
      className="ad-help-panel"
      aria-labelledby="admin-help-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <h2 id="admin-help-title">任务帮助</h2>
          <p>当前页面：{helpPageNames[page]}</p>
        </div>
        <button type="button" onClick={onClose}>
          关闭帮助
        </button>
      </header>
      <label className="ad-help-search">
        搜索要完成的任务
        <input
          type="search"
          autoFocus
          maxLength={120}
          value={query}
          placeholder="例如：导入、保存超时、找回版本"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="ad-help-context">
        帮助不会替你保存、生成音频或发布，也不会关闭当前编辑器。先看与当前页面相关的任务。
      </p>
      <p className="ad-help-version">适用版本：{guideVersion}</p>
      {notice && (
        <p role="status" className="ad-help-notice">
          {notice}
        </p>
      )}
      <p role="status">找到 {tasks.length} 项任务</p>
      {!tasks.length && <p>没有匹配任务。试试“导入”“版本”“审核”或“超时”。</p>}
      <div className="ad-help-tasks">
        {tasks.map((task) => (
          <details key={task.id}>
            <summary>
              {task.title}
              {task.pages.includes(page) && <span>与本页相关</span>}
            </summary>
            <p className="ad-help-pages">
              适用页面：
              {task.pages.map((item) => helpPageNames[item]).join("、")}
            </p>
            <h3>前置权限与准备</h3>
            <p>{task.permission}</p>
            <p>{task.before}</p>
            <h3>操作步骤</h3>
            <ol>
              {task.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <h3>完成标志</h3>
            <p>{task.done}</p>
            <h3>常见问题与恢复</h3>
            <ul>
              {task.recovery.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="ad-help-device">设备建议：{task.device}</p>
            {task.target && (
              <>
                <button
                  type="button"
                  disabled={!canOpenHelpPage(task.target, permissions)}
                  onClick={() => {
                    if (task.target === page) {
                      onClose();
                      return;
                    }
                    if (
                      !task.target ||
                      !canOpenHelpPage(task.target, permissions)
                    )
                      return;
                    if (onNavigate(task.target)) onClose();
                    else
                      setNotice(
                        "当前操作或未保存输入仍需处理。帮助保持打开，请先回本页确认状态。",
                      );
                  }}
                >
                  {task.target === page
                    ? "返回当前编辑器"
                    : `打开${helpPageNames[task.target]}`}
                </button>
                {!canOpenHelpPage(task.target, permissions) && (
                  <p>当前账号没有此页面权限；请有对应权限的成员处理。</p>
                )}
              </>
            )}
          </details>
        ))}
      </div>
    </aside>
  );
}
