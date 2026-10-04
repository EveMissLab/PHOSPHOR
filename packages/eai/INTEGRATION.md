# PHOSPHOR · INT — Integration Log

**EML-EAI-2026-v0.2 · 最終整合（INT 階段）**
EveMissLab（一言諾科技有限公司）

本檔記錄 INT 整合階段的工作：將六個 Phase 的獨立模組轉為可執行、可驗證的整合系統，
並修正在驗證過程中暴露的執行正確性錯誤。論文（`EML-EAI-2026-v0.2.md`）的主張在此被
逐條實測，而非僅止於宣稱。

---

## 1. 如何執行

需求：Node.js ≥ 22（已測 v24）。

**後端／核心**（`PHOSPHOR/`）：
```bash
cd PHOSPHOR
npm install
npm run verify          # 端到端驗證（§6.3 無頭步驟 + CTS 補全 + VM64 視窗）→ 33 passed
npm run verify:ws       # P5 WebSocket server 真實 socket 端到端（§6.3 Step 3）→ 6 passed
npm run verify:stream   # phosphor-stream 可攜標準 → 30 passed
npm run verify:headless # v0.4 無頭 VM + EML-VM-BASIC（雙模式、有界整數、stream 整合）→ 23 passed
npm run typecheck       # tsc --noEmit，型別零錯誤
```

**前端**（`PHOSPHOR/ui/`，Vite + React，驅動已驗證的 P2 VMCore）：
```bash
cd PHOSPHOR/ui
npm install
npm run dev         # http://localhost:5173  ——「在 Claude 外面」看它跑
npm run build       # 出 dist/ 靜態檔（部署用，已驗證可 build）
```

前端為**單一引擎**設計：直接 import `../eml-vm16-core` 的已驗證 P2 VMCore，
不複製引擎，並把 CTS 的 symbol／comment／region 即時渲染出來。
`binary-matrix.jsx` 為純裝飾 artifact，無 VM 引擎，作為第二分頁。

---

## 2. 新增的整合骨架

| 檔案 | 作用 |
|------|------|
| `package.json` | ESM 專案宣告；`verify` / `verify:ws` / `typecheck` scripts；deps（ws）、devDeps（tsx、typescript、@types/node、@types/ws） |
| `tsconfig.json` | strict 模式；`tsc --noEmit` 型別檢查通過 |
| `integration.ts` | 端到端驗證 harness——逐條核對論文 §6.3 的宣稱，PASS/FAIL 附實測值 |
| `test-ws.ts` | P5 WebSocket server 真實 socket 端到端測試（§6.3 Step 3） |
| `eml-vm64-window.ts` | V2 多視窗層：`Window64VM` + `VM64WindowManager` + 16-bit 記憶體通道（§6.4 #3） |
| `ui/` | Vite + React 前端，import 已驗證 P2 VMCore（單一引擎），渲染 CTS 各層 |
| `stream/` | **phosphor-stream** 可攜標準：把任意 app 的狀態變成 AI 可讀事件流（emitter + sinks + 語義字典 + 異常偵測 + reader）。源自 Noema monitor 的概念,修掉其排序/輪替/schema 缺口。見 `stream/PHOSPHOR-STREAM.md` |
| `eml-vm-basic.ts` | 【v0.4】EML-VM-BASIC——EML-VM-16 的受限模式：值域改為有界整數 `[0,N]`（預設 N=10000，`Int32Array` 寬單元，非字面 u8），`bound()` 溢位政策（預設 wrap mod (N+1)，可設 clamp/throw），靜態 `validateProgramConstraints` + 動態 `ConstraintViolation`，內建 `PROGRAM_BASIC_SUM`（R0=300 證明寬單元） |
| `headless-vm.ts` | 【v0.4】無頭 VM 工廠 `createHeadlessVM`——UI-free 驅動，`ai`/`human` 雙模式，VM-16 與 BASIC 共用一個 snapshot builder；AI mode 輸出接上 phosphor-stream（每 tick 發 `vm:tick`，HALT 發 `vm:halt`）；附 CLI（`npm run phosphor -- run …`，含 `--ws-port` 復用 P5 stack） |
| `test-headless.ts` | 【v0.4】無頭 + BASIC 驗證 harness（`npm run verify:headless`）：bound() 三政策、約束靜/動態檢查、R0=300 寬單元證明、雙模式 snapshot、stream `vm:tick` + 狀態驗證、CLI smoke → 23 passed |
| `INTEGRATION.md` | 本檔 |

原本六個 `.ts` 模組無 `package.json`、無 `tsconfig`、無入口，無法執行；論文 §6.3 的所有
驗證宣稱（14/14 自我測試、fib 數列、pipeline 鏡射）**從未被實際跑過**。可執行化是整合的前提。

---

## 3. 修正的執行正確性錯誤

這三個錯誤先前未被發現，原因一致：原型只讓執行「**可見**」（磷光綠動畫在跑），
卻從未把視覺投影 Φ 與**真值**核對。這正是 §四「可見即可視」命題在工程上必須兌現、
最易被略過的一步——而它被留給了整合階段。

### 3.1 V1 FIBONACCI／COUNTER — 程式碼／資料區重疊（自我改寫）

- **症狀**：`stepN` 後 fib 輸出為 `[0,1,1,82,65,80,65,48,64,52,84]`——其中 82/65/80
  正是程式自身的 opcode 位元組被當成資料讀回。
- **根因**：FIBONACCI 程式碼佔 0x00–0x2D（46 bytes），卻把輸出寫到 0x20–0x2A，
  **覆蓋了自己的迴圈指令**。COUNTER 同理（碼 0x00–0x13，寫 0x10–0x1F）。
- **修正**：把資料區移到程式碼之後，且**不改變程式碼長度**（避免跳躍位址連鎖位移）——
  僅調整建立寫指標的最後一道立即值指令：
  - FIBONACCI：寫指標 `0x20 → 0x2E`（`INC R5` → `ADDI R5,#15`，使 15→16→31→46）。
  - COUNTER：寫指標 `0x10 → 0x14`（`INC R1` → `ADDI R1,#5`，使 15→20）。
- **波及更新**：兩程式的 CTS（symbolTable / typeTable / commentTable）、
  `DEMO_PIPELINE_FIBCIPHER` 的 channel 來源區（0x20–0x2A → 0x2E–0x38）、
  P0 JSX 內嵌副本、論文 §6.3 位址敘述。

### 3.2 V1／V2 FIBONACCI — 迴圈終止 off-by-one（漏算 fib(10)）

- **症狀**（V2，無重疊問題，故單獨暴露）：`[0,1,1,2,3,5,8,13,21,34,0]`——fib(10)=55 從未寫入。
- **根因**：計數器自 2 起，迴圈條件為 `JL/JL16`（counter < max=10），只儲存索引 2..9。
- **修正**：改為 inclusive 分支 `JLE/JLE16`（counter ≤ 10），儲存索引 2..10。
  - V1 `eml-vm16-core.ts`：`0x54`(JL) → `0x56`(JLE)。
  - V2 `eml-vm64-core.ts`：`0xB4`(JL16) → `0xB6`(JLE16)。

### 3.3 P5 `cmd:call` — 從未接通 CallableVM 的死路徑

- **症狀**：任何 `cmd:call` 都回 `"Window does not have a CallableVM"`。
- **根因**：handler 做 duck-type 取 `(rec.vm as any)._callableVM`，但 `WindowVM`
  從未掛上該屬性——靜態無法觸發，動態必失敗。
- **修正**：`WindowVM` 建構時若 program 帶 `exports`（即 CallableProgram），
  建立並持有一個 `CallableVM`，並以型別化 getter `callableVM` 公開；handler 改讀該 getter。
  驗證：`cmd:call add(3,5)` 現回傳 `8`。

---

## 4. CTS 兩項補全（§6.4 #4、#5）

| 函式（`eml-vm16-core.ts`） | 作用 |
|------|------|
| `buildStringTable(mem, start, end, minLen)` | Layer 4：掃描可列印 ASCII 連續區段，解碼為 `addr → string`。 |
| `augmentCTSFromTrace(cts, trace, memSnapshots)` | Layer 6 動態補全：差分逐 tick 記憶體快照，將每筆寫入歸因於該 tick 的指令位址，還原靜態分析看不見的 register-indirect 寫入者。純函式，不變更輸入 CTS。 |
| `traceWithSnapshots(program, maxSteps)` | 收集 `augmentCTSFromTrace` 所需的 trace + 逐 tick 快照。 |

**驗證**（harness 中的 PTR_CHASE 程式：`MEM[MEM[0x10]] = 7`）：
靜態 `buildCrossRef` 對 0x80 的 writers 為 `[]`（R1 來自 LD，無法靜態解析）；
`augmentCTSFromTrace` 還原出 writers `[0x08]`。stringTable 正確解出 `"PHOSPHOR"`。

---

## 5. 一個型別錯誤修正（非我引入）

`createInProcessTransport` 內 `makeHalf` 的參數型別 `ReturnType<typeof makeHalf>` 自我引用，
觸發 `TS7022`。重構為顯式 `InProcessHalf` 型別並移除恆為 `null` 的 `other` 參數
（其 `send` 本就在建構後才交叉接線）。行為不變，`tsc` 零錯誤。

---

## 6. 驗證結果

`npm run verify` → **33 passed**；`npm run verify:ws` → **6 passed**；`npm run typecheck` → 零錯誤。

| 步驟 | 內容 | 結果 |
|------|------|------|
| §6.3 Step 1 | P3 CallableVM ECC-1 自我測試 | 14/14 |
| §6.3 Step 2 | P4 跨 VM 記憶體通道 fib → cipher 鏡射 | 鏡射一致 |
| §6.3 Step 3 | P5 WebSocket server 端到端（welcome→subscribe→run→snapshot→call→serialize） | 6/6 over socket |
| §6.3 Step 4 | P5 in-process 快照串流 | 收到 10 筆快照 |
| §6.3 Step 5 | P6 VM64 fib(0..10) → RAM[0x4000..0x400A] | `[0,1,1,2,3,5,8,13,21,34,55]` |
| §6.3 Step 6 | P0 前端（`ui/`，P2-bound 單一引擎） | `vite build` 通過；dev server 可跑 |
| Pre | P2 V1 FIBONACCI / COUNTER / XOR_CIPHER | 全部正確（含重疊修正後） |
| CTS | 動態 crossRef + stringTable | 靜態漏、動態補；"PHOSPHOR" 解碼 |
| VM64 視窗 | Window64VM + 16-bit 通道 fib64 → receiver | 鏡射一致（64KB 空間） |

§6.3 全部六步皆已驗證。

---

## 6.5 v0.4 新增：雙模式 + 無頭 VM + EML-VM-BASIC

v0.4 把論文 §6–§9 的三項規格落地為可執行、可驗證的程式碼（規格見
`EML-EAI-2026-v0.4.md`）：

- **雙模式輸出（§6）**：VM Core 模式無關，`createHeadlessVM` 提供 `ai` / `human`
  兩條路徑，共用同一個 snapshot builder（VM-16 的 `Uint8Array` 與 BASIC 的
  `Int32Array` 都滿足 `ArrayLike<number>`，一個 builder 服務兩種 arch）。
- **無頭 VM 工廠（§8）**：`headless-vm.ts` 的 `createHeadlessVM` 為 UI-free 驅動，
  AI mode 最大吞吐（每 ~2000 步讓出事件迴圈）；AI mode 輸出接上既有
  **phosphor-stream**——每 tick 發 `vm:tick`，HALT 發 `vm:halt`，下游可用
  `memorySink` / `findAnomalies` / `emitter.check` 做收集、異常偵測與狀態驗證。
  另附 CLI（`npm run phosphor -- run …`，`--ws-port` 復用 P5 WS stack）。
- **EML-VM-BASIC（§9）**：`eml-vm-basic.ts` 把值域明確定為**有界整數 `[0,N]`**
  （預設 N=10000，寬單元，非字面 u8），重用 VM-16 的 ISA；溢位預設 wrap mod (N+1)，
  可設 clamp / throw；以白名單做靜態（`validateProgramConstraints`）與動態
  （`ConstraintViolation`）雙層約束。內建 `PROGRAM_BASIC_SUM` 算出 R0=300——一個
  u8 裝不下的值——證明寬有界整數單元。

`npm run verify:headless` → **23 passed**：

| 步驟 | 內容 | 結果 |
|------|------|------|
| §4 bound() | wrap / clamp / throw 三政策 | wrap 13→2、clamp 13→10、-3→0、throw 拋 ConstraintViolation(overflow) |
| §5 約束（靜態） | `validateProgramConstraints` 對 XOR 程式 | invalid，violation 點名 mnemonic XOR；BASIC_SUM 全允許 → valid |
| §5 約束（動態） | `stepOnceBasic` 執行不允許的 op | 拋 ConstraintViolation(kind=op, mnemonic=XOR) |
| §6 寬單元證明 | `PROGRAM_BASIC_SUM` 跑到 HALT | R0 === 300（> 255，u8 不可能） |
| §6 執行中溢位 | maxValue=10 下 `ADDI` 8+5 | wrap mod 11 → 2 |
| §3 雙模式 | headless VM-16 fib + BASIC sum | mode=ai、arch 標記正確；fib(0..10) 正確；BASIC R0=300、arch=EML-VM-BASIC |
| §3 stream 整合 | emitter `vm:tick` + 狀態驗證 | 收到 vm:tick；intent-vs-actual 相符回 true、刻意 mismatch 回 false 且被 `findAnomalies` 撈出 |
| §4 CLI smoke | 子行程跑 `headless-vm.ts run --program fibonacci --max 30` | exit 0；stdout 有 ≥1 筆 `mode=ai` JSON 行 |

---

## 6.6 v0.5 新增（EXPERIMENTAL）：語義層 + EML 互通 + 單一真相快照

v0.5 是標註測試的實驗版（套件 `0.5.0-beta.0`，規格見 `EML-EAI-2026-v0.5.md`）。

- **語義層（操作式）`eml-semantic.ts`**：`describeEffect` 把每條指令映射為狀態轉移
  語意；`semanticEquiv` 以「跑兩邊比輸出」判斷位元組語義等價，移植 EML 紀律——對抗式
  輸入、≥2 種不同輸出守則、三值判決（equivalent / not-equivalent / inexpressible，
  不終止或不可鑑別即拒絕）；可發 `vm:equiv` 自驗證事件。明確延後 Hoare 證明。
- **EML 互通**：`stream/eml-consumer.ts` 以 PHOSPHOR 自家機制消費 EML 的
  `phosphor-jsonl-v1` 軌跡（對**真實** EML 輸出驗 0 envelope 違規），抽取
  `eml:equiv`/`eml:bug`/生命週期；`eml-cts-interop.ts` 把 EML 原始碼層 `Cts` 中**真正
  對應**的部分（symbols→Dictionary、functions→注意力、loops→控制流）橋接到 PHOSPHOR，
  並明示位址/opcode/`semanticType`↔`DataType` 不轉移。契約見
  `stream/EML-INTEROP.md`、`CTS-INTEROP.md`。
- **單一真相快照 `headless-snapshot.ts`**：把 AI 快照建構抽為瀏覽器安全模組，無頭驅動器
  與 UI 共用同一 `buildHeadlessSnapshot`，修正 v0.4 中 UI 重實作並遺漏 `before` 的分歧；
  `vm:tick` 欄位改名集中為 `headlessSnapshotToStreamFields`。
- **核心強化**：`augmentCTSFromTrace` 新增 register-indirect `dataReaders` 動態還原
  （`effectiveAccess` + `traceWithSnapshots` 的有效存取串流），補完 CTS 第 6 層。
- **版本衛生**：版號 0.4.0 → `0.5.0-beta.0`（root/`ui/`/`exe/` 與 lock 對齊；修 lock 的
  stale `UNLICENSED` → Apache-2.0）；散落於 `v0.1` 的協定字串收斂為單一常數 `EAI_PROTO`。
  v0.4 的 cmd:call「known gap」探針其實早已通過，註解更正為硬斷言（與 test-ws 一致）。

驗證新增 `npm run verify:eml` → **30 passed**、`npm run verify:semantic` → **26 passed**；
`verify` 由 33 → **36 passed**（reader 還原 + 負控制 + cmd:call 硬斷言）。全六套 + typecheck
全綠（共 **151 項**）。

**對抗式審查（34 agents）**：v0.5 落地後跑一輪維度化對抗式 code review，29 項發現經逐一
對抗式驗證後確認 9 項真缺陷並全數修復：等價引擎兩個 soundness 漏洞——(1) mem 槽別名 code
區致非對稱破壞（critical），(2) 取樣僅涵蓋 17/256 值致可能誤判 equivalent（high）——分別以
code 區防護（fail-loud inexpressible）與單輸入窮舉 + 全範圍取樣 + `exhaustive` 誠實標示修復；
另修 `distinctOutputs` 計數、PTR_READ 負控制、`--run` temporal splice 生命週期、
`ui/package-lock.json` stale 版號等。其餘 20 項為對抗式駁回（多數確認既有實作正確：
effectiveAccess 六例全對、trace/accesses 對齊 sound、prevMemRef 冪等無害等）。

---

## 6.7 v0.6 新增：Φ 的第一個非自製目標——真實 WASM

v0.6 是 WORKPLAN.md Phase 1 的落地：把 Φ:M×CTS→V 接到一個**真實**執行語意，而不是
再發明一個 VM。選擇 WASM（見 `wasm/` 目錄）：

- **`wasm-binary.ts`**：解碼真正的 WebAssembly 二進位格式（LEB128、type/function/
  memory/export/code/data 段 + custom "name" 段），子集為 i32 整數、結構化控制流
  （block/loop/if/else）、`call`、一個線性記憶體——支援範圍外的構造（imports、
  多值 block type、i64/f32/f64、table/call_indirect）明確拋 `WasmNotSupported`，
  不會靜默誤讀，延續 `semanticEquiv` 的「答不出來就老實說」紀律。控制流在解析階段
  就把 block/loop/if 的 matching end/else 位置算好，直譯器不必在執行期重掃位元組。
- **`wasm-interp.ts`**：`stepOnce(state)` 逐指令執行，每個 tick 複製 memory /
  globals / 每個作用中的呼叫幀（locals、operand stack、control stack）——與
  `eml-vm16-core.ts` 的 `stepOnce` 「functional step engine」契約完全一致（舊
  state 不受影響）。
- **`wasm-cts.ts`**：把既有 `CTS` 型別（`u8` 本來就只是 `number` 的別名，結構上可
  直接複用）套到 WASM 的線性記憶體層——symbolTable/typeTable 來自 data segment、
  stringTable port 自 `buildStringTable` 同一條「可列印 ASCII 連續區段」規則、
  crossRefTable 由完整一輪快照動態折疊出每個位址的寫入者。**明講的界線**：WASM
  的 code 位址空間（funcIdx+instrIdx）跟 memory 位址空間是兩個空間，不像 VM-16
  共用一份記憶體；函式/區域名稱走 `wasm-snapshot.ts` 的 `pc_symbol`，不硬塞進
  `CTS.symbolTable`。這正是 WORKPLAN.md Phase 3（通用改造 Skill）「CTS 角色需要
  按架構重新推導」的第二個實證資料點。
- **`wasm-snapshot.ts`**：`buildWasmSnapshot` 是 `buildHeadlessSnapshot` 的 WASM
  版——同樣「一個 builder、agent 流跟未來人類視圖共用同一顆真相」的角色，欄位形狀
  照 WASM 實際的狀態（operand stack + per-call locals + call depth）而非硬套
  register-machine 的 registers/flags。
- **`wasm-fixtures.ts`**：手刻一個真正符合規格的 `.wasm` 二進位（非本專案發明的
  格式）——`PROGRAM_FIBONACCI` 同一段運算（fib(0..10) 寫入記憶體），改用真正的
  WASM `loop`/`br_if`/`call`/`i32.store`；含一個 data segment（"PHOSPHOR" @4096）
  對應既有 §4 stringTable 驗證的敘事。

**驗證**（`npm run verify:wasm` → **24 passed**）：`WebAssembly.validate()` 確認
是規格合法的二進位；`WebAssembly.instantiate()` 跑 Node **原生** WASM 引擎執行同一
份 bytes，逐位元組核對我方直譯器的最終記憶體結果——兩者完全一致。這是比「內部自我
一致」更強的證明：不是自證，是跟一個獨立、規格遵循的真實引擎對答案一致。

全套 `verify + verify:ws + verify:stream + verify:headless + verify:eml + verify:semantic + verify:sheet + verify:sheet-control + verify:wasm` = **236 checks**，`typecheck` 零錯誤。

---

## 6.8 v0.7 新增：Phase 2 旗艦案例——三個投影第一次串成一個真實故事

WORKPLAN.md Phase 2 落地：Human CRT / AI stream / Sheet 三個投影不再各自獨立
demo，而是圍繞同一個真實情境運作。情境：AI 對一段**真實 rustc 編譯**的 WASM
程式提「優化」（inline `add()`），`wasmSemanticEquiv` 判斷等價與否，結果進
PHOSPHOR-SHEET `09_Control` 給人核准，核准後才真的切換執行版本，全程留下
`phosphor-jsonl-v1` 稽核軌跡。

- **`wasm/wasm-semantic.ts`**：`semanticEquiv`（`eml-semantic.ts`）同一套紀律
  移植到 WASM——對抗式輸入、≥2-distinct-output 守則、三值判決。誠實的範圍收斂
  （寫在檔案開頭註解）：VM-16 的 u8 定義域（0–255）本身就是完整值域，`exhaustive`
  在那邊是「對所有輸入的真證明」；WASM i32 參數的值域（2^32）不可能窮舉，這裡
  `exhaustive` 明講只代表「呼叫端宣告的有界定義域被完整覆蓋」，不是同一個詞的
  無界版本，避免用同一個字含糊帶過不同強度的宣稱。另一項真實調整：兩個行為等價
  的 WASM 二進位，linker 給的記憶體位址可以合法不同——判定器對兩邊程式各自呼叫
  `outputPtrExport` 找自己的位址，不假設共用一個固定位址。
- **`wasm/rust-fixtures/`**：三個**真正用 `rustc --target wasm32-unknown-unknown -O`
  編譯**出來的 `.wasm`（非手刻）：`baseline.rs`（`add()` 保留真的 call）、
  `optimized-correct.rs`（inline `add()`，行為相同）、`optimized-buggy.rs`
  （同樣 inline，但迴圈邊界從 `i <= n` 被「簡化」成 `i < n`，off-by-one 漏掉
  最後一個 fib 值）。過程中的真實發現：rustc `-O` 會把相鄰兩個 i32 store
  合併成一個 i64 store（超出 WASM-MVP 不支援 i64 的範圍）——改用
  `core::ptr::write_volatile` 禁止這個合併，不是放寬 profile 遷就，紀律與
  v0.6 一致（見 `build.sh` 註解）。baseline 逐位元組核對 Node 原生引擎（真實
  `block`+`loop` 巢狀，比 v0.6 手刻的 fixture 更貼近真實世界）。
- **`wasm/wasm-sheet-bridge.ts`**：把等價判定結果包成 `09_Control` 列，**在人看到
  之前**就把 verdict 寫進 `args_json`——核准不是憑空的信任，是看得到證據的決定。
- **`spreadsheet/phosphor-control.ts`**：新增 `wasm:apply_optimization` 指令，
  **硬性拒絕**任何 verdict 不是 `equivalent` 的提案，**不論 Approved 欄位為何**——
  人的核准是「要不要採用這個已證明安全的優化」的裁量權，不是拿來覆蓋一個沒通過
  驗證的提案。`spreadsheet/phosphor-control-host.ts` 加對應 `applyOptimization`
  host 能力。
- **`ui/src/FlagshipView.jsx`**（▸ FLAGSHIP 分頁）：三個投影真的畫在同一個畫面——
  左邊 Human CRT 顯示「目前實際在跑」的版本、中間 AI stream 顯示即時稽核事件、
  右邊 Sheet 控制格顯示待核准列。瀏覽器實測：提兩案（safe + buggy）、兩個都核准
  （模擬人看漏了）、按執行——safe 版 EXECUTED 且左邊 Human CRT 真的切換成
  optimized-correct（halt tick 248→212，inline 少一次 call/return，數字上也對得
  起來）；buggy 版 REJECTED，錯誤訊息點名「judge 沒有 certify」，即使核准欄勾了
  也沒被執行。過程中修了一個真的 bug：兩個提案在同一個 tick 內連續觸發時，
  `setWorkbook(f(workbook))` 讀到同一份 stale closure，後者會蓋掉前者——改用
  functional setState 修正。

**驗證**（`npm run verify:wasm-semantic` → **17 passed**）：headless 重現瀏覽器裡
驗證過的同一條路徑（判定 → 包裝成列 → 治理執行 → 稽核）。全套九個驗證套件 +
新增這個 = **253 checks**，`typecheck` 零錯誤，無回歸。

---

## 6.9 v0.8 新增：Phase 3——CTS 角色化 + 難度分級 + 第二個獨立驗證目標

WORKPLAN.md Phase 3 落地：把 CTS 六層從「VM-16 詞彙」改寫成領域無關角色，明講
難度分級，並用一個跟 VM-16／WASM **完全不共用程式碼**的第三種架構驗證這套角色
真的能轉移，不是「VM-16 換個名字」。

- **`EAI-RETROFIT.md`**：六個角色（Unit Vocabulary / Location Naming / Region
  Typing / Decoded Content / Intent Annotation / Provenance Graph）+ 難度三層
  （Tier 1 決定性可重播、Tier 2 事件驅動盡力而為、Tier 3 非決定性只能給近似
  視圖）。老實講清楚 `exhaustive`／`Φ` 保證這些詞在不同 Tier 下代表不同強度的
  承諾，不是同一個詞含糊套用。v1 範圍鎖定 Tier 1。
- **`skills/phosphor-adopt/SKILL.md`**：Claude Code Skill，流程是分類 Tier
  （不是 Tier 1 就老實說、不硬做）→ 確認位址空間是否共用（code/state 同一
  空間還是分開，WASM vs VM-16 的真實教訓）→ 逐角色提 CTS 對應草案，**在人確認
  前不動手寫程式碼**→ 建 snapshot builder，接現成的 `phosphor-stream`（本來就
  跟領域無關，不用改）→ 用獨立參照驗證，不是自我一致就算數。刻意不是一鍵
  全自動——確認關卡是紀律的核心，不是形式。
- **`rpn/`**（`rpn-core.ts` / `rpn-cts.ts` / `rpn-snapshot.ts`）：第二個 Tier 1
  驗證目標——堆疊式 RPN 計算機，命名變數，沒有暫存器、沒有線性記憶體、沒有控制流，
  跟 VM-16、WASM 是三種不同架構。六角色套用結果：Unit Vocabulary/Location
  Naming/Region Typing/Intent Annotation/Provenance 都有真實內容；**Decoded
  Content 老實留空**（純數值運算沒有字串內容可解碼）——呼應 WASM Layer 5 那次
  空白，這次是刻意驗證「角色可以合法空白，不用硬塞內容充數」這條原則本身。
  Provenance（Role 6）用動態折疊方式復原（跟 `augmentCTSFromTrace` /
  `augmentRpnProvenance` 同一手法），不是靜態推導。snapshot 的 `pc`/`instruction`
  刻意採**回顧式**（剛執行完的那個 token），跟 VM-16/WASM 的**前瞻式**（下一個
  要執行的）方向相反——因為這裡的敘事重點是「誰寫了這個變數」，這是個回顧問題，
  硬套前瞻慣例只會更難用，兩種慣例都寫進文件講清楚差異，不是互相矛盾。

**驗證**（`npm run verify:rpn` → **19 passed**，第一次跑就全過）：獨立算出
`area=w*h`、`perimeter=2*(w+h)` 核對（不是從被測系統本身推出來的參照）；
Provenance 正確復原每個變數的寫入者/讀取者；除以零跟讀未定義變數都正確
fail-loud，不是靜默錯誤。全套驗證 + 這個 = **272 checks**，`typecheck` 零錯誤，
無回歸。

**第一次真的用在別的 repo 上（2026-08-10）**：`ctcl-app`（Neo 自己另一個真實、
已上線的專案，Rust）的 `ctcl-core::TemporalSystem::local_seconds()`——一個
純函式，吃參考時間點回傳自訂時間系統的本地秒數，**沒有程式可以踩**，是
Tier 1 的第三種形狀（VM 逐步執行／RPN 線性求值／這次：固定公式對輸入求值）。
新增 `ctcl-core/src/phosphor.rs`，完全不動 `system.rs`（那段算式本來就驗證過
跟 hosted Worker 行為一致）——Provenance（現在生效的是哪個 segment/pause
window/table 區間）從公開資料獨立算出來，測試用手算的期望值核對，不是拿
`local_seconds()` 自己的邏輯驗自己。19/19 測試通過（13 舊 + 6 新），
`cargo check --workspace` 跟 clippy 都乾淨。放在 `phosphor-adopt-retrofit`
分支，已推上 GitHub，**還沒併進 `ctcl-app` 的 main**——這是研究性質的驗證，
不是要出貨的功能。詳見 `EAI-RETROFIT.md` §2.1。

---

## 7. 剩餘未來工作

§6.3 六步與 §6.4 五項整合點皆已處理。後續延伸（皆非缺口）：

- **Agent 層 V1/V2 統一**：`AgentSession` 目前綁 V1 `VMWindowManager`；若要讓 agent
  透過 WS 訂閱 VM64 視窗，需把 session 泛化到 `VM64WindowManager`（或抽共同介面）。
- **VM64 序列化／還原**：V1 manager 有 serialize/restore；`VM64WindowManager` 尚未加。
- **前端擴充**：`ui/` 目前呈現單一 V1 VM；可再加 VM64 視窗、多視窗 pipeline、
  以及透過 WS 連後端的 agent 監控視圖。
- **SSE 部署驗證**：WS 已端到端驗證；SSE 轉接器已實作但未加網路測試。
- **`phosphor-adopt` Tier 2 支援尚未開工**：v0.8 明確鎖定 Tier 1；事件驅動、
  盡力而為保證的 Tier 2 是真的未來工作，細節見 `EAI-RETROFIT.md` §3。
