import { AppLocale } from './locale.interface';
import { EN_US_LOCALE } from './en';
import { ZH_TW_LOCALE } from './zh-tw';
import { ZH_CN_LOCALE } from './zh-cn';
import { JP_JP_LOCALE } from './jp';

export const LOCALES: Record<string, AppLocale> = {
    'English': EN_US_LOCALE,
    'Traditional Chinese': ZH_TW_LOCALE,
    'Simplified Chinese': ZH_CN_LOCALE,
    'Japanese': JP_JP_LOCALE,
    'default': ZH_TW_LOCALE // Default to Traditional Chinese as per existing system
};

export const getLocale = (lang: string | undefined): AppLocale => {
    if (!lang) return LOCALES['default'];
    return LOCALES[lang] || LOCALES['default'];
};
