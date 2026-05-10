import { VariantConfig } from './types';

export const config: VariantConfig = {
  base_dirs: {
    'zh-tw': 'prompts/source/base/zh-tw',
    en: 'prompts/source/base/en',
  },
  layer_dirs: {
    'cloud-overrides': 'prompts/source/layers/cloud-overrides',
    'local-overrides': 'prompts/source/layers/local-overrides',
  },
  variants: {
    'zh-tw/default': { base: 'zh-tw', layers: ['cloud-overrides'] },
    'zh-tw/local': { base: 'zh-tw', layers: ['local-overrides'] },
    'en/default': { base: 'en', layers: ['cloud-overrides'] },
    'en/local': { base: 'en', layers: ['local-overrides'] },
  },
  output_paths: {
    'zh-tw/default': 'public/assets/system_files/zh-tw',
    'zh-tw/local': 'public/assets/system_files/zh-tw/profiles/local',
    'en/default': 'public/assets/system_files/en',
    'en/local': 'public/assets/system_files/en/profiles/local',
  },
  per_file: {
    'injection_correction.md': { passthrough: true },
  },
};
