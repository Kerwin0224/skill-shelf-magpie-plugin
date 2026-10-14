export { default as Button } from './ShelfButton';
import { desktopMessages } from './desktop-messages';

export const cn = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');
export const number = (value: number) => value.toLocaleString('zh-CN');
export const t = (key: string, values: Record<string, string | number> = {}) =>
  (desktopMessages[key] ?? key).replace(/\{([^}]+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
export const date = (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('zh-CN', options).format(new Date(value));
export const useI18n = () => ({ number, t, date });
