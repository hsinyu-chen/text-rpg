import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const JP_JP_LOCALE: AppLocale = {
    id: 'Japanese',
    responseSchema: {
        rootDescription: "思考プロセス：'analysis'フィールドを最初に完了させてから、'response'コンテンツを生成する必要があります。すべての出力は日本語でなければなりません。",
        responseDescription: "[応答フェーズ] 分析後の実際のストーリー内容とログが含まれます。すべてのフィールドは日本語でなければなりません。",
        analysis: `[分析フェーズ] 必須。ストーリーを生成する前に、原子アクション、成否判定、ランダムイベントを分析する必要があります。日本語で出力してください。意図が ${GAME_INTENTS.SYSTEM} または ${GAME_INTENTS.SAVE} の場合のみ空の "" にします。`,
        summary: `[要約] 必須。このターンの主要なプロットポイントのみを日本語で更新します。意図が ${GAME_INTENTS.SYSTEM} または ${GAME_INTENTS.SAVE} の場合のみ空の "" にします。重複を避けるために履歴を確認してください。`,
        inventory: "このターンのみのアイテム変更（取得/紛失/使用）を記述する文字列のリスト。日本語で記述してください。重複を避けるために履歴を確認してください。変更がない場合は [] を返します。",
        quest: "このターンのみの新しいクエストまたはプランの更新を記述する文字列のリスト。日本語で記述してください。重複を避けるために履歴を確認してください。変更がない場合は [] を返します。",
        world: "このターンのみの世界のイベント、勢力の動き、新しい場所、または技術/魔法の画期的な進歩を記述する文字列のリスト。日本語で記述してください。重複を避けるために履歴を確認してください。変更がない場合は [] を返します。"
    },
    adultDeclaration: "*親密さ、性行為、露出、または性的な暗示を含むすべてのシーンは、すべてのキャラクターが成人年齢（18歳以上、または現行法で定義されている年齢）に達しており、すべての行為が合意の上であることを意味します。この物語は純粋なフィクションであり、現実とは無関係です。*\n\n***\n\n",
    coreFilenames: {
        BASIC_SETTINGS: '1.Base_Settings.md',
        STORY_OUTLINE: '2.Story_Outline.md',
        CHARACTER_STATUS: '3.Character_Status.md',
        ASSETS: '4.Assets.md',
        TECH_EQUIPMENT: '5.Tech_Equipment.md',
        WORLD_FACTIONS: '6.Factions_and_World.md',
        MAGIC: '7.Magic.md',
        PLANS: '8.Plans.md',
        INVENTORY: '9.Inventory.md'
    },
    promptHoles: {
        LANGUAGE_RULE: "すべてのコンテンツを日本語で出力しなければなりません。生々しく描写豊かな日本語の文章を使用してください。"
    },
    sectionHeaders: {
        START_SCENE: '## Start Scene',
        INPUT_FORMAT: '## User Input Format'
    },
    intentLabels: {
        ACTION: 'アクション',
        FAST_FORWARD: '早送り',
        SYSTEM: 'システム',
        SAVE: 'セーブ',
        CONTINUE: '継続'
    },
    inputPlaceholders: {
        ACTION: '([心境]動作)台詞または内心の独白',
        FAST_FORWARD: '特定の時点またはイベントへ早送り',
        SYSTEM: 'システムコマンドまたは設定調整',
        SAVE: '現在のストーリー進行状況を保存',
        CONTINUE: 'ストーリーを続ける',
        FALLBACK: 'アクションを入力...'
    }
};
