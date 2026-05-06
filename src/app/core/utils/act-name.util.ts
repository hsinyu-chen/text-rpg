import { ChatMessage } from '../models/types';

/**
 * Pulls the most recent act/chapter name out of chat history for naming
 * save slots — scans backward for the latest model message containing
 * either `## Act.N` (English) or `第N章` (Traditional Chinese).
 */
export function extractActName(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'model' || !msg.content) continue;

        const actMatch = msg.content.match(/## Act\.(\d+)/i);
        if (actMatch) return `Act.${actMatch[1]} `;

        const zhMatch = msg.content.match(/第\s*(\d+)\s*章/);
        if (zhMatch) return `第${zhMatch[1]} 章`;
    }
    return null;
}
