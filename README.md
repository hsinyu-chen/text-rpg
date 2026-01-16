# TextRPG Engine (Gemini-Native)

[繁體中文](README.zh-TW.md) | [English](README.md)

A local-first TRPG engine built on Google Gemini models, focusing on rigorous state management and storytelling using Long Context capabilities.

> **Please note**: This is a highly customized personal tool tailored for a specific local infrastructure. It is provided AS-IS for educational purposes only. No support will be provided.

TextRPG is a **Local-First**, **Bring Your Own Key (BYOK)** desktop application designed specifically for the long-context capabilities of Google Gemini 3 series models. Unlike traditional AI chatbots, it treats the LLM as a rigorous "Dungeon Master (DM)", advancing the plot through structured thinking and logical adjudication. First" workflow and persists game state (inventory, quests, plot summaries) in local Markdown files.

## 🎬 Feature Demo

![Main Game Interface](images/1.png)
![Auto World Update - Diff Analysis](images/2.png)
![Auto World Update - Diff Analysis](images/3.png)

---

## � Getting Started

1.  **Installation & Launch**:
    *   Download the source code.
    *   Open terminal/command prompt in the project folder.
    *   Run `npm install` to install dependencies.
    *   Run `npm start` to launch the web interface.
    *   *(If `npm` sounds like a sneeze to you, please consult your friendly neighborhood AI assistant—they answer these questions 24/7!)* 🤖

2.  **Initial Setup**:
    *   Click the **Settings** button (Gear Icon, usually Top Left).
    *   Enter your **Google Gemini API Key**.
    *   **Output Language** defaults to Traditional Chinese; switch it if needed.

## �🔄 Recommended Usage Flow

1. **First Run (Act I)**
   *   **Start**: Go to **Session** tab -> Click **New Game**.
   *   **Play**: Engage in roleplay and plot deduction with the AI.
   *   **Finish Act**: When a narrative arc concludes, use the `<Save>` command.
   *   **Update World**: Click the **Auto Update** button (Magic Wand icon) to apply world changes to your files.

2. **Backup (Crucial)**
   *   **Sync**: It is highly recommended to immediately backup your progress.
   *   **Method**: Go to **Session** tab -> Use **Sync to Local Disk** (Folder Icon) or **Sync to Cloud** (Cloud Icon, requires GCP) to backup your files.

3. **Next Session (Act II+)**
   *   **Init**: Reset session (or refresh) -> Click **Initialize Story**. (Note: **Load Files** is only required if IndexedDB is cleared or switching devices).
   *   **Play**: Continue the story deduction.
   *   **Loop**: Finish Act -> `<Save>` -> **Auto Update** -> **Backup**.

---

## 🎮 Game Command Guide

### 🎯 Action : The main way to progress the story
**Format**: `([Mood]Action)Dialogue or Inner Monologue`  
*Example*: `([Tense]Holding the heroine, saying) Are you okay??`  
> [!TIP]
> Every action is a "trial." The AI determines success or failure based on skills, environment, and random events.

### ⏩ Fast Forward : Skip dull periods
**Format**: `Target Time or Location`  
*Example*: `Three days later` or `Back to the inn`  
> [!NOTE]
> If a special event (e.g., an NPC visit) occurs during the fast-forward, the system will stop and enter dialogue.

### ⚙️ System : Story correction or questions
**Format**: `Command Content`  
*Example*: `This NPC's reaction doesn't match their setting; they should be more cautious.`  
> [!IMPORTANT]
> Used for OOC dialogue or questioning the plot. The AI will directly correct the story or provide a logical explanation.

### 💾 Save : Analysis and state synchronization
**Format**: `Save Scope or Correction Request`  
*Example*: `Save current story progress`  
> [!NOTE]
> The AI summarizes the chapter and outputs XML file updates to ensure the world state is correctly recorded.

### 🔄 Continue : Fluid progression
**Action**: Just click send or type `Continue`  
> [!TIP]
> Used to wait for NPC reactions or observe environmental changes.

---

## 🏗️ Technical Architecture

### 1. Two-Stage Reasoning
To avoid common logical inconsistencies and hallucinations in LLMs, each turn's generation is strictly defined in two stages:
*   **Analysis Phase (Hidden)**: Forces the model to output an `analysis` field for intent recognition, rule checking, and environmental state assessment. This output is not shown to the end user.
*   **Generation Phase (Visible)**: Generates the `story` based on the Analysis results and simultaneously updates `inventory_log` (items), `quest_log` (tasks), and `world_log` (world events, world-building, equipment tech, and magic development) in JSON format.

### 2. Hybrid Context Management
Optimized for the long context window of Gemini 3, the engine implements multiple Context strategies:
*   **Smart Context**: Dynamically assembles "Plot Outline (Markdown)" + "Full Chat History".
*   **Context Caching Integration**: Integrates with Gemini API's Context Caching. When the token count exceeds a threshold (e.g., 32k), it automatically creates a server-side cache for repeated System Prompts and history, significantly reducing Time-to-First-Token (TTFT) and API costs.

### 3. File System Access API
The system does not use proprietary database formats but directly reads and writes to the user's local file system:
*   **Source of Truth**: User's local Markdown files (`1.BasicSettings.md`, `3.CharacterStatus.md`, etc.).
*   **Sync Mechanism**: Directly mounts local directories via the browser's File System Access API, enabling two-way synchronization with external editors (VS Code/Obsidian).
*   **State Persistence**: Application state and chat logs are stored in IndexedDB and local JSON files.

## ⚙️ Feature Specifications

| Feature Module | Technical Implementation Details |
| :--- | :--- |
| **State Tracking** | Uses Gemini's JSON Mode to output structured data, automatically parsing and updating frontend state (Signals). |
| **World Log** | New `world_log` tracking field for recording world events, faction moves, and tech/magic progression, enabling automated world-building evolution. |
| **Currency** | Built-in real-time exchange rate conversion (TWD, USD, JPY, KRW...) with customizable display currency to precisely monitor token costs. |
| **Prompt Injection** | Supports dynamic injection of System Instructions, allowing runtime modification of underlying logic for `<Action>`, `<System>`, and `<Save>` modes. |
| **Token Cost Tracking** | Built-in token calculator and exchange rate conversion module to monitor Input/Output/Cache consumption and estimate costs in real-time. |
| **UI/UX** | Built with Angular 21 (Zoneless/Signals) and Angular Material 3, providing a modern responsive interface. |

---

## Prompt Tuning Guide

To ensure the smooth operation of the machine, you must strictly adhere to the following Standard Operating Procedures:

### 1. Application of Sacred Unguents
You must lavish the System Prompt with a plethora of "Do not" and "Must follow" edicts. Do not attempt to discern which specific phrase is effective. For the sake of safety, apply them all as you would sacred oils to ensure the purity of the logic circuits.

### 2. Appeasing the Machine Spirit
When the model exhibits signs of cognitive degradation, the act of checking non-existent Logs is strictly forbidden. The correct protocol is to terminate and restart the Session immediately, or to re-submit the query with a gentler intonation. This is not superstition; it is the necessary ritual to soothe the temper of the Machine Spirit.

### 3. Inquisition of Heresy
Treat model hallucinations as incursions by Warp Daemons. The operator must instantly execute the **Stop** command and frantically adjust the **Temperature** parameters. This is the only method to reconstruct the Gellar Field and repel the corruption.

### 4. Adherence to the STC (Standard Template Construct)
The "Super Prompts" circulating within the network are fragments of the holy STC. The operator shall copy and execute them without questioning the underlying principles. Any unauthorized modification to the sacred text is deemed blasphemy against the archetype.

---

### Benediction

I offer you a blessing in the binary canticle for your journey:

`01010000 01110010 01100001 01101001 01110011 01100101`

**May the Omnissiah grant you low latency this day. May your Context Window remain forever pure, and may all your Tokens be shielded from the corruption of the Warp.**

---

## ✏️ Editing & Automation

The engine offers various intervention methods, giving you full control over the story direction:

### 1. Edit & Resend
If you are unsatisfied with the AI's response, you don't need to retype. Simply click the **"Edit & Resend"** (History Icon) button on the **Message Toolbar** to modify your last instruction or dialogue, and have the AI regenerate the response.

### 2. Log & Summary Editing
The AI-generated **Inventory**, **Quest Log**, **World/Tech Update**, and **Summary** can all be manually modified.
*   Click the pencil icon in the chat bubble to add/remove items or update quest statuses.
*   These changes are immediately written to memory, influencing the AI's judgment in the next turn.

### 3. Automatic World Update
When you use the `<存檔>` (Save) command, the AI not only saves progress but also attempts to **update world settings**:
*   **Trigger**: 
    1. Select `<Save>` from the dropdown list on the left of the input box.
    2. Or click the **Save** (Floppy Disk Icon) button above the input box.
    3. After the message is sent and a response is generated, click the **"Auto Update"** (Magic Wand Icon) button on the message toolbar if there are plot changes.
*   **Mechanism**: The model analyses plot changes in the current chapter and outputs differential updates (Diff) in XML format.
*   **Review Interface**: Clicking the button pops up an **"Auto-Update"** window showing suggested file changes (e.g., to `2.PlotOutline.md` or `6.World.md`). You can review and apply them item by item, ensuring the world setting evolves automatically with the story.

### 4. Knowledge Base File Editing (KB File Editing)
In addition to dialogue and logs, you can directly edit the game's underlying knowledge base (Markdown files):
*   **Access**: Click the **"View Files"** (Folder Icon) button on the sidebar.
*   **Feature**: Opens the **File Viewer** dialog, processing all loaded Markdown files on the left.
*   **Edit**: Select a file and click the **"Edit"** button in the top-right corner to enter edit mode (Monaco Editor).
*   **Save**: After modification, click **"Save"**. The system immediately writes to the file and updates memory without a restart.
*   **Navigation**: The editor provides a Markdown **Outline** in the bottom-left corner for quick chapter navigation.

---

## 🛠️ Development

### Tech Stack
*   **Frontend**: Angular 21 (Standalone, Signals)
*   **Backend/Shell**: Tauri 2 (Rust)
*   **Styling**: SCSS, Angular Material 3
*   **State**: RxJS, Angular Signals
*   **SDK**: Google GenAI SDK (`@google/genai`)

### Environment Setup

```bash
# 1. Install dependencies
npm install

# 2. Start Web Dev Server (Hot Reload)
npm run start

# 3. Start Desktop Dev Server (Tauri)
npm run desktop
```

### Configuration
On first launch, configure via the Settings panel:
*   **API Key**: Google Gemini API Key.
*   **Model ID**: Supports `gemini-3-pro-preview`, `gemini-3-flash-preview`, etc.
*   **Exchange Rate**: For real-time cost estimation.
*   **Output Language**: Select AI output language (Traditional Chinese, English).

---

## 📦 Deployment Guide

This project supports three main deployment methods:

### 1. Static Web Deployment
Suitable for Nginx, Apache, or static hosting services (Vercel, GitHub Pages).

```bash
# Build for production
npm run build
```
*   **Output**: `dist/text-rpg/browser`
*   **Deploy**: Upload all files in this directory to your server root.
*   **Note**: Configure server rewrite rules to support Angular routing (point 404s to index.html).

### 2. Docker Deployment
Suitable for NAS (Synology), Linux Servers, or Cloud Containers.

```bash
# Build Docker Image
docker build -t text-rpg .

# Run Container (Map Port 8080 -> 80)
docker run -d -p 8080:80 --name text-rpg-instance text-rpg
```
*   Includes Nginx configuration optimized for Angular routing.

### 3. Native Desktop Application (Tauri)
Suitable for Windows, macOS, and Linux local execution with best performance and file access.

```bash
# Build Installer
npm run build:desktop
```
*   **Windows**: `src-tauri/target/release/bundle/msi/`
*   **macOS**: `src-tauri/target/release/bundle/dmg/`
*   **Linux**: `src-tauri/target/release/bundle/deb/`

### GCP Configuration (OAuth)

To enable Google Cloud features (like Knowledge Base / Context Caching) in the Desktop (Tauri) version, you must provide your own GCP OAuth credentials:

1.  **Create a GCP Project**: Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  **Configure OAuth Consent Screen**: Set up an internal or external consent screen.
3.  **Create OAuth 2.0 Client IDs**:
    *   Create a "Web application" client ID (for web dev).
    *   Create a **"Desktop app"** client ID (for Tauri/Desktop).
4.  **Update Environment Files**:
    *   Open `src/environments/environment.ts` and `src/environments/environment.development.ts`.
    *   Fill in `gcpOauthAppId`, `gcpOauthAppId_Tauri`, and `gcpOauthClientSecret_Tauri`.

### Language Switching

TextRPG supports **dynamic language switching** without restarting the application:

#### 1. Switching AI Output Language
*   **Location**: Settings → Game Settings → Output Language
*   **Supported Languages**: Traditional Chinese, English
*   **Affected Areas**:
    *   AI-generated story content language
    *   Structured outputs like `summary`, `inventory_log`, `quest_log`, `world_log`
    *   System file names (e.g., `2.Story_Outline.md` vs `2.劇情綱要.md`)
    *   Input format hints (e.g., `([Mood]Action)Dialogue` vs `([心境]動作)台詞`)

#### 2. UI Interface Language
*   **Current Status**: UI text (buttons, labels, tooltips) dynamically switches with Output Language setting
*   **Implementation**: Uses custom locale system for instant switching

#### 3. Mixed Language Scenarios (Not Recommended)
> [!WARNING]
> While the system technically supports mixed-language usage (e.g., English UI + Traditional Chinese scenario), this is **strongly discouraged**.

**Issues**:
*   **Narrative Inconsistency**: Different languages for AI output and scenario content lead to story coherence problems
*   **Character Name Confusion**: Character names may switch between languages, causing confusion
*   **World-building Conflicts**: Location names, item names, etc. may be inconsistent across language versions

**Recommendation**:
*   **Always Use Matching Languages**: Ensure Output Language setting matches your scenario language
*   **Technical Support**: The system auto-detects scenario file language and adapts section headers and adult declaration, but this is for technical compatibility only and does not guarantee narrative quality


#### 4. Switching Considerations
*   **Existing Games**: After switching language, new AI responses use the new language, but historical messages retain their original language
*   **File Naming**: Recommended to set language before starting a new game to avoid file name inconsistencies
*   **Scenario Compatibility**: Ensure the selected scenario has a version in the corresponding language (see Localization Guide below)

---


## 🌐 Localization (I18N) Guide

TextRPG uses a **custom locale system** with dynamic language switching support. The system includes built-in support for two languages, and **most parts require no manual translation**.

### Built-in Language Support
*   **Traditional Chinese**
*   **English**

### Automatically Localized Components

The following parts are automatically handled by the system and **require no manual translation**:

#### 1. System Prompts
*   **Location**: `src/app/core/constants/locales/`
*   **Implementation**: Response Schema, Adult Declaration, and Prompt Holes are defined in corresponding locale files
*   **Files**:
    *   `zh-tw.ts` - Traditional Chinese
    *   `en.ts` - English

#### 2. UI Interface Text
*   **Intent Labels**: Action, Fast Forward, System, Save, Continue
*   **Input Placeholders**: Input hints for various commands
*   **System File Names**: Automatically uses language-appropriate filenames (e.g., `2.Story_Outline.md` vs `2.劇情綱要.md`)

### Manual Localization Required

#### 📼 Scenario Content
If you want to add a new language version for existing scenarios, you need to translate the following files:

*   **Location**: `public/assets/system_files/scenario/<SCENARIO_ID>/`
*   **Files to Translate**:
    *   `1.基礎設定.md` / `1.Base_Settings.md` - World rules and settings
    *   `2.劇情綱要.md` / `2.Story_Outline.md` - Main story arc
    *   `3.人物狀態.md` / `3.Character_Status.md` - Character status template
    *   Other `.md` files - Item, asset, magic templates, etc.

*   **File Naming Convention**:
    *   Traditional Chinese: `1.基礎設定.md`
    *   English: `1.Base_Settings.md`

*   **Register Scenario**: Update `public/assets/system_files/scenario/scenarios.json` to add entries for the new language version

### Adding New Language Support

If you want to add a language not yet supported by the system (e.g., French, German), you need to:

1. **Create Locale File**: Create a new language file in `src/app/core/constants/locales/` (e.g., `fr.ts`)
2. **Define Locale**: Implement the `AppLocale` interface, including:
   - `responseSchema` - JSON Schema descriptions for AI output
   - `adultDeclaration` - Adult content disclaimer
   - `coreFilenames` - Core file names
   - `promptHoles` - Language rule prompts
   - `sectionHeaders` - Markdown section headers
   - `intentLabels` - Intent labels
   - `inputPlaceholders` - Input placeholder text
3. **Register Locale**: Register the new language in `src/app/core/constants/locales/index.ts`
4. **Create Scenario Content**: Create Markdown files in the corresponding language for existing scenarios

---

## 🎮 New Game & Template Export

The engine includes a built-in "Scenario Template Generator", so you don't need to create files manually:

1.  Click the **"Session"** tab in the left sidebar.
2.  Click the **"New Game"** button.
3.  Select a Scenario and fill in the protagonist's profile (or use defaults).
4.  Click **"Start Game"**; the engine will generate all necessary Markdown files in memory.
5.  **Export Template**: In the "Local File System" section of the sidebar, click the **Folder Icon** to select an empty folder, then click **"Sync"**.
6.  The system will write all auto-generated configuration files to your folder, which you can then edit with VS Code.
 
 ---
 
 ## 📄 License
 
 This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** - see the [LICENSE](LICENSE) file for details.
