### XML 標籤格式

#### 1. `<save file="檔名" context="路徑">`
定義目標檔案與節點路徑：
- **`file`**: 完整檔案名稱（如 `{{FILE_CHARACTER_STATUS}}`）
- **`context`**: **必須**是原檔案中**已存在**的標題字串，包含 `#` 符號、空格、`**` 粗體標記
- 層級使用 ` > ` 分隔（如 `# 核心人物 > ## 程楊宗`）
- 若針對檔案頂層操作，設為空字串 `""`
- **禁止**將尚不存在的新標題填入 `context`

#### 2. `<update>` 
包裹一個原子更新，一個 `<save>` 內可有多個 `<update>`

#### 3. `<target>` [選填]
欲替換的原文內容，必須與原檔案內容完全一致（包含縮排與符號）
- **連續性原則**: 內容必須是原檔案中**完整且連續**的一段
- **效率原則**: 每個 `<update>` 應只包含**需要變更的最小範圍**
- 若省略此標籤，代表在 `context` 節點末尾**追加**內容
- **參考範本排除**: 任何 `## 存檔格式` 程式碼區塊內的內容皆為 XML 格式說明文件，**非**實際資料。**禁止**作為 `<target>` 引用，**禁止**進行編輯。新增條目時應使用「新增」操作（省略 `<target>`），目標指向 `## 存檔格式` 同層的章節節點

#### 4. `<replacement>`
新的內容

### 操作類型
- **替換**: 同時提供 `<target>` 與 `<replacement>`
- **新增**: 僅提供 `<replacement>`，追加到節點末尾
- **刪除**: 僅提供 `<target>` 且不提供 `<replacement>`（或提供空 `<replacement></replacement>`）
- **全檔案替換**: `context=""` 且無 `<target>`

### 新增條目的正確格式
若要新增新的標題條目（如新角色），`context` 應指向**父節點**（已存在的標題），新標題必須寫在 `<replacement>` 內：
```xml
<!-- ✓ 正確：新增角色到現有分類 -->
<save file="{{FILE_CHARACTER_STATUS}}" context="# 核心人物">
  <update>
    <replacement>
## 新角色名稱
- **身份**: xxx
    </replacement>
  </update>
</save>
```

### 範例
```xml
<save file="{{FILE_CHARACTER_STATUS}}" context="# 核心人物 > ## 程楊宗">
  <update>
    <target>
      - **最後已知位置**: 辦公室
    </target>
    <replacement>
      - **最後已知位置**: 餐廳 (08:30)
    </replacement>
  </update>
</save>
```
