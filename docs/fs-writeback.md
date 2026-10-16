# FS 落盘分层方案(已实施)

> 状态:**已实施**(2026-10)。本文档面向执行 agent,锚点以符号名 + 近似行号给出
> (行号会漂移,以符号为准)。改动核心:**js/core/fs.js**,辅以
> **js/system/desktop.js**(batch 广播适配);应用层 audit 已全部核实零改动(§3)。
> 全程不涉及 vendor/AetherWebDatabase;fs.v2.json 仅在根上**新增可选
> `savedAt` / `clockDelta` 字段**(§2.6,parseTree 不校验、旧树零迁移),
> 无其他格式变更。
> rev2(代码审查修订):变更点计数勘误(15 emit + 1 裸 persist);batch 事件
> 与桌面前缀过滤的兼容改法;cowGuard 遮蔽升结构趟;T-新3/4 补判别时序并
> 新增 T-新5;§2.6 从「显示优化」升格为正确性前提并修正实现方式;§3 audit
> 落定;「T38(appdata 冻结位)」误标勘误。
> rev3:mtime 修复改 **savedAt 哨兵**——`file.lastModified` 是宿主的物理
> 落盘时刻,不是 VFS 逻辑 mtime(快照恢复/整树导入保留旧 m 却重写字节,
> 裸 max 会打爆历史时间戳),只有「字节比树新」才允许修。
> rev4:mtime 修复补 **clockDelta 换算**——两系统时钟差值 δ(VFS − 宿主)
> 记在根上、随每次 writeTree 用 fs.v2.json 自身回读刷新;判定与修复统一
> 在 VFS 域(`t_vfs = lastModified + δ`),同机 δ≈0,虚拟时钟/时钟跳变
> 由最近样本吸收。
> rev5(实施记录):已按 §4 全部落地,e2e 用例 §5 落地为 `tools/e2e-groups/files.mjs`
> 的 T63 组(T63.1..T63.6)。与设计稿的三处实现偏差,均经用例验证:
> ① **savedAt 取时点前移**:不是「写完树 JSON 后」再记,而是「本趟内容
> 字节全部写完之后、序列化之前」记并随本趟 JSON 落盘——若写在 JSON 之后,
> 盘上哨兵滞后一趟,上一趟的正常内容写入在下次启动会被判成「字节比树新」
> 而打爆 mtime(反向哨兵用例 T63.3 正是抓这个;「恢复/导入字节在树之前
> =天然豁免」的原文意图不变);② mkdir 末尾兜底只在**确有新建**时调度
> (对已存在目录的 silent mkdir 不触发结构趟,纯 meta 随机写不放大);
> ③ batch 末强制趟**有脏才写**(空批零写放大),且 batch resolve 会
> await 该趟(落定语义强于设计稿)。抑制广播的机制:bus.js 新增
> muteTopic/unmuteTopic 频道静默(collector 吸收载荷路径)。

## 0. 背景与三个问题

现状:所有元数据树落盘共用一个 250ms 防抖(`persist`,`fs.js:572`),
变更点共 **16 处 = 15 个 `emit()` 调用点 + 1 处不经 emit 的裸 `persist()`**
(`fs.js:1194`,mkdir 末尾,writeAt/write 自动补父目录的 silent 路径)。
`emit`(`fs.js:743`)同时做两件事:`persist()` + 逐次 `publish('sys:fs-changed')`。
数据库页经 `writeAt` 直写 OPFS,不防抖。

| # | 问题 | 实测依据 |
|---|---|---|
| 1 | **腐坏窗口**:数据页已直写,「文件存在」(树条目)却在防抖窗口里。刷新/强杀后盘上有字节、树上无文件,重启在隐形文件上重建 → 「目录链损坏(密码错误或数据库已损坏)」 | 便签应用调试期间实际踩中 |
| 2 | **写放大**:`writeAt` 每次更新 mtime(`fs.js:1100-1104`),每个数据页写入都弄脏整棵树 | 保存一条任务 = 6 个 fs 变更事件;打字 8 段停顿 = 45 个 |
| 3 | **突发事务 + 广播风暴**:播种/装包循环写,每操作一趟潜在落盘 + 一次 `sys:fs-changed` 广播。消费方全量盘点(勿再漏):桌面订阅带**桌面前缀过滤**(`desktop.js:347-350`,仅桌面路径触发重渲染);**无过滤、每事件整列表重渲染**的是每个打开的文件管家窗口(`files/index.js:352`)、回收站应用(`trash/index.js:122`)、监视器存储页(`monitor/index.js:180`) | 开机登录播种 6 秒 17 个事件 |

关键安全前提(已核实):`readAt` **不按 inode.s 截断**(`fs.js:1053`,
bin 文件直接按偏移切 OPFS 原始字节)——磁盘树上陈旧的 size 不会让任何读
路径看不到新页。这是 m/s 可以懒写的根据(读侧)。**写侧另有消费点**:
AetherWebDatabase 开库以 `fs.fileSize()` 计算页数
(vendor/AetherWebDatabase/src/storage.js:137-145,`pageCount = ceil(fileSize/PAGE)`),
而 `fileSize` 优先 inode.s(`fs.js:1113`)——懒写 s 的安全前提必须加上
§2.6 启动校准,二者配套才闭合(会话内 s 由 writeAt 同步刷新,无恙)。

另一关键事实:已发给浏览器的写最终进入内核页缓存,页缓存属于内核,
**进程死亡不影响其落盘**(只有 OS 崩溃/断电丢,不追求)。`opfsWriteAt`
在 finally 中 `close()`(`opfs.js:125-127`),FileSystemWritableFileStream
的 close() 按规范冲刷,Chrome 桌面 OPFS 后端为真实文件——「即时发出」
对进程杀的安全性有规范与实现双重支撑。防抖的价值只剩省事务数——应按此
重新分配。

## 1. 设计总则:按变更类型分层定价

| 变更类型 | 定价 | 落盘时机 |
|---|---|---|
| 数据库页 / 随机写内容(`writeAt` 字节) | 即时 | 不变(已直写) |
| **结构变更**:新建节点 / 删除 / 改名 / 权限 / 内存驻留文本内容(`fs.write` 的 `d`) | **微防抖 30ms** | 进程死亡前必然已发出;突发自动合并 |
| **mtime / size**(仅元数据变化,不伴随结构) | **懒写**:不设短计时 | 搭结构趟便车(全量写树天然带下)+ pagehide + `fs.flush()` + 30s 兜底长计时 |
| 应用按键级输入 | 应用层 ≥200ms 防抖 | 应用自责,fs 不做唯一合并层(§3 已核:现状全部达标) |

要点:`writeTree` 仍写**整棵内存树**,任何一趟结构写都天然把最新 m/s
带下去——懒档不需要独立写路径,只是一个「不再主动调度」的标志。
懒档的陈旧**只存在于盘上树 JSON**:会话内所有读取(stat/list 的 mtime
与 size、`fileSize`、DB 的 pageCount)都走内存态,而 writeAt 同步更新
内存 n.m/n.s(fs.js:1102-1103)——打字期间一切显示即时新鲜;30s 计时
与 §2.6 启动校准只服务 crash 后的盘上状态。

## 2. fs.js 机制改造

### 2.1 emit 拆分与调度收口

```
emit(action, path, kind)   // kind: 'struct' | 'meta',缺省 'struct'
  kind=struct → scheduleStruct() + publish
  kind=meta   → metaDirty = true + 合并式 publish(见 §2.2)
```

16 处变更点分类:

- `mkdir` / `rm` / `rename` / `move` / `chmod` / 文本 `fs.write`(内容驻留
  内存,必须随趟刷 fsdata,归结构档防突发)→ **struct**
- **`writeAt` 对已存在文件**的写入(就地覆盖只动 m,追加只动 m+s)→ **meta**
- **`writeAt` 的新建节点路径**(makeNode 分支,首写自动建文件)→ **struct**。
  ⚠️ 最高危实现点:漏判 = 文件首写走懒档 = 强杀丢文件,退回现状腐坏。
  实现时在该分支显式 `scheduleStruct()`,e2e 见 §5 T-新3(判别版)
- **`fs.js:1194` mkdir 末尾的裸 `persist()`**(silent 补目录路径,不经 emit,
  writeAt/write 的自动建父目录都走它)→ **显式改 `scheduleStruct()`**。
  旧 `persist`/`schedulePersist`(250ms)整体删除,全部调度收口到双档
  定时器——这处不在 emit 调用点清单里,机械改造最容易漏
- 未逐个点名的 emit(chown / 快照 create、restore、remove / import /
  ensure-home / 账号改名搬家)一律缺省 **struct**(快照操作会置 snapsDirty,
  restore 还整树置脏,必须随趟落盘;缺省保守正确)

### 2.2 双档定时器 + meta 广播合并 + 遮蔽升级

- `structTimer = debounce(scheduleStruct, 30)`(范围 20~50ms,定 30)
- `metaDirty` 标志 + `metaTimer` 30s 兜底长计时(**纯卫生参数**):会话内
  读取全走内存,此计时只保证长时间纯 DB 会话里盘上树 JSON 别无限期滞后。
  **writeTree 成功后**清 `metaDirty`(对齐 snapsDirty 的失败保留语义,
  writeTree 的 catch 是提前 return)。crash 后的 s/m 由 §2.6 启动校准
  修复(mtime 修复见该节),故 30s 不承担正确性——嫌长可自由调短,
  代价仅是纯 DB 活动期按该节奏多几趟全树写(写放大回归,不建议低于 10s)
- **meta 档广播合并**:meta 的 publish 经同一 30ms 窗合并,出窗发一条
  (载荷取窗口内最后一次 `{action, path}`)。消费方 files/trash/monitor
  均为全量重渲染、不挑路径;桌面挑前缀,但桌面路径只可能经 struct 档变更
  (桌面文件均由 fs.write/mkdir/rm 产生,`writeAt` 随机写文件只落在
  ~/appdata、/home/shared/appdata 与 /app 包目录)——若未来出现桌面下的
  随机写文件,合并载荷需改带 paths
- **cowGuard 实际遮蔽(翻转了 gen、写了遮蔽字节)→ 就地 `scheduleStruct()`**,
  不论所在操作原本归哪档。注册表必须紧随遮蔽字节落盘:否则强杀后盘上
  fs.snaps.v1.json 仍说 gen=null,快照会读到被覆盖后的**新内容**(静默错
  数据,比丢失更糟)。现状此窗口 ≤250ms(emit→persist 顺带刷 snapsDirty);
  若 writeAt 归 meta 而不升级,窗口拉宽到 30s——必须升。遮蔽是低频事件
  (仅存在快照且首次覆盖时发生),不引入写放大

### 2.3 writeTree 本体不变

仍是全树 `JSON.stringify(stripContents(root))` + 单 JSON 写
(`fs.js:510-536`)+ 增量内容刷(`m >= persistMark`,fs.js:331 簿记,
复用内存 m,与磁盘 m 陈旧无关,不用改)+ `dirtyPaths`/`removedPaths` 清理
+ 快照注册表 + **收尾簿记:成功后在根上记 `savedAt` 并回读本次写出的
fs.v2.json 刷新 `clockDelta`(§2.6,两行事)**。除簿记外本体不变,
**改变的只是谁在什么时候调度它。**

### 2.4 pagehide 与 flush()

- `pagehide`(`fs.js:696`)触发条件从 `pendingPersist || dirtyPaths.size ||
  removedPaths.size` 扩为 **`|| structTimerPending || metaDirty`**;并把
  `writeChain = writeTree()` 改为链式 `writeChain = writeChain.then(writeTree,
  writeTree)`——现状是替换式赋值,unload 期与在途 writeTree 可能并发重叠,
  强制趟变频繁后更易撞上
- `flush()`(`fs.js:1466`)排空两档:取消未决 structTimer 与 meta 广播
  计时器 + 一次 writeTree 全带走(含 metaDirty、snapsDirty)。语义不变

### 2.5 批量操作 API `fs.batch`(播种防抖,采纳)

```
fs.batch(async (fs) => { ...几十个 fs.write/mkdir... })
```

- 批内抑制逐次 publish(sys:fs-changed 频道的**所有** publish,含
  `applink.js:134` 播种函数自发的 seed-shortcuts 广播,吸收进 batch 事件),
  批末发**一条**合并广播 `sys:fs-changed {action:'batch',
  path:<公共祖先,仅展示>, paths:[...]}`
- ⚠️ **消费方适配(必须,否则播种后桌面图标不出现)**:desktop.js:347 的
  订阅带桌面前缀过滤(检查单 `p.path`),而公共祖先(如 `/home/<user>`)
  过不了 `startsWith(desktopDir)` 判定。desktop.js 订阅改为
  `const paths = p?.paths || (p?.path ? [p.path] : []); paths.some(x =>
  String(x).startsWith(dir))`。files/trash/monitor 无过滤,不用动
- 抑制标志 **finally 恢复**(回调抛错不泄漏);嵌套 batch 复用外层;
  异步窗口内被折叠进来的无关事件属可接受(paths 全量携带,消费方均为
  全量或前缀判定)
- 批末强制一次结构趟(确定性单趟,不依赖定时器),同时**取消未决
  structTimer**,不双趟
- 接入调用方:
  - `js/system/boot.js:72-74` 的 `ensureUserHome` + `ensureDesktopShortcuts`
    (reconcileLegacyShortcuts 不直接写 fs,其补播种经广播回到 applink,
    天然落入同一 batch 或随后 30ms 窗);applink 循环体(applink.js:98-137)
  - 装包解包逐文件写入:实际循环在 **pkg.js:151-162**(ensureResources,
    由 install.js 的 installApp 调用)
  - 回收站恢复(trash.js)、zip 解压调用方(files 应用)
- 未包 batch 的裸循环仍有 30ms 微防抖兜底,不强求全覆盖

### 2.6 启动 size / mtime 校准(size 为正确性必需,mtime 须带哨兵)

**定位升格**:不只是「fileSize 显示别太旧」——AetherWebDatabase 开库用
`fs.fileSize()` 算页数(storage.js:137-145),`fileSize` 优先 inode.s
(fs.js:1113)。懒写 + 强杀后树内 s 陈旧,不校准则 DB 重开按旧 s 算页数,
后续写页落在错误偏移。会话内 n.s 由 writeAt 同步刷新,只有 crash+reload
暴露——启动校准是懒写方案成立的写侧前提(与 §0 的 readAt 不截断配套)。

启动 `loadTree` 水合后、`markBooted()` 前,对**所有 bin 随机访问文件**
(`n.bin && n.d == null`)校准 `n.s = 实际字节数`。规则:

- 文本文件不管(内容驻留内存,按内容计算)
- **mtime 修复 = savedAt 哨兵 + clockDelta 换算,不能裸取 max / 裸搬
  lastModified**:`file.lastModified` 是宿主时钟记录的**物理落盘时刻**,
  树里的 m 是 VFS 时钟的逻辑 mtime——**两个系统的时间不保证一致**;且
  快照恢复 / 整树导入(importAll,树可能来自另一台机器的时钟)/ AWDBVFS1
  迁移都是「保留旧 m 却重写字节」,直接搬 lastModified 会把历史时间戳
  冲掉(快照恢复尤其致命:每次恢复后重开都被打爆,破坏「恢复保留原
  mtime」语义)。规则:
  - **换算(δ 的记录点)**:根上记 `clockDelta = VFS 时钟 − 宿主时钟`
    (ms,可选字段,与 savedAt 并列、随树落盘)。每次成功 writeTree
    收尾时用**本次写出的 fs.v2.json 自身回读**刷新:写完立刻
    `getFile().lastModified`,`δ = Date.now() − lastModified`。零额外
    写放大(树 JSON 本来每次都写,回读是一次浅层 getFile);同机上
    两个时钟同源 OS 时钟,δ≈0;时钟跳变 / 将来引入虚拟时钟时由最近
    样本吸收,规则不用改
  - **哨兵**:`writeTree` 成功写完树 JSON 后,在根上记 `savedAt =
    Date.now()`(VFS 域;必须在树 JSON 写完之后取时——恢复/导入/
    copyFrom 的字节都写在树之前,fs.js:515-536 内容先于元数据,天然豁免)
  - **判定与修复都在 VFS 域**:`t_vfs = file.lastModified + clockDelta`;
    仅当 `t_vfs > savedAt`(字节写于最后一次树落盘之后 = 懒写窗口内
    crash)才判 m 陈旧并修 `n.m = t_vfs`;否则树内 m 为权威,不动
  - 旧树无 savedAt → 视为未知,**跳过 m 修复**(保守);无 clockDelta
    → δ = 0(同机缺省无损)。AWDBVFS1 迁移分支重写字节处同步推进内存
    savedAt,防那次启动被一次性误修
  - writeTree 与并发 writeAt 的毫秒级交错最坏漏修一次,显示级,接受
- 只校准、不删孤儿字节
- **缺失判定**:`opfsFileSize` 对缺失文件返回 0 而非 null(opfs.js:140-142),
  区分不了缺失与空文件。按「actual == 0 且 n.s > 0 视为缺失」处理:保留
  原值并 `console.warn`(系统无 truncate 路径,bin 文件不会合法缩到 0);
  actual == 0 且 n.s == 0/null 视为合法空文件
- **实现方式**:携带父目录句柄的单次递归下降——遍历内存树的同时逐级取
  OPFS DirectoryHandle,子目录复用父句柄。**不要逐文件调 `opfsFileSize`**:
  它每次从 OPFS 根重走全路径句柄链(opfs.js:34-42),N 文件 × 深度的句柄
  查找放大才是超预算主因,不是 stat 本身
- 性能守卫:实现后实测启动耗时,若大目录下新增 >100ms,降级范围为
  `~/appdata/*.awdb` + `/home/shared/appdata` + 最近 24h mtime 的 bin 文件
  (代价:其余 bin 文件的 s 保持陈旧,仅显示受影响;DB 消费点已全覆盖)

## 3. 应用层输入防抖(audit 已全部核实:零违规,零改动)

规范:凡按键级触发持久化的应用,必须应用层 ≥200ms 防抖,fs 不得是唯一
合并层。**审查结论:当前所有应用均达标**,实施步骤 4 为记录性验收。

| 应用 | 触发方式 | 现状 |
|---|---|---|
| 便签 todo | input → flushBoard | 200ms 手写防抖(todo/index.js:342、645)✓ |
| 电子表格 sheet | 自动保存 | 1.5s(sheet/index.js:1108)✓ |
| 笔记 memo / 日记 diary / QQ / 线索 clues | 各类变更 → persist | 均 200ms 手写防抖(memo:71 / diary:71 / qq:42 / clues:99)✓ |
| 记事本 notes / mdedit / codeedit | Ctrl+S / 保存按钮(输入仅置 dirty 标记,notes:52) | 离散动作,无需防抖 ✓ |
| mail 草稿 | 「存草稿」按钮(mail/index.js:166) | 离散动作 ✓ |
| sms | 无草稿机制,发送离散 | ✓ |
| terminal | 命令历史仅内存数组(terminal/index.js:22),不逐键落盘;会话恢复走外壳 sessionsave | ✓ |

一致性备注:以上防抖全部手写 `clearTimeout/setTimeout`,未用 utils.js:57
的 `debounce`——功能达标不强求统一(应用层各自持有 timer 引用以便 clear,
不影响本方案)。

## 4. 实施顺序(每步一次提交,均可独立回归)

1. fs.js:emit 拆分 + 裸 persist 收口 + 双档定时器 + writeAt 分类 +
   cowGuard 遮蔽升级 + pagehide/flush 适配
2. fs.js:`fs.batch` + **desktop.js 订阅 paths 兼容** + 接入
   boot/applink/pkg/trash/zip
3. fs.js:启动 size 校准(句柄递归下降版)
4. 应用层输入防抖 audit:已核实零改动,以 §3 表为证随文档提交
5. e2e 新用例(§5)+ 全量回归
6. `docs/architecture.md` 存储模型节 + README 文档索引同步

## 5. 新增测试

- **T-新1 播种批量**:植入探针计数 `writeTree` 调用与 `sys:fs-changed`
  广播;登录播种 **await batch 完成并等强制趟落定后**断言 writeTree ≤ 2、
  广播 = 1(batch 合并生效)
- **T-新2 size/mtime 校准**:`writeAt` 追加使文件超出树内 s → 手工把树
  JSON 以**旧 s / 旧 m / 旧 savedAt** 写回(模拟懒写未刷)→ reload →
  `fs.fileSize()` = 实际值、`stat().mtime ≥ 实际写入时刻`,且 `readAt`
  全程可读(校准前后)。反向哨兵回归:对某文件快照 → 改动 → 恢复 →
  reload → 该文件 mtime 仍为快照时刻(防 naive max / 哨兵误修)
- **T-新3 结构档判别(强杀近似)**:新建文件(首写 writeAt / fs.write)后
  **不调 flush**,sleep 100ms(越过 30ms 结构窗)→ reload → 文件存在且
  可读。⚠️ 不能写成「新建后立即 flush」——flush 按 §2.4 同时排空两档,
  误归 meta 也会通过,测试失去判别力。本用例防 writeAt 新建节点误归懒档
- **T-新4 懒档行为**:对已存在文件连续 10 次就地覆盖 `writeAt` →
  **sleep 100ms 后**断言 writeTree 计数 = 0、`sys:fs-changed` 合并为
  1 条(不等待直接计数则 30ms 计时器未响,断言恒真;全程 <30s 防
  metaTimer 串场);`fs.flush()` 后树内 m/s 为最新
- **T-新5 快照遮蔽注册表及时落盘**:对某文件 `snap create` → `writeAt`
  就地覆盖 → sleep 100ms(**不 flush**)→ reload → 读快照内容 =
  覆盖前的旧内容。防 cowGuard 遮蔽后注册表滞后(§2.2 升级规则的回归;
  现状 250ms 防抖下本用例在 100ms 处应失败,改造后通过——有判别力)
- 既有全量 e2e(61 组)必须全绿;重点回归面:T22(多窗口/平铺)、
  T53(快照 COW)、T60(回收站/文件剪贴板)、**T12(music.awdb 上次曲目)/
  T26(邮件库)/ T27(便签逐板落盘)/ T43(日记加密库)**——appdata 库
  读写是 meta 档主力消费方。(旧稿「T38(appdata 冻结位)」为误标,
  T38 实为账号系统。)

## 6. 验收标准

- 全量 e2e 绿、构建与 manifest 闸门绿
- 探针:登录播种 writeTree ≤ 2 趟、桌面重渲染 1 次
- 便签连续打字(纯就地覆盖页)期间 writeTree 趟数 = 0、广播合并后每
  30ms 窗 ≤ 1 条,无逐键全树序列化
- 手工:播种/新建库后立即刷新 ×20 无「目录链损坏」;todo/mail/sms 库正常打开
- 手工:建快照 → 改文件 → 刷新,快照内容仍为建快照时内容(T-新5 的人肉版)

## 7. 风险与守卫

| 风险 | 守卫 |
|---|---|
| emit + 裸 persist 共 16 处机械改造引入回归 | 全量 e2e;emit 缺省 struct(漏标 kind 只会偏保守);裸 persist(fs.js:1194)显式列入收口清单,不留旧 250ms 路径 |
| writeAt 新建节点误判(最高危) | makeNode 分支显式 scheduleStruct + T-新3(判别版) |
| 双档与快照 COW 交互 | **cowGuard 实际遮蔽即升结构趟**(§2.2),注册表紧随遮蔽字节;内容遮蔽时序不变;batch 内 rename 子树的 dirtyPaths/copyFrom 语义保持 |
| batch 事件被桌面前缀过滤吞掉(播种后图标不出现) | desktop.js 订阅改 paths 判定(§2.5)+ T24 系列图标刷新回归 |
| size 校准拖慢启动 | 句柄递归下降实现;超 100ms 降级范围(§2.6) |
| 30ms 微防抖仍赶不上进程死 | 上限写死注释;pagehide 兜底(条件扩档 + 链式化);真正边界是断电,接受 |

## 8. 明确不做

- WAL / 跨文件原子性:树 JSON 与数据字节的毫秒级残余窗口接受
- fsync 级掉电持久
- vendor/AetherWebDatabase 改动;fs.v2.json 无破坏性格式变更
  (仅根上新增可选 savedAt / clockDelta,见 §2.6)

## 9. 决策记录

| 决策 | 值 | 依据 |
|---|---|---|
| 结构档防抖 | 30ms | 20~50 区间取中;对人即时,突发合并 |
| m/s 懒写兜底计时 | 30s | 纯卫生:会话内读取走内存恒新鲜;crash 后由启动校准修复,数值不承担正确性(调短 = 写放大回归) |
| crash 后 mtime 修复 | savedAt 哨兵 + clockDelta 换算(判定与修复均在 VFS 域) | 两系统时钟不保证一致(物理落盘时间 ≠ 逻辑 mtime);恢复/导入保旧 m 重写字节须豁免;δ 记根上、随 writeTree 自采样 |
| readAt 不截断 | 保持现状 | 懒写 s 的读侧安全前提,不引入按 s 截断 |
| 启动 size 校准 | 全体 bin 文件,句柄递归下降 | DB pageCount 消费 inode.s,正确性必需;超 100ms 再降级 |
| 缺失 vs 空文件 | actual==0 且 s>0 视为缺失 | opfsFileSize 缺失也返回 0;系统无 truncate 路径 |
| batch 广播 | 合并为一条 batch 事件(带 paths) | 文件管家等重渲染 N→1;桌面过滤需逐路径判定,公共祖先不够 |
| meta 档广播 | 30ms 合并为一条 | files/trash/monitor 全量重渲染不挑路径;桌面路径不经 meta 档 |
| cowGuard 遮蔽 | 升结构趟 | 注册表滞后 = 快照静默读到新内容;不升则窗口 250ms→30s |
| 树格式版本 | 不变 | 仅根上新增可选 savedAt / clockDelta(parseTree 不校验、stripContents 透传),旧树零迁移 |
