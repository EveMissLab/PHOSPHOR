# PHOSPHOR
## 執行即介面（EAI）：機器碼視覺化基礎設施

**EML-EAI-2026-v0.5 · EXPERIMENTAL（實驗／測試版）**
EveMissLab（一言諾科技有限公司）
作者：Neo.K（許筌崴）
發表日期：2026-06-26
套件版號：`0.5.0-beta.0`

版本說明：v0.5 是**標註為測試的實驗版**。本版實作 v0.4 預告的「語義↔機器碼對照層」，
但採**操作式（operational）**而非 Hoare/指稱式（denotational）形式；並接通 EML ⇄
PHOSPHOR 互通（軌跡消費 + CTS 橋接）；同時把 AI 快照建構收斂為單一真相來源。v0.5 新增
的 API（語義層、EML 消費器、`EAI_PROTO`）**在 v0.6 前可能變動**；v0.4 已驗證核心
（VM 家族、6 層 CTS、phosphor-stream、Agent 協定）不變。

---

## 摘要

v0.4 確立 PHOSPHOR 的雙模式架構（Human / AI mode 共享同一 VM Core）。v0.5 往「**語義**」
推進一層：不只讓執行**可見**，更要讓 agent 能推理「這段機器碼**是什麼意思**」、並判斷
「兩段不同的位元組是否語義等價」。

v0.5 的核心決定是：**等價以執行確立，而非以證明確立。** 這直接借鏡姊妹專案 EML——
EML 在 v1.0 明確放棄公理化／指稱式證明，改以「跑兩邊、比可觀察輸出」建立其「執行真相
（execution truth）」不變量。PHOSPHOR v0.5 把這套紀律原封移植到位元組層級。

---

## 一～五（不變，詳見 v0.4 / v0.3）

問題陳述、EML-VM-16 架構、對應表系統（CTS）、EAI 範式、EML-VM64 架構——均不變。
v0.5 對核心唯一的加強是 CTS 第 6 層的**動態讀取者還原**（見 §九）。

---

## 六、語義層（操作式）— `eml-semantic.ts`

語義層由兩部分組成，皆建立在既有整數 VM 之上，不引入新 ISA。

### 6.1 指令操作語意 — `describeEffect(op, arg)`

把每一條指令 `[op][arg]` 映射為其**狀態轉移意義**：

```
InstrEffect = {
  mnemonic, reads[], writes[], readsFlags[], flags[],
  mem: 'none'|'read'|'write', control: 'fallthrough'|'jump'|'cond-jump'|'call'|'ret'|'halt',
  summary   // 例如 "R0 ← (R0 + R1) mod 256"
}
```

這是比 CTS opcodeTable（只給助憶符）更深一層的「機器碼 → 狀態轉移」對照。LD/ST 的記憶體
位址是暫存器間接、執行期才定，故 `mem` 記其存取種類，實際位址由核心的 `effectiveAccess`
在執行時捕捉。

### 6.2 等價判斷 — `semanticEquiv(codeA, codeB, spec)`

以「跑兩邊、比可觀察輸出」判斷兩段位元組是否語義等價。`spec` 指定輸入注入位置
（暫存器／資料格）與輸出觀察位置（可含旗標）。移植自 EML `validateEquivalence` 的紀律：

1. **對抗式輸入 + 全範圍取樣**——引擎自行生成輸入向量：邊界掃描 + 確定性 LCG **全 [0,255]
   範圍**混合（非僅限策展池），**絕不**只信任單一（如全零）輸入。
2. **單輸入窮舉 ⇒ 真證明**——單一輸入槽時窮舉全 256 值，此時 `equivalent` 是對整個輸入
   空間的**證明**；多輸入則取樣，結果以 `exhaustive: false` 標示，`equivalent` 僅代表
   「在已測輸入上等價」，非全稱證明。
3. **≥2 種不同輸出守則**——認證等價前要求輸入確實能**鑑別**行為（≥2 種不同輸出）；對退化
   （全同輸出）輸入集的「一致」不構成證據（此守則防退化，**非**防覆蓋不足）。
4. **code 區防護**——拒絕落在任一程式 code 區的 mem input/output 槽（poke 會非對稱破壞
   指令、observe 會讀到指令位元組而非運算值），回 `inexpressible`。
5. **三值判決 + 失敗即明示**——`equivalent` / `not-equivalent` / `inexpressible`；遇不終止、
   不可鑑別、或槽位非法時**拒絕而非臆測**。`not-equivalent` 帶具體反例（sound）。

由於 VM 核心無時鐘、無隨機，判決對 `(codeA, codeB, spec)` 完全**可重現**。本判斷器本質是
**證偽器**：`not-equivalent` 恆 sound；`equivalent` 唯 `exhaustive` 時為證明，否則為高覆蓋
有界測試。全稱等價的形式化（Hoare／指稱式）證明延後。

可選地，`semanticEquiv` 透過 phosphor-stream emitter 發出**自驗證**的 `vm:equiv`
事件（`ok ⟺ 認證等價`）——位元組層級的 EML `eml:equiv` 對應物。

### 6.3 為何是操作式而非 Hoare

v0.4 預告語義層時提到「Hoare logic／operational semantics」。v0.5 選擇後者：EML 的經驗
證明，等價在工程上以**執行**確立比以**證明**確立更可落地、可證偽、可測試。形式化的
Hoare／指稱式證明層留待後續版本（見 §十一）。

---

## 七、EML ⇄ PHOSPHOR 互通

兩專案的文件都承諾「EML 餵給 PHOSPHOR」，但 v0.4 前未接線。v0.5 接通之。

### 7.1 軌跡消費 — `stream/eml-consumer.ts`

EML 以**相同**的 `phosphor-jsonl-v1` envelope 發出其編譯／執行／equiv／bug 事件。
`ingestEmlTrace()` 復用 PHOSPHOR 自家的 `parseStream` / `validateEvent` / `mergeOrder`
/ `findAnomalies` / `summarize`（證明兩端 envelope 可互換——對**真實**的 EML 軌跡輸出
驗證 0 違規），再疊上 EML 語意抽取：

- `eml:equiv` → 執行真相等價判決（語義等價層的天然上游輸入）；
- `eml:bug` → 5 級 BUG 嚴重度；
- `eml:run:*` → 執行生命週期。

envelope 逐欄差異見 [`stream/EML-INTEROP.md`](stream/EML-INTEROP.md)。

### 7.2 CTS 橋接 — `eml-cts-interop.ts`

兩端的 CTS 是**同形而不同高度、不同鍵空間**：PHOSPHOR 以記憶體**位址**為鍵（機器高度），
EML 以**符號／節點 id 字串**為鍵（原始碼高度）。故**不可逐欄互換**。橋接只轉移真正對應者：

- EML `symbols` → phosphor-stream 語意 `Dictionary`（`meta:dictionary`）；
- EML `functions`（cold/hot + importance）→ 注意力／風險提示；
- EML `loops`（loopKind + 決定性／終止性）→ 控制流提示。

**不轉移**：位址、opcode、區段；EML 的 `semanticType`（原始語句類別，如 `function.cold`）
與 PHOSPHOR 的 `DataType`（記憶體格型別，如 `u8`/`ptr`）是不相交詞彙，保留為標籤而**不強制
映射**。完整契約見 [`CTS-INTEROP.md`](CTS-INTEROP.md)。

---

## 八、單一真相來源：快照重構 — `headless-snapshot.ts`

v0.4 中人類模式 UI **重新實作**了 AI 快照建構，並遺漏 `changed_this_tick` 的 `before`
欄位，違背「單一引擎」主張。v0.5 把 `HeadlessSnapshot` 與 `buildHeadlessSnapshot` 抽到
瀏覽器安全的 `headless-snapshot.ts`，由無頭驅動器**與** UI 共用同一個建構函式；UI 追蹤
前一刻記憶體，使 `before` 為真值。`vm:tick` 串流的欄位改名（`tick→vm_tick`、
`changed_this_tick→changed`）也收斂到單一可匯出函式 `headlessSnapshotToStreamFields`，
集中文件化三種快照形狀的契約。

---

## 九、核心強化：CTS 第 6 層動態讀取者

`augmentCTSFromTrace` 原本僅靠記憶體 diff 還原 `dataWriters`；但 `LD Rd,[Rs]` 的讀取
不改記憶體，diff 看不見。v0.5 由 `traceWithSnapshots` 額外捕捉每刻的**有效存取**
（`effectiveAccess`，從執行前狀態解析間接運算元），使 `augmentCTSFromTrace` 能還原
register-indirect 的 `dataReaders`，補完第 6 層計算圖。

---

## 十、版本策略

- 套件版號採 semver 預發行：`0.5.0-beta.0`（root、`ui/`、`exe/` 對齊；lock 檔同步）。
- runtime 廣播給 agent 的協定／序列化版本收斂為單一常數 `EAI_PROTO = 'EML-EAI-2026-v0.5'`
  （取代散落且停滯於 `v0.1` 的硬編字串），杜絕再次漂移。
- `phosphor-jsonl-v1` envelope 與既有事件型別凍結；新增機器層事件型別（如 `cpu:step`）
  可在同 `proto` 下加入，不需升版。

---

## 十一、延後項目

- **EML-VM-F32 / F64 浮點 VM**——延後。需新增浮點值模型、IEEE-754 ISA 語意（NaN/inf 取代
  wrap/clamp/throw 溢位策略）、新指令長度類別、以及浮點感知的 CTS 與 `changed_this_tick`。
- **Hoare／指稱式證明層**——在 §六操作式判斷之上的形式化證明，留待後續。

---

## 十二、驗證

| 指令 | 範疇 | 檢查數 |
|------|------|:---:|
| `npm run verify` | 核心整合（含 reader 還原 + 負控制與 cmd:call 硬斷言） | 36 |
| `npm run verify:ws` | WebSocket Agent 端到端（真實 socket） | 6 |
| `npm run verify:stream` | phosphor-stream 可攜標準 | 30 |
| `npm run verify:headless` | 無頭 AI 模式 + EML-VM-BASIC | 23 |
| `npm run verify:eml` | **v0.5** EML 互通（軌跡消費 + --run splice + Cts 橋接） | 30 |
| `npm run verify:semantic` | **v0.5** 語義層操作式等價判斷（含 code 區防護 + 窮舉覆蓋） | 26 |
| `npm run typecheck` | `tsc --noEmit`，零錯誤 | — |

共 151 項檢查全綠。經一輪 34-agent 對抗式審查，9 項確認缺陷（含等價引擎 code 區別名與
取樣覆蓋兩個 soundness 漏洞）已全數修復並加回歸測試。

---

*EveMissLab（一言諾科技有限公司）· PHOSPHOR · EML-EAI-2026-v0.5 · EXPERIMENTAL*
