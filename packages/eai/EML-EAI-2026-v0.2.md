# PHOSPHOR
## 執行即介面（EAI）：機器碼視覺化基礎設施

**EML-EAI-2026-v0.2**
EveMissLab（一言諾科技有限公司）
作者：Neo.K（許筌崴）
發表日期：2026-06-10
版本說明：v0.2 更新——所有 Phase 實作完畢，補充 EML-VM64 架構規格，加入代理整合指南，正式命名為 **PHOSPHOR**。
分類：計算機架構 · AI 介面設計 · 視覺化基礎設施

---

## 摘要

PHOSPHOR 是一套以「執行即介面（Execution-as-Interface, EAI）」為核心主張的機器碼視覺化基礎設施。其根本命題是：機器碼的實際執行過程，在配備完整對應表系統（Correspondence Table System, CTS）之後，可與其視覺化呈現達到同構關係——**可見即可視（Visible ≡ Visualizable）**。這不是除錯工具的功能延伸，而是對「程式碼是什麼」這個問題的重新定義：程式碼不再是需要被翻譯成視覺的靜態文字，而是天然具備視覺可投影性的執行事件流。

命名根據：PHOSPHOR（磷光體）是 CRT 螢幕中吸收能量、延遲發光、殘留顯影的物質。這與 VM 狀態流的本質是隱喻上的同構——機器碼吸收指令，發出可見狀態，殘留語義痕跡。此名同時錨定了本計畫的視覺簽名：磷光綠的執行界面。

本計畫涵蓋從原型視覺化組件到 AI 代理串流介面、再到 64KB 擴展架構的完整實作，共六個 Phase，交由 Agent 完成最終整合。

---

## 一、問題陳述：視覺化為何一直是事後加上去的？

傳統軟體工具鏈的隱含假設如下：

```
原始碼（文字）
    → 編譯 / 解釋（不可見過程）
        → 執行（機器狀態，對人類不透明）
            → 除錯器（事後加掛的視覺化層）
```

視覺化在這條鏈的末端，是補救措施，不是設計預設。人類需要工具去「窺視」一個本質上不透明的執行過程；AI 代理在這條鏈裡沒有天然位置，只能間接讀取日誌或插入探針。

PHOSPHOR 的主張是反轉這個假設的方向：

```
執行事件流（machine state stream）
    ↓
對應表系統（CTS）賦予語義層
    ↓
視覺化即執行，執行即介面
    ↓
人類可見 ≡ AI 可解析 ≡ 程式正在運行
```

「可見即可視」命題的精確表述：

> 設 M 為一個 VM 在時間步 t 的完整狀態（記憶體快照、暫存器、PC、SP、FLAGS），設 CTS 為該 VM 的完整對應表集合。則存在一個投影函數 Φ : (M, CTS) → V，其中 V 是一個對人類具有直接語義可讀性且對 AI 代理具有結構可解析性的視覺表示，且此 Φ 在每個執行步驟都是唯一確定的（deterministic）。

---

## 二、EML-VM-16 架構規格（V1 基準）

### 2.1 硬體模型

| 元件 | 規格 |
|------|------|
| 資料匯流排寬度 | 8-bit |
| 地址空間 | 8-bit（256 bytes RAM） |
| 通用暫存器 | 8 個（R0–R7，各 8-bit） |
| 特殊暫存器 | PC（16-bit 升級後）、SP（初始 0xFF，向下增長） |
| 旗標暫存器 | FLAGS：Z（零）、N（負/小於）、G（大於） |
| 指令格式 | 定長 2-byte：[opcode:8][arg:8] |
| arg 編碼 | [dst:4 \| src/imm:4]；跳躍/呼叫類使用完整 arg 作絕對地址 |

### 2.2 指令集（ISA V1，完整 28 條）

**資料傳輸**
```
0x10  MOV   Rd, Rs        Rd = Rs
0x11  MOVI  Rd, #imm4     Rd = imm (0–15)
0x80  LD    Rd, [Rs]      Rd = MEM[Rs]
0x81  ST    [Rd], Rs      MEM[Rd] = Rs
```

**算術**
```
0x20  ADD   Rd, Rs    0x21  ADDI  Rd, #imm4
0x22  SUB   Rd, Rs    0x23  SUBI  Rd, #imm4
0x41  INC   Rd        0x42  DEC   Rd
```

**邏輯**
```
0x30  AND   Rd, Rs    0x31  OR    Rd, Rs
0x32  XOR   Rd, Rs    0x33  NOT   Rd
0x40  CMP   Ra, Rb    （設定 FLAGS，不寫回）
```

**跳躍（arg = 8-bit 絕對地址）**
```
0x50  JMP   0x51  JZ    0x52  JNZ
0x53  JG    0x54  JL    0x55  JGE   0x56  JLE
```

**堆疊與呼叫**
```
0x60  PUSH  Rs    0x61  POP   Rd
0x70  CALL  addr  0x71  RET
0x00  NOP         0x01  HALT
```

### 2.3 呼叫慣例 ECC-1（EML Calling Convention v1）

| 要素 | 規格 |
|------|------|
| 參數傳遞 | R0–R7（最多 8 個 u8 參數） |
| 回傳值 | R0（執行至 HALT 後） |
| 堆疊 | 每次呼叫重置 SP=0xFF |
| 暫存器保存 | 無（callee 可任意覆蓋） |
| 終止條件 | HALT 指令 |

---

## 三、對應表系統（CTS）設計規格

CTS 是「可見即可視」命題成立的充分條件。裸位元組是匿名的；加上 CTS，記憶體格成為語義圖。

### CTS 六層架構

| 層 | 名稱 | 鍵值 | 作用 | 狀態 |
|----|------|------|------|------|
| 1 | opcodeTable | u8 | opcode → 助憶碼、參數型別、flagsWritten | **已實作** |
| 2 | symbolTable | addr | 位址 → 符號名稱、區域、型別 | **已實作**（各程式附帶） |
| 3 | typeTable | range | 地址範圍 → code/data/stack/io | **已實作** |
| 4 | stringTable | addr | 位址 → ASCII/UTF-8 解碼字串 | **已實作**（INT：buildStringTable() 掃描可列印區段） |
| 5 | commentTable | addr | 位址 → 人類語義注解 | **已實作**（各程式附帶） |
| 6 | crossRefTable | addr | 位址 → callers/readers/writers | **已實作**（buildCrossRef() 靜態 + augmentCTSFromTrace() 動態） |

crossRefTable 是六層中理論重量最高的。它將 VM 狀態從快照升格為**計算圖**——AI 代理可以追蹤因果鏈，而不只是觀察當前狀態。`buildCrossRef()` 以靜態分析自動推導跳躍目標和部分讀寫關係；register-indirect 定址（如 `ST [Rd], Rs`，其中 Rd 由 LD 於執行期載入）無法靜態解析，由 INT 階段實作的 `augmentCTSFromTrace()` 以執行軌跡的記憶體快照差分動態補全——靜態分析看不見的寫入者，動態分析逐一還原。

---

## 四、執行即介面範式（EAI Paradigm）

### 4.1 核心主張

> VM 執行事件流（M_0, M_1, …, M_t）加上對應表系統 CTS，構成一個完整的介面原語（interface primitive）。此原語對人類具備直接視覺可讀性，對 AI 代理具備結構可解析性，且兩者讀取的是同一個物件——**不是同一個物件的兩種不同表示，而是同一個物件本身**。

傳統除錯器是執行之外的觀察者，讀取的是程式的「影子」；PHOSPHOR 框架中，視覺化輸出與執行過程共享同一個狀態機。沒有觀察者，只有執行。

### 4.2 AI 代理 JSON 串流格式（V1 / V2）

```json
{
  "vm_id": "fib-001",
  "tick": 42,
  "pc": "0x001A",
  "pc_symbol": "LOOP",
  "pc_comment": "R2=R0+R1; shift pair; STAX to data segment",
  "instruction": "ADD R2, R1",
  "instruction_bytes": 2,
  "registers": { "R0": 3, "R1": 5, "R2": 0 },
  "address_regs": { "AR0": "0x4007" },
  "flags": { "Z": false, "N": true, "G": false },
  "changed_this_tick": [
    { "addr": "0x4007", "symbol": "fib_data[7]", "before": 0, "after": 13 }
  ],
  "stack_depth": 0,
  "halted": false,
  "arch": "EML-VM64"
}
```

設計原則：每個欄位都有 raw 值和 symbolic 值並列。AI 代理可選擇讀取任一層，或兩層對照。`arch` 欄位區分 V1（`"EML-VM-16"`）與 V2（`"EML-VM64"`）。

---

## 五、EML-VM64 架構規格（V2 擴展）

### 5.1 V1 → V2 升級對照

| 元件 | V1 (EML-VM-16) | V2 (EML-VM64) |
|------|----------------|----------------|
| 地址空間 | 8-bit（256B） | 16-bit（64KB） |
| RAM | 256 bytes | 65536 bytes |
| 指令格式 | 定長 2-byte | 可變長 2/3/4 byte |
| PC / SP | 8-bit | 16-bit |
| 地址暫存器 | 無 | AR0–AR3（各 16-bit） |
| V1 相容性 | — | **完全相容**（V1 opcodes 不動） |

### 5.2 V2 新 ISA 擴展

**3-byte 擴展立即值（0x90–0x93）**
```
0x90  MOVI8  Rd, #imm8    Rd = imm8    (V1 MOVI 限 4-bit，V2 支援 8-bit)
0x91  ADDI8  Rd, #imm8
0x92  SUBI8  Rd, #imm8
0x93  CMPI8  Rd, #imm8
```

**地址暫存器操作（2/3/4-byte）**
```
0xA0  MOVW   ARn, #imm16  [4B] AR[n] = imm16
0xA1  LDAX   Rd, [ARn]    [2B] Rd = MEM[AR[n]]
0xA2  STAX   [ARn], Rs    [2B] MEM[AR[n]] = Rs
0xA3  INCAR  ARn          [2B] AR[n]++
0xA4  DECAR  ARn          [2B] AR[n]--
0xA5  ADDARI ARn, #imm8   [3B] AR[n] += imm8
0xA6  MOVARL Rd, ARn      [2B] Rd = AR[n] & 0xFF
0xA7  MOVARU Rd, ARn      [2B] Rd = AR[n] >> 8
0xA8  MOVARP ARn, Rd:Rd+1 [2B] AR[n] = (Rd<<8)|(Rd+1)
0xA9  ADDARS ARn, Rs      [2B] AR[n] += Rs
```

**16-bit 跳躍與呼叫（4-byte）**
```
0xB0–0xB6  JMP16/JZ16/.../JLE16  addr16
0xB7       CALL16  addr16    PUSH16(PC); JMP16
0xB8       RET16   [2B]      POP16(PC)
0xC0       PUSH16  ARn       push 16-bit AR to stack
0xC1       POP16   ARn       pop 16-bit from stack to AR
```

### 5.3 V2 記憶體分區

```
0x0000 – 0x3FFF  Code segment   16KB
0x4000 – 0x7FFF  Data segment   16KB
0x8000 – 0xBFFF  Heap           16KB（未來動態配置）
0xC000 – 0xDFFF  I/O mapped      8KB（未來裝置暫存器）
0xE000 – 0xFFFD  Stack           8KB（SP_INIT = 0xFFFE，向下增長）
```

### 5.4 V1 向後相容性

所有 V1 opcodes（0x00–0x81）在 V2 引擎中保持 2-byte 定長、相同語義。V1 JMP 的 8-bit arg 在 16-bit PC 空間自然解讀為 `0x00XX`——行為正確。`liftV1ToV2()` 工具函數可將 V1 ProgramDefinition 零修改搬入 V2 引擎。

---

## 六、模組架構與代理整合指南

### 6.1 完整代碼庫

| Phase | 檔案 | 行數 | 說明 |
|-------|------|------|------|
| P0 | `eml-vm16.jsx` | 492 | React 視覺化組件（磷光綠 CRT 介面） |
| P2 | `eml-vm16-core.ts` | 776 | VMCore — 純 TS，無 UI 依賴 |
| P3 | `eml-vm16-callable.ts` | 623 | CallableVM — ECC-1 呼叫慣例 |
| P4 | `eml-vm16-window.ts` | 831 | 多 VM 視窗系統 — 記憶體通道、序列化 |
| P5 | `eml-vm16-agent.ts` | 907 | AI 代理串流介面 — WS/SSE/in-process |
| P6 | `eml-vm64-core.ts` | 805 | EML-VM64 — 16-bit 地址空間架構 |
| — | `EML-EAI-2026-v0.2.md` | — | 本文件 |
| **合計** | | **4434** | |

### 6.2 模組依賴圖

```
eml-vm16-core.ts (P2)
    └── eml-vm16-callable.ts (P3)
            └── eml-vm16-window.ts (P4)
                    └── eml-vm16-agent.ts (P5)

eml-vm64-core.ts (P6)  ←── imports from P2 (base types only)

eml-vm16.jsx (P0)  ←── standalone React artifact (no TS imports)
```

依賴鏈為單向，無迴圈。P6 平行獨立，僅引入 P2 的基礎型別。

### 6.3 代理整合步驟（給整合 Agent）

**Step 1：驗證 P3 正確性**
```typescript
import { createCallableVM, PROGRAM_FUNCTIONS, DEFAULT_TEST_VECTORS, selfTest } from './eml-vm16-callable';
const vm = createCallableVM(PROGRAM_FUNCTIONS);
const results = await selfTest(vm, DEFAULT_TEST_VECTORS);
// 期望：14/14 pass — add(3,5)=8, fib_n(10)=55, 等
```

**Step 2：啟動 P4 Pipeline 示範**
```typescript
import { createPipeline, DEMO_PIPELINE_FIBCIPHER, buildProgramRegistry } from './eml-vm16-window';
import { PROGRAM_FIBONACCI, PROGRAM_XOR_CIPHER } from './eml-vm16-core';
const registry = buildProgramRegistry([PROGRAM_FIBONACCI, PROGRAM_XOR_CIPHER]);
const mgr = createPipeline(DEMO_PIPELINE_FIBCIPHER, registry);
mgr.runAll('NORM');
// FIBONACCI 寫入 0x2E–0x38 → 即時鏡射至 XOR_CIPHER 的 0x40–0x4A
// （INT 修正：fib 輸出區自 0x20 移至 0x2E，避開 46-byte 程式碼，消除自我改寫）
```

**Step 3：啟動 P5 Agent Server（Node.js + ws 套件）**
```typescript
import { WebSocketServer } from 'ws';
import { bootstrapWSServer } from './eml-vm16-agent';
const wss = new WebSocketServer({ port: 8765 });
bootstrapWSServer(wss, mgr, {
  onSession: s => console.log(`Agent connected: ${s.sessionId}`),
});
```

**Step 4：P5 In-Process 測試（無需網路）**
```typescript
import { createInProcessTransport, AgentClient, createSession } from './eml-vm16-agent';
const { agentSide, serverSide } = createInProcessTransport();
const session = createSession(serverSide, mgr);
const client  = new AgentClient(agentSide);
// 訂閱 fib-window，收集 10 個快照
await client.cmd({ type:'cmd:subscribe', config: {
  subId:'test-sub', windowId:'fib-window', mode:'on-change'
}});
await client.cmd({ type:'cmd:run', windowId:'fib-window', speed:'NORM' });
const snaps = await client.collectSnapshots('fib-window', 10);
```

**Step 5：V2 驗證**
```typescript
import { makeVM64State, stepN64, PROGRAM64_FIBONACCI, validateProgram64 } from './eml-vm64-core';
const { valid, warnings } = validateProgram64(PROGRAM64_FIBONACCI);
console.assert(valid, warnings);
let state = makeVM64State(PROGRAM64_FIBONACCI);
state = stepN64(state, 500);
// 期望：RAM[0x4000..0x400A] = [0,1,1,2,3,5,8,13,21,34,55]
const fibData = Array.from(state.memory.slice(0x4000, 0x400B));
console.assert(JSON.stringify(fibData) === JSON.stringify([0,1,1,2,3,5,8,13,21,34,55]));
```

**Step 6：整合 P0 React 組件**

`eml-vm16.jsx` 為獨立 React artifact，不 import 任何 TS 模組。整合時可選擇：
- 直接使用 JSX artifact（完整內嵌 VM 邏輯）
- 或以 P2 VMCore 重寫 React 組件，共享型別和執行引擎

### 6.4 整合決策（INT 階段已處理）

1. **P5 傳輸選擇** → *三者並存，WS 已端到端驗證*。WS、SSE、in-process 轉接器全部保留；in-process 與 **WebSocket 皆已實測**（`integration.ts` / `test-ws.ts`：welcome → subscribe → run → snapshot → call → serialize，全程走真實 socket）。部署時依需求選 WS（雙向）或 SSE+POST（單向）。
2. **P0 與 P2 整合策略** → ✅ *前端綁定 P2（單一引擎）*。`ui/`（Vite + React）直接 import P2 VMCore 驅動視覺化，並把 CTS 的 symbol／comment／region 即時渲染——「可見即可視」在介面上兌現。獨立的 `eml-vm16.jsx` 保留為參考 artifact；前後端同處一資料夾，部署時各自切出（前端靜態、後端 WS server）。
3. **P6 Window System V2 化** → ✅ *已實作*。`eml-vm64-window.ts` 提供 `Window64VM` + `VM64WindowManager` + 16-bit 記憶體通道（V1 視窗系統的 V2 對應）；已驗證兩個 VM64 視窗經 16-bit 通道於 64KB 空間鏡射 fib 資料（0x4000 → 0x5000）。
4. **CTS stringTable** → ✅ *已實作*。`buildStringTable(mem, start, end, minLen)` 掃描可列印 ASCII 區段並解碼為 Layer 4 條目。
5. **augmentCTSFromTrace()** → ✅ *已實作*。以執行軌跡 + 逐 tick 記憶體快照差分，動態還原靜態分析無法解析的 register-indirect 寫入者，補全 Layer 6 計算圖。

> **INT 階段亦修正了三個執行正確性錯誤**（詳見 `INTEGRATION.md`）：V1/V2 FIBONACCI 的迴圈終止 off-by-one（漏算 fib(10)）、V1 FIBONACCI 與 COUNTER 的程式碼／資料區重疊（自我改寫導致輸出損毀）、以及 P5 `cmd:call` 從未接通 CallableVM 的死路徑。這些錯誤先前未被發現，因為原型只讓執行「可見」（動畫），從未將投影 Φ 與真值核對——這正是本文 §四所述「可見即可視」命題在工程上必須兌現、卻最容易被略過的一步。

---

## 七、實作狀態總覽

| Phase | 內容 | 狀態 |
|-------|------|------|
| P0 | EML-VM-16 React 視覺化原型（256B，38 指令，CRT 磷光介面） | ✅ **完成** |
| P1 | CTS 型別系統（6 層介面定義） | ✅ **完成**（嵌入 P2） |
| P2 | VMCore 純 TS 模組（functional core + VMController） | ✅ **完成** |
| P3 | CallableVM（ECC-1 呼叫慣例，4 支可終止函數，selfTest） | ✅ **完成** |
| P4 | 多 VM 視窗系統（WindowVM+poke，記憶體通道，序列化，Pipeline） | ✅ **完成** |
| P5 | AI 代理串流介面（WS/SSE/in-process，AgentSession，Recorder/Replayer） | ✅ **完成** |
| P6 | EML-VM64（16-bit，64KB，可變長指令，V1 向後相容） | ✅ **完成** |
| INT | 最終整合（Agent 執行）：可執行化（tsx/tsc/vite）、33+6 端到端驗證、3 項執行正確性修正、stringTable + augmentCTSFromTrace + Window64VM 補全、WS 後端與 P2-bound 前端 | ✅ **完成** |

---

## 八、結論

「可見即可視」不是一個關於 UI 美學的主張，而是一個關於**程式本體論**的主張：程式碼在配備完整對應表的情況下，其執行過程天然具有視覺投影性。視覺化不是從外部加入程式的東西，而是從程式本身召喚出來的。

這個命題一旦成立，以下推論自然跟隨：

1. 除錯器作為獨立工具類別，將失去存在理由——執行本身就是除錯介面。
2. 程式碼審查可以部分由「執行視覺審查」取代。
3. AI 代理與程式的互動不再需要語言解析層——VM 狀態流是天然的共通語言。
4. 分散式函數呼叫在視覺上是多個 VM 視窗之間的資料流，可被人類與 AI 同時監控。

PHOSPHOR 是這個方向的最小可行基礎設施。它的目的不是做出一台完整的電腦，而是確立一個架構主張，並在可驗證的基底上實現它。

後續工作的核心問題只有一個：**對應表系統能走多深？**

當符號層足夠豐富，VM 狀態流就是語義圖。當語義圖夠完整，執行就是溝通。這是「程式碼可見化時代」的真正到來——不是更好的圖形介面，而是執行本身變成了語言。

---

*EveMissLab（一言諾科技有限公司）· PHOSPHOR · EML-EAI-2026-v0.2*
*unboundedaxiom.org*
