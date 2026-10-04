# PHOSPHOR
## 執行即介面（EAI）：機器碼視覺化基礎設施

**EML-EAI-2026-v0.4**
EveMissLab（一言諾科技有限公司）
作者：Neo.K（許筌崴）
發表日期：2026-06-11
版本說明：v0.4 更新——正式確立雙模式架構（Human / AI mode）；補充 AI mode
應用圖景；定義無頭 VM 規格與 EML-VM-BASIC；架構優先順序更新，P5 Agent Stream
升格為主線；預告 v0.5 語義↔機器碼對照工作。本版 EML-VM-BASIC、無頭 VM 工廠與
雙模式輸出已實作並驗證（`npm run verify:headless` → 23 passed），AI mode 輸出
已接上 phosphor-stream（每步為 `vm:tick`，HALT 為 `vm:halt`）。

---

## 摘要

PHOSPHOR 是一套以「執行即介面（Execution-as-Interface, EAI）」為核心主張的機器碼
視覺化基礎設施。v0.4 確立一個 v0.3 尚未明說的根本架構事實：**PHOSPHOR 有兩個平行
的使用者，不是一個。**

Human mode 輸出磷光綠 UI，供人類觀察；AI mode 輸出無頭執行的狀態事件串流，供 AI
代理訂閱。兩個模式共享同一個 VM Core，但輸出層完全解耦。AI mode 是 PHOSPHOR 應用
潛力最大的模式，覆蓋監控、除錯、轉譯、狀態驗證、AI-to-AI 協作等場景。

v0.4 同時引入 **EML-VM-BASIC**——一個參數化有界整數算術 VM，預設範圍 0–10000，
無乘除法，為 AI mode 提供最乾淨的最小可讀執行單元。

---

## 一、問題陳述（不變，詳見 v0.3）

---

## 二、EML-VM-16 架構規格（不變，詳見 v0.3）

---

## 三、對應表系統（CTS）（不變，詳見 v0.3）

---

## 四、執行即介面範式（EAI）（不變，詳見 v0.3）

---

## 五、EML-VM64 架構規格（不變，詳見 v0.3）

---

## 六、【NEW】雙模式架構：Human Mode / AI Mode

### 6.1 架構定義

PHOSPHOR 的 VM Core 是模式無關的（mode-agnostic）。輸出層決定使用模式：

```
VM Core（執行引擎，共享）
    ├── Human Mode Output
    │     P0 React UI（磷光綠 CRT 視覺化）
    │     互動式，適合人類觀察與教學
    │
    └── AI Mode Output
          P5 Agent Stream（WS/SSE 事件串流）
          無頭執行，最大吞吐量，適合 AI 代理訂閱
```

兩個模式不是主副關係。Human mode 是 AI mode 的一個可選視覺化蓋層。

**正式定義：**

> Human mode：VM 執行狀態投影為人類可讀的視覺表示（Φ : M × CTS → V_human）。  
> AI mode：VM 執行狀態投影為 AI 可解析的結構化事件串流（Φ : M × CTS → V_AI）。  
> 兩者的 Φ 共享同一個狀態機 M，但值域 V 不同。

### 6.2 架構優先順序（v0.4 更新）

v0.3 把 P5 Agent Stream 視為配件，P0 Visualization 為主線。v0.4 修正：

| 元件 | v0.3 定位 | v0.4 定位 |
|------|---------|---------|
| P5 Agent Stream（WS/SSE） | 可選配件 | **主線** |
| P0 Visualization（React UI） | 主線 | 可選輸出層 |
| VM Core（P2 VMCore） | 共享引擎 | 共享引擎（不變） |

理由：後台 AI mode 是 PHOSPHOR 最高頻率的實際使用場景。Human mode 是調試和教學的
觀察窗口，有價值但不是必需品。

---

## 七、【NEW】AI Mode 應用圖景

### 7.1 六個應用場景

**1. 監控模式（Monitoring）**
AI 代理訂閱 VM 執行事件流，實時監控系統狀態。不介入執行，只觀察。

```
VM_A running program_X
    ↓ VMSnapshot stream (P5 WS)
AI Monitor → detect anomaly → alert / log / escalate
```

**2. 除錯模式（Debugging）**
AI 從執行軌跡（trace + memory diff）定位 bug，不需要 source code。
PHOSPHOR 的 crossRefTable 提供因果鏈，AI 可追溯「誰寫了這個地址」。

**3. 轉譯模式（Translation）**
VM 作為中間表示層（IR）。AI 把一種格式的計算轉為另一種：
- EML 符號態 ↔ Python 執行態
- 高精度計算結果 ↔ 標準浮點表示
- 人類可讀指令 ↔ 最優機器碼序列

**4. 狀態驗證模式（State Verification）**
AI 驗證 VM 執行後的記憶體狀態是否符合預期規格。

```
Spec: RAM[0x20..0x2A] = fib(0..10)
Actual: VMSnapshot.memory[0x20..0x2A]
AI: verify(spec, actual) → PASS / FAIL + diff
```

**5. AI-to-AI 協作模式**
多個 AI 代理透過共享 VM 狀態協作，一個代理寫入記憶體，另一個讀取並繼續計算。
PHOSPHOR 的 MemoryChannel（P4）在多 AI 場景下成為協作匯流排。

**6. EML 協作模式**
AI 讀取 EML 程式碼的執行流，根據執行模式建議壓縮、偵測冗餘、生成修復 patch。
這是 EML + PHOSPHOR 閉環的具體實現。

### 7.2 AI mode 的設計原則

1. **事件流優先**：每個 VM 步驟都生成一個 VMSnapshot，AI 消費事件流而非輪詢狀態
2. **CTS 語義層隨附**：每個 snapshot 帶 symbolic 和 raw 雙層資訊，AI 選擇讀哪層
3. **最小無頭啟動**：AI mode VM 無需 UI 依賴，純 Node.js 環境即可跑
4. **吞吐量最大化**：AI mode 下移除 flash 效果、log 截斷，最大化每秒 snapshot 輸出

---

## 八、【NEW】無頭 VM 規格（Headless VM）

### 8.1 定義

無頭 VM 是 PHOSPHOR 在 AI mode 下的標準執行形態：

- 無 P0 UI（不啟動 React，不渲染）
- P5 Agent Stream 為唯一輸出
- 最大步驟速率（TURBO 預設，可調）
- 可透過 CLI 啟動或從程式碼引入

### 8.2 啟動規格

```typescript
// 程式碼引入
import { createHeadlessVM } from 'phosphor';

const vm = createHeadlessVM({
  program:   PROGRAM_FIBONACCI,
  mode:      'ai',           // 'ai' | 'human'
  speed:     'TURBO',
  maxSteps:  100_000,
  onSnapshot: (snap: VMSnapshot) => {
    // AI 消費每一個執行步驟
    aiAgent.process(snap);
  },
  onHalt: (finalSnap) => {
    // VM 終止
  },
});

vm.run();

// CLI 啟動（後台）
// phosphor run --mode ai --program fibonacci --ws-port 8765
```

### 8.3 輸出格式

無頭 VM 的輸出是 VMSnapshot 序列，格式與 v0.3 §5.4 定義一致，新增 `mode` 欄位：

```json
{
  "mode": "ai",
  "vm_id": "fib-headless-001",
  "tick": 42,
  "pc": "0x1A",
  "pc_symbol": "LOOP",
  "instruction": "ADD R2, R1",
  "registers": { "R0": 3, "R1": 5 },
  "changed_this_tick": [
    { "addr": "0x2E", "symbol": "fib_data[2]", "before": 0, "after": 1 }
  ],
  "halted": false,
  "arch": "EML-VM-16"
}
```

---

## 九、【NEW】EML-VM-BASIC 規格

### 9.1 設計目標

EML-VM-BASIC 是 PHOSPHOR VM 家族的最小成員，針對 AI mode 設計：

- **有界整數算術**：範圍 [0, N]，預設 N=10000，參數化（可調至任意正整數）
- **無乘除法**：移除 MUL/DIV 指令，執行圖更簡單，AI 解析負擔最低
- **最小指令集**：只保留 ADD、SUB、CMP、JMP 條件族、LD/ST、HALT
- **乾淨狀態流**：每步狀態確定性強，無浮點歧義，AI 模式識別最可靠

### 9.2 值域：有界整數 BOUNDED-INTEGER [0, N]

EML-VM-BASIC 的值域是一個**有界整數型別（BOUNDED-INTEGER cell）**，範圍 [0, N]，
**不是字面上的 u8**。這一點是 BASIC 與 EML-VM-16 的根本差異，必須明說：

> 每個暫存器 / 記憶體單元持有的是 [0, N] 區間內的一個整數，預設 N=10000。
> 它沿用 EML-VM-16 的 ISA（指令解碼、定址、條件分支完全相同），但單元寬度
> 是「能裝下 N」的寬整數，而非硬體 u8（[0,255]）。

具體區別：

| 面向 | EML-VM-16 | EML-VM-BASIC |
|------|-----------|--------------|
| 值域 | u8 [0,255]（硬體位元組） | bounded int [0,N]，N 預設 10000（N≫255） |
| 單元儲存 | `Uint8Array`（記憶體 / 暫存器） | `Int32Array`（寬單元，裝得下 N） |
| 溢位行為 | `& 0xFF`（固定 wrap u8） | 預設 **wrap mod (N+1)**，可設 clamp / throw |
| 指令集 | 完整 ISA（含邏輯、堆疊…） | MNEMONIC 白名單（ISA 子集） |
| 定址 | 8-bit（256 單元） | 8-bit（256 單元，沿用——暫存器當地址時 `& 0xFF`） |

**溢位政策（overflow policy）**：算術結果離開 [0, N] 時，由單一收斂點 `bound()`
依政策映射回值域，政策三選一：

- `wrap`（**預設**）：模算術 over (N+1)，正規化為非負——`bound(13, 10, 'wrap') === 2`。
- `clamp`：飽和到 [0, N]——`bound(13, 10, 'clamp') === 10`、`bound(-3, 10, 'clamp') === 0`。
- `throw`：任何越界值拋出 `ConstraintViolation`（kind=`overflow`），用於要求嚴格不溢位的場景。

值域是「能裝下 N 的寬整數」這一事實是可驗證的：內建程式 `PROGRAM_BASIC_SUM`
以計數迴圈算出 R0 = 300——一個 **> 255 的值，u8 單元裝不下**——正是寬有界整數
單元存在的證明（見 §12 驗證）。

### 9.3 與 EML-VM-16 的關係

EML-VM-BASIC 不是獨立架構，是 EML-VM-16 的一個受限模式：它**重用 VM-16 的 ISA**
（指令解碼、定址、條件分支），只是把值域換成有界整數、把可用指令限制成一個
MNEMONIC 白名單。受限由兩層構成：靜態（`validateProgramConstraints` 預先掃描程式碼，
任何不在白名單的助憶碼回報為 violation）與動態（`stepOnceBasic` 執行到不允許的
opcode 時拋出 `ConstraintViolation`，kind=`op`）。

```typescript
const basicVM = createHeadlessVM({
  program: myProgram,
  constraints: {
    maxValue:    10_000,   // 上界 N（可調）
    overflow:    'wrap',   // 'wrap'（預設）| 'clamp' | 'throw'
    allowedOps:  ['ADD','ADDI','SUB','SUBI','CMP','INC','DEC',
                  'JMP','JZ','JNZ','JG','JL','JGE','JLE',
                  'LD','ST','MOV','MOVI','HALT','NOP'],
    // 未列入的 ops（MUL、DIV、AND、OR、XOR 等）若出現則拋出 ConstraintViolation
  },
});
```

### 9.4 參數化擴充

N 可以按需調整，不改變架構：

| N 值 | 用途 |
|------|------|
| 10,000 | 預設基本版，計數/索引場景 |
| 100,000 | 中型資料索引 |
| 1,000,000 | 大型計數，需 20-bit 表示 |
| 任意正整數 | 視 AI 任務需求動態設定 |

### 9.5 AI mode 的價值

有界算術是 AI 最容易正確解讀的計算格式：
- 狀態空間有限 → AI 的解讀確定性高
- 無乘除 → 執行圖是線性或分支結構，無指數爆炸
- 上界明確 → AI 可以對「值的意義」做更強的假設（如：這個值是索引、計數、還是物理量）

---

## 十、VM 家族總覽（v0.4 更新）

| VM 類型 | 地址空間 | 資料型別 | 指令集 | 主要用途 |
|---------|---------|---------|--------|---------|
| EML-VM-BASIC | 8-bit（256B） | 有界整數 [0,N]（預設 N=10000） | 最小子集（無乘除） | AI mode 乾淨執行基底 |
| EML-VM-16 | 8-bit（256B） | u8（0–255） | 完整 28 條 | 原型可視化、教學 |
| EML-VM-64 | 16-bit（64KB） | u8 + AR 16-bit | 完整 V2 ISA | 大地址空間、生產用途 |
| EML-VM-F32 | TBD | f32（IEEE 754） | TBD | 浮點計算、科學場景 |
| EML-VM-F64 | TBD | f64 / 自訂高精度 | TBD | 反向無窮精度場景 |

EML-VM-F32 和 EML-VM-F64 的完整規格在 v0.5 定義（涉及語義↔機器碼對照問題）。

---

## 十一、模組架構與整合（v0.4 更新）

### 11.1 代碼庫

（繼承 v0.3 §六.一，新增：）

| Phase | 檔案 | 說明 |
|-------|------|------|
| INT+ | `eml-vm-basic.ts` | EML-VM-BASIC 受限模式：有界整數值域 [0,N]、`bound()` 溢位政策、靜態 `validateProgramConstraints` + 動態 `ConstraintViolation`、內建 `PROGRAM_BASIC_SUM` |
| INT+ | `headless-vm.ts` | 無頭 VM 工廠 `createHeadlessVM`（ai/human 雙模式，VM-16 與 BASIC 共用）+ CLI 入口；AI mode 輸出接上 phosphor-stream（每步 `vm:tick`，HALT `vm:halt`） |
| INT+ | `test-headless.ts` | v0.4 驗證 harness：`npm run verify:headless` → 23 passed |

AI mode 的事件輸出走既有的 **phosphor-stream** 可攜標準（`stream/phosphor-stream.ts`）：
`createHeadlessVM` 接受一個 `Emitter`，每個 tick 發出一筆 `vm:tick` 事件、HALT 發出
`vm:halt`；下游可用 `memorySink` 收集、`findAnomalies` 偵測異常、`emitter.check` 做
狀態驗證（intent vs actual），無需另立輸出協定。

### 11.2 架構圖（v0.4 更新）

```
                    VM Core（共享）
                   /              \
        Human Mode               AI Mode（主線）
             |                        |
        P0 React UI            P5 Agent Stream
     磷光綠 CRT 視覺化          WS/SSE 事件串流
      （可選，調試/教學）         （必選，生產用途）
```

---

## 十二、實作狀態總覽（v0.4 更新）

| 項目 | 狀態 |
|------|------|
| P0–P6 全部 Phase | ✅ |
| INT 整合（33+6 pass，typecheck 0） | ✅ |
| PHOSPHOR.exe | ✅ |
| 雙模式架構（定義 + 實作） | ✅ v0.4（`createHeadlessVM` ai/human 雙路徑，驗證通過） |
| EML-VM-BASIC 規格 + 實作 | ✅ v0.4（`eml-vm-basic.ts`：有界整數 [0,N] + 溢位政策 + 約束引擎；R0=300 證明寬單元） |
| 無頭 VM 工廠 | ✅ v0.4（`headless-vm.ts`：`createHeadlessVM` + CLI；AI mode 輸出接上 phosphor-stream `vm:tick`） |
| `npm run verify:headless` | ✅ 23 passed（headless + BASIC 全綠） |
| EML-VM-F32 / F64 | 📋 v0.5 規格 |
| 語義↔機器碼對照（語義層） | 📋 v0.5 主題 |

---

## 十三、v0.5 預告：語義↔機器碼對照

v0.5 的核心工作是定義 **語義層（Semantic Layer）**：對 EML-VM ISA 的每一條指令，
建立從機器碼到語義行為的正式映射。

這比 CTS 的符號表更深一層：

| 層級 | 現有 | v0.5 新增 |
|------|------|---------|
| 語法層 | opcodeTable（助憶碼） | — |
| 名稱層 | symbolTable（符號名稱） | — |
| 語義層 | commentTable（非正式注解） | **正式狀態轉換規格** |
| 推論層 | crossRefTable（靜態分析） | **語義等價類判定** |

v0.5 的語義↔機器碼對照將採用 Hoare 邏輯或操作語義（operational semantics）形式化
每條指令的前置條件、後置條件與狀態轉換。目標：

1. 給定一段機器碼，AI 可以正式推論其「做了什麼」（不只是「執行了什麼」）
2. 給定一個語義規格，系統可以生成或驗證對應的機器碼序列
3. 判定兩段機器碼是否語義等價（不同位元組，相同效果）

這是 PHOSPHOR「可見即可視」命題在語義層的完整實現。

---

## 十四、結論（v0.4 更新）

v0.4 確立了 PHOSPHOR 的真實應用定位：不只是視覺化工具，而是讓任何計算對 AI 可讀
的執行基底。Human mode 是教學和調試的觀察窗口；AI mode 是 PHOSPHOR 最高頻率的
生產使用場景。

應用潛力的重心在：

1. **監控**：AI 實時讀取任何計算的執行狀態
2. **轉譯**：VM 作為格式無關的中間表示層
3. **協作**：多 AI 代理透過共享 VM 狀態完成複雜任務

這個定位與 EML 的設計哲學完全吻合——EML 本來就是給 AI 看的語言，PHOSPHOR 本來
就是讓 AI 能看到執行的基礎設施。兩者的閉環在 v0.5 的語義層工作完成後將更加完整。

---

*EveMissLab（一言諾科技有限公司）· PHOSPHOR · EML-EAI-2026-v0.4*
*unboundedaxiom.org*
